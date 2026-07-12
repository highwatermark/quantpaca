import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, "Cross-source confirmation
// bonus"): end-to-end /api/sync acceptance tests, mirroring the wiring
// patterns in tests/michaelBurrySource.test.ts (Gmail + registry fixtures,
// autoTrading + seeded positions) and tests/whipsawGateIntegration.test.ts
// (persisted reviewed-signal confidence assertions). Pure evaluateCrossSource
// unit tests live in tests/crossSourceConfirmation.test.ts instead of here.

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-cross-source-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
// Disable the (unrelated) per-symbol cooldown entirely: without this, the
// conflict test's earlier SELL reaching the broker would put its symbol into
// cooldown, and the later BUY's risk decision would land
// requires_human_approval for THAT reason instead of the cross-source
// conflict this test is about, making the reason-text assertion ambiguous.
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";
process.env.QUANTPACA_MAX_DAILY_TRADES = "100";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const registryPath = path.join(dataDir, "signal-sources.json");
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");
const dbJsonPath = path.join(dataDir, "db.json");

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function writeRegistry(entries: unknown[]) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(entries));
}

const CS_SOURCE_A = {
  id: "cs-source-a",
  gmailQuery: "from:source-a@cross-source-test.example",
  senderAllowlist: ["source-a@cross-source-test.example"],
  trustTier: "medium",
  maxAgeHours: 96,
  enabled: true,
};

const CS_SOURCE_B = {
  id: "cs-source-b",
  gmailQuery: "from:source-b@cross-source-test.example",
  senderAllowlist: ["source-b@cross-source-test.example"],
  trustTier: "medium",
  maxAgeHours: 96,
  enabled: true,
};

type Fixture = { from: string; subject: string; body: string; internalDateMs: number };
let MESSAGES: Record<string, Fixture> = {};
let QUERY_TO_IDS: Record<string, string[]> = {};
let RESPONSES: Record<string, Record<string, unknown>> = {};

function gmailMessageFixture(id: string) {
  const f = MESSAGES[id];
  return {
    id,
    internalDate: String(f.internalDateMs),
    snippet: f.body.slice(0, 100),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: f.subject },
        { name: "From", value: f.from },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64url(f.body) } }],
    },
  };
}

function fixtureMessageResponse(content: Array<{ type: "text"; text: string }>) {
  return new Response(
    JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-4-8",
      content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    if (body.output_config) {
      const promptText: string = body.messages?.[0]?.content ?? "";
      const symbols = Object.keys(RESPONSES);
      const matched = symbols.find((sym) => promptText.includes(sym));
      const fixture = matched
        ? RESPONSES[matched]
        : { symbol: "UNKNOWN", growthScore: 0, sentimentScore: 0, riskProfile: "Low", reasoning: "n/a", whipsawCheck: "n/a", whipsawVerdict: "unclear", stance: "neutral", decision: "NONE" };
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(fixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    if (url.includes("/messages?")) {
      const q = new URL(url).searchParams.get("q") || "";
      const ids = QUERY_TO_IDS[q] || [];
      return new Response(JSON.stringify({ messages: ids.map((id) => ({ id })) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const match = url.match(/\/messages\/([^?]+)\?/);
    const id = match?.[1];
    if (id && MESSAGES[id]) {
      return new Response(JSON.stringify(gmailMessageFixture(id)), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unhandled gmail path in test fixture", { status: 404 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN, Authorization: "Bearer test-oauth-token" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body;
}

async function setAutoTrading(port: number, enabled: boolean) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: enabled, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 5, targetProfitPercent: 15 },
    }),
  });
  assert.equal(res.status, 200);
}

async function seedPosition(port: number, symbol: string, qty: number, price: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ symbol, qty, side: "buy", price }),
  });
  const body = await res.json();
  assert.equal(body.trade.status, "Accepted", `expected seed buy to be accepted, got: ${JSON.stringify(body)}`);
}

// See tests/michaelBurrySource.test.ts's injectPricedGhostPosition for the
// full rationale: the automated BUY path only resolves a price for a symbol
// that already has a simulated-portfolio position entry; qty 0 supplies
// current_price for the lookup without being treated as an existing holding.
function injectPricedGhostPosition(symbol: string, price: number) {
  const db = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
  db.simulatedPortfolio = db.simulatedPortfolio || { positions: [], cash: "100000", long_market_value: "0" };
  db.simulatedPortfolio.positions = db.simulatedPortfolio.positions || [];
  db.simulatedPortfolio.positions.push({
    symbol,
    qty: "0",
    market_value: "0",
    cost_basis: "0",
    unrealized_pl: "0.00",
    unrealized_plpc: "0.0000",
    current_price: String(price),
    avg_entry_price: String(price),
  });
  fs.writeFileSync(dbJsonPath, JSON.stringify(db, null, 2), "utf8");
}

function resetFixtures() {
  MESSAGES = {};
  QUERY_TO_IDS = {};
  RESPONSES = {};
}

let uniq = 0;
function nextMsgId(): string {
  uniq += 1;
  return `cs-${uniq}`;
}

function bullishBody(symbol: string): string {
  return `Adding to our position in ${symbol} today. Fundamentals are accelerating and the setup looks strong.`;
}

function bearishBody(symbol: string): string {
  return `We are exiting ${symbol}. The balance sheet has deteriorated and management's own commentary confirms it -- the long thesis no longer holds.`;
}

test("acceptance: two enabled sources both bullish on the same symbol within 72h -- the second signal's confidence is boosted, and crossSource is recorded on both", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  writeRegistry([CS_SOURCE_A, CS_SOURCE_B]);
  const msgA = nextMsgId();
  const msgB = nextMsgId();
  MESSAGES = {
    [msgA]: { from: "Source A <source-a@cross-source-test.example>", subject: "Bullish take", body: bullishBody("XBOOST"), internalDateMs: Date.now() - 2000 },
    [msgB]: { from: "Source B <source-b@cross-source-test.example>", subject: "Bullish take", body: bullishBody("XBOOST"), internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = {
    "from:source-a@cross-source-test.example": [msgA],
    "from:source-b@cross-source-test.example": [msgB],
  };
  // growthScore 80 + sentimentScore 80 -> raw confidence round((80+80)/2) = 80;
  // whipsawVerdict "whipsaw" keeps a BUY at full confidence (no haircut), so
  // the first source's persisted confidenceScore is exactly 80, and the
  // second's is the bounded x1.2 boost: 96.
  RESPONSES = {
    XBOOST: {
      symbol: "XBOOST",
      growthScore: 80,
      sentimentScore: 80,
      riskProfile: "Medium",
      reasoning: "Fundamentals accelerating.",
      whipsawCheck: "n/a",
      whipsawVerdict: "whipsaw",
      stance: "bullish",
      decision: "BUY",
    },
  };

  const body = await runSync(port);
  const analyses = body.analyses.filter((a: any) => a.symbol === "XBOOST");
  assert.equal(analyses.length, 2, `expected two separate analyses (one per source), got: ${JSON.stringify(body.analyses)}`);

  const reviewedRes = await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`);
  const reviewed = await reviewedRes.json();
  const signals = reviewed.filter((s: any) => s.symbol === "XBOOST").sort((a: any, b: any) => a.sourceTimestamp.localeCompare(b.sourceTimestamp));
  assert.equal(signals.length, 2, `expected two persisted reviewed signals, got: ${JSON.stringify(signals)}`);

  const [first, second] = signals;
  assert.equal(first.source, "cs-source-a");
  assert.equal(first.confidenceScore, 80, "the first signal has no corroborating source yet -- unboosted");
  assert.deepEqual(first.crossSource, { effect: "none" }, "the applied effect must be recorded even when it is 'none'");

  assert.equal(second.source, "cs-source-b");
  assert.equal(second.confidenceScore, 96, "the second signal's confidence must carry the bounded x1.2 boost from the first (agreeing, other-source) signal");
  assert.deepEqual(second.crossSource, { effect: "boost", multiplier: 1.2 });

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /XBOOST/.test(m) && /cross-source/i.test(m) && /boost/i.test(m)),
    `expected a sync log entry documenting the boost, got: ${JSON.stringify(logMessages)}`,
  );
});

test("acceptance: a bullish BUY that conflicts with an earlier bearish signal from another source lands requires_human_approval, while the earlier signal's thesis-invalidation record is unaffected", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  await seedPosition(port, "XCONFLICT", 10, 40);

  // Cycle 1: source A's bearish, whipsaw-verified-reversal SELL on the HELD
  // symbol -- this both invalidates the thesis (Task 10 machinery) and
  // executes a real exit, closing the position.
  writeRegistry([CS_SOURCE_A, CS_SOURCE_B]);
  const bearMsg = nextMsgId();
  MESSAGES = { [bearMsg]: { from: "Source A <source-a@cross-source-test.example>", subject: "Exiting", body: bearishBody("XCONFLICT"), internalDateMs: Date.now() - 3000 } };
  QUERY_TO_IDS = { "from:source-a@cross-source-test.example": [bearMsg] };
  RESPONSES = {
    XCONFLICT: {
      symbol: "XCONFLICT",
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Balance sheet deterioration confirmed; the long thesis no longer holds.",
      whipsawCheck: "Verified fundamental breakdown, not a shakeout.",
      whipsawVerdict: "reversal",
      stance: "bearish",
      decision: "SELL",
    },
  };

  const firstSync = await runSync(port);
  const bearAnalysis = firstSync.analyses.find((a: any) => a.symbol === "XCONFLICT");
  assert.ok(bearAnalysis, "expected the bearish analysis to be recorded");
  assert.equal(bearAnalysis.decision, "SELL");

  const storeAfterFirst = createProductionStore(sqlitePath);
  const invalidatedAfterFirst = storeAfterFirst.listActiveThesisInvalidatedSymbols(new Date().toISOString());
  storeAfterFirst.close();
  assert.ok(invalidatedAfterFirst.includes("XCONFLICT"), "expected the bearish SELL to invalidate the thesis (Task 10)");

  const tradesAfterFirst = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  const exitTrade = tradesAfterFirst.find((tr: any) => tr.symbol === "XCONFLICT" && tr.side === "sell");
  assert.ok(exitTrade, "expected the bearish signal's own thesis-invalidation exit to have executed normally");
  assert.match(exitTrade.reasoning, /thesis_invalidation/);

  // Cycle 2: source B's bullish BUY for the SAME symbol, within the 72h
  // window. Source A's bearish signal is still persisted and recent, so this
  // must conflict.
  const bullMsg = nextMsgId();
  MESSAGES = { [bullMsg]: { from: "Source B <source-b@cross-source-test.example>", subject: "Reversal", body: bullishBody("XCONFLICT"), internalDateMs: Date.now() - 500 } };
  QUERY_TO_IDS = { "from:source-b@cross-source-test.example": [bullMsg] };
  RESPONSES = {
    XCONFLICT: {
      symbol: "XCONFLICT",
      growthScore: 90,
      sentimentScore: 80,
      riskProfile: "Medium",
      reasoning: "Fresh bullish thesis.",
      whipsawCheck: "n/a",
      whipsawVerdict: "whipsaw",
      stance: "bullish",
      decision: "BUY",
    },
  };
  // The position was fully closed by the exit above -- a resolvable price for
  // the BUY branch needs a simulated-portfolio entry again.
  injectPricedGhostPosition("XCONFLICT", 25);

  const secondSync = await runSync(port);
  const bullAnalysis = secondSync.analyses.find((a: any) => a.symbol === "XCONFLICT");
  assert.ok(bullAnalysis, "expected the bullish analysis to be recorded");
  assert.equal(bullAnalysis.decision, "BUY");

  const reviewedRes = await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`);
  const reviewed = await reviewedRes.json();
  const bullSignal = reviewed.find((s: any) => s.symbol === "XCONFLICT" && s.source === "cs-source-b");
  assert.ok(bullSignal, "expected a persisted reviewed signal for the bullish source");
  assert.deepEqual(bullSignal.crossSource, { effect: "conflict" }, "the applied conflict effect must be recorded on the persisted signal");

  const tradesAfterSecond = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  const buyAttempt = tradesAfterSecond.find((tr: any) => tr.symbol === "XCONFLICT" && tr.side === "buy");
  assert.ok(buyAttempt, `expected a BUY trade attempt for XCONFLICT, got: ${JSON.stringify(tradesAfterSecond)}`);
  assert.equal(buyAttempt.status, "RiskRejected", "a conflicting BUY must never auto-resolve to an executed order");
  assert.equal(buyAttempt.riskDecision?.status, "requires_human_approval");
  assert.match(buyAttempt.riskDecision?.reason || "", /cross-source|conflict/i);

  // Task 10's own record, from the FIRST cycle, must still be untouched by
  // this second cycle's conflict.
  const storeAfterSecond = createProductionStore(sqlitePath);
  const invalidatedAfterSecond = storeAfterSecond.listActiveThesisInvalidatedSymbols(new Date().toISOString());
  storeAfterSecond.close();
  assert.ok(invalidatedAfterSecond.includes("XCONFLICT"), "the earlier thesis-invalidation record must remain unaffected by the later conflict");

  const logMessages: string[] = secondSync.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /XCONFLICT/.test(m) && /cross-source/i.test(m) && /conflict/i.test(m)),
    `expected a sync log entry documenting the conflict, got: ${JSON.stringify(logMessages)}`,
  );
});

test("a single enabled source with no corroboration never boosts or conflicts -- confidence is unchanged and crossSource is 'none'", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  writeRegistry([CS_SOURCE_A]);
  const msg = nextMsgId();
  MESSAGES = { [msg]: { from: "Source A <source-a@cross-source-test.example>", subject: "Solo bullish take", body: bullishBody("XSOLO"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:source-a@cross-source-test.example": [msg] };
  RESPONSES = {
    XSOLO: {
      symbol: "XSOLO",
      growthScore: 60,
      sentimentScore: 60,
      riskProfile: "Medium",
      reasoning: "Solo bullish thesis.",
      whipsawCheck: "n/a",
      whipsawVerdict: "whipsaw",
      stance: "bullish",
      decision: "BUY",
    },
  };

  await runSync(port);
  const reviewed = await (await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`)).json();
  const signal = reviewed.find((s: any) => s.symbol === "XSOLO");
  assert.ok(signal);
  assert.equal(signal.confidenceScore, 60, "raw confidence round((60+60)/2) = 60, unboosted");
  assert.deepEqual(signal.crossSource, { effect: "none" });
});
