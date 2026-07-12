import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MICHAEL_BURRY_PROMPT_HINT } from "../src/server/sourceRegistry";

// Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
// Burry Substack, long-only bearish mapping): end-to-end /api/sync acceptance
// tests, mirroring the wiring patterns in tests/motleyFoolSource.test.ts
// (Gmail + registry fixtures, autoTrading + seeded positions for the SELL
// held/unheld check) and tests/symbolCooldown.test.ts (expiry via a raw store
// handle). Pure bearishMapping.ts unit tests live in
// tests/bearishMapping.test.ts instead of here.

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-burry-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
// Several tests in this file place multiple BUY/SELL pairs across a shared
// simulated day -- raise the daily trade cap so an earlier test's volume
// never spuriously RiskRejects a later one (same reasoning as
// exitPlanMonitoring.test.ts).
process.env.QUANTPACA_MAX_DAILY_TRADES = "100";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const registryPath = path.join(dataDir, "signal-sources.json");
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function writeRegistry(entries: unknown[]) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(entries));
}

const BURRY_REGISTRY_ENTRY = {
  id: "michael-burry",
  gmailQuery: "from:michaeljburry@substack.com",
  senderAllowlist: ["michaeljburry@substack.com"],
  trustTier: "medium",
  maxAgeHours: 96,
  enabled: true,
  promptHint: MICHAEL_BURRY_PROMPT_HINT,
};

type Fixture = { from: string; subject: string; body: string; internalDateMs: number };
let MESSAGES: Record<string, Fixture> = {};
let QUERY_TO_IDS: Record<string, string[]> = {};
let RESPONSES: Record<string, Record<string, unknown>> = {};
const anthropicPrompts: string[] = [];
const anthropicCallSymbols: string[] = [];

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
      anthropicPrompts.push(promptText);
      const symbols = Object.keys(RESPONSES);
      const matched = symbols.find((sym) => promptText.includes(sym));
      if (matched) anthropicCallSymbols.push(matched);
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

async function enableAutoTrading(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: true, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 5, targetProfitPercent: 15 },
    }),
  });
  assert.equal(res.status, 200);
}

const dbJsonPath = path.join(dataDir, "db.json");

// The automated BUY path (unconfigured/simulated broker, see server.ts's
// executeTradeIntent price-lookup) only ever resolves a price for a symbol
// that already has a simulated-portfolio position entry (pattern documented
// in tests/buyCapPerCycle.test.ts, which configures a real broker fixture
// instead). Rather than standing up a full Alpaca fixture, this injects a
// qty:0 "ghost" position directly into the simulated portfolio -- it
// supplies `current_price` for the price lookup while `qty 0` means it is
// never treated as a held position (this file's bearish-mapping symbolHeld
// check, and the pre-existing SELL branch's `qty > 0` guard, are both
// unaffected). Requires db.json to already exist (call after at least one
// prior request in the test, e.g. enableAutoTrading).
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

async function seedPosition(port: number, symbol: string, qty: number, price: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ symbol, qty, side: "buy", price }),
  });
  const body = await res.json();
  assert.equal(body.trade.status, "Accepted", `expected seed buy to be accepted, got: ${JSON.stringify(body)}`);
}

function resetFixtures() {
  MESSAGES = {};
  QUERY_TO_IDS = {};
  RESPONSES = {};
  anthropicPrompts.length = 0;
  anthropicCallSymbols.length = 0;
}

function shortThoughtsBody(symbol: string): string {
  return `Short Thoughts: ${symbol}

We've built a substantial short position in ${symbol}. The balance sheet is far weaker than the market assumes, and management's own commentary confirms the deterioration we flagged months ago. This is not a temporary air pocket -- the fundamental case for owning ${symbol} has broken.

We are not disclosing position size, per usual.`;
}

function tradingPostBody(symbol: string): string {
  return `Trading Post: ${symbol}

Adding to our position in ${symbol} today. The setup here is exactly the kind of dislocation we look for -- undervalued assets, a catalyst on the horizon, and a market that hasn't caught on yet.`;
}

let uniq = 0;
function nextMsgId(): string {
  uniq += 1;
  return `burry-${uniq}`;
}

test("acceptance: Short Thoughts (bearish, whipsaw-verified reversal) on a HELD symbol invalidates the thesis and executes an exit with thesis_invalidation reasoning", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  await seedPosition(port, "BURNH", 10, 40);

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const msgId = nextMsgId();
  MESSAGES = { [msgId]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Short Thoughts NVDA", body: shortThoughtsBody("BURNH"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [msgId] };
  RESPONSES = {
    BURNH: {
      symbol: "BURNH",
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Balance sheet deterioration confirmed; the long thesis no longer holds.",
      whipsawCheck: "This is a verified fundamental breakdown, not a volatility shakeout.",
      whipsawVerdict: "reversal",
      stance: "bearish",
      decision: "SELL",
    },
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "BURNH");
  assert.ok(analysis, "expected a BURNH analysis to be recorded");
  assert.equal(analysis.decision, "SELL");
  assert.equal(analysis.stance, "bearish");

  const store = createProductionStore(sqlitePath);
  const invalidated = store.listActiveThesisInvalidatedSymbols(new Date().toISOString());
  store.close();
  assert.ok(invalidated.includes("BURNH"), `expected a thesis_invalidations record for BURNH, active symbols: ${JSON.stringify(invalidated)}`);

  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`);
  const trades = await tradesRes.json();
  const exitTrade = trades.find((tr: any) => tr.symbol === "BURNH" && tr.side === "sell");
  assert.ok(exitTrade, `expected a real sell trade closing BURNH, got: ${JSON.stringify(trades)}`);
  assert.match(exitTrade.reasoning, /thesis_invalidation/, `expected thesis_invalidation reasoning, got: ${exitTrade.reasoning}`);
});

test("acceptance: the same Short Thoughts fixture on an UNHELD symbol adds it to the do-not-buy list; a later BUY signal for it is rejected with the audited reason", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  // Deliberately no seedPosition -- BURNU is never held.

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const msgId = nextMsgId();
  MESSAGES = { [msgId]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Short Thoughts NVDA", body: shortThoughtsBody("BURNU"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [msgId] };
  RESPONSES = {
    BURNU: {
      symbol: "BURNU",
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Balance sheet deterioration confirmed.",
      whipsawCheck: "Verified fundamental breakdown, not a shakeout.",
      whipsawVerdict: "reversal",
      stance: "bearish",
      decision: "SELL",
    },
  };

  const firstSync = await runSync(port);
  const analysis = firstSync.analyses.find((a: any) => a.symbol === "BURNU");
  assert.ok(analysis, "the SELL decision must still be recorded honestly even though no position exists to close");
  assert.equal(analysis.decision, "SELL", "an unheld symbol must not silently mutate the recorded decision -- it's a no-op at the trade-execution step, not upstream");

  const tradesAfterFirst = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  assert.equal(
    tradesAfterFirst.some((tr: any) => tr.symbol === "BURNU"),
    false,
    "no trade of any kind should exist for a symbol never held and never bought -- long-only, never a short",
  );

  const doNotBuyRes = await fetch(`http://127.0.0.1:${port}/api/do-not-buy`);
  assert.equal(doNotBuyRes.status, 200);
  const doNotBuyList = await doNotBuyRes.json();
  const entry = doNotBuyList.find((e: any) => e.symbol === "BURNU");
  assert.ok(entry, `expected a do-not-buy entry for BURNU, got: ${JSON.stringify(doNotBuyList)}`);
  assert.equal(entry.sourceId, "michael-burry");

  // A later, distinct BUY signal for the same symbol must be rejected before
  // it ever reaches sizing. Needs a resolvable price to even reach the BUY
  // branch -- see injectPricedGhostPosition's doc comment.
  injectPricedGhostPosition("BURNU", 25);
  const msgId2 = nextMsgId();
  MESSAGES[msgId2] = { from: "Michael Burry <michaeljburry@substack.com>", subject: "Trading Post BURNU (re-add)", body: tradingPostBody("BURNU"), internalDateMs: Date.now() - 500 };
  QUERY_TO_IDS["from:michaeljburry@substack.com"] = [msgId2];
  RESPONSES.BURNU = {
    symbol: "BURNU",
    growthScore: 90,
    sentimentScore: 80,
    riskProfile: "Medium",
    reasoning: "Reversing course -- a fresh buy thesis.",
    whipsawCheck: "n/a",
    whipsawVerdict: "unclear",
    stance: "bullish",
    decision: "BUY",
  };

  const secondSync = await runSync(port);
  const tradesAfterSecond = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  assert.equal(tradesAfterSecond.some((tr: any) => tr.symbol === "BURNU"), false, "the BUY must be rejected before any order is submitted");

  const logMessages: string[] = secondSync.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /BURNU/.test(m) && /do-not-buy/i.test(m) && /michael-burry/i.test(m)),
    `expected a rejection log naming BURNU, do-not-buy, and the source, got: ${JSON.stringify(logMessages)}`,
  );
});

test("whipsaw-downgraded bearish SELL on a HELD symbol does NOT invalidate the thesis and does not force an exit", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  await seedPosition(port, "BURNW", 10, 40);

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const msgId = nextMsgId();
  MESSAGES = { [msgId]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Short Thoughts NVDA", body: shortThoughtsBody("BURNW"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [msgId] };
  RESPONSES = {
    BURNW: {
      symbol: "BURNW",
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "A possible near-term shakeout, unclear if fundamentals broke.",
      whipsawCheck: "This looks like a temporary shakeout, not a verified reversal.",
      whipsawVerdict: "whipsaw", // downgrades SELL -> HOLD
      stance: "bearish",
      decision: "SELL",
    },
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "BURNW");
  assert.ok(analysis, "expected a BURNW analysis to be recorded");
  assert.equal(analysis.decision, "HOLD", "the whipsaw gate downgrades this SELL to HOLD");

  const store = createProductionStore(sqlitePath);
  const invalidated = store.listActiveThesisInvalidatedSymbols(new Date().toISOString());
  store.close();
  assert.ok(!invalidated.includes("BURNW"), "a whipsaw-downgraded SELL on a held symbol must NOT invalidate the thesis");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  assert.equal(trades.some((tr: any) => tr.symbol === "BURNW" && tr.side === "sell"), false, "no exit should be forced when the whipsaw gate downgraded the SELL");
});

test("whipsaw-downgraded bearish SELL on an UNHELD symbol still adds it to do-not-buy -- avoiding a buy is cheap", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const msgId = nextMsgId();
  MESSAGES = { [msgId]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Short Thoughts NVDA", body: shortThoughtsBody("BURNX"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [msgId] };
  RESPONSES = {
    BURNX: {
      symbol: "BURNX",
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Possible shakeout, not verified.",
      whipsawCheck: "Looks like a temporary shakeout.",
      whipsawVerdict: "whipsaw",
      stance: "bearish",
      decision: "SELL",
    },
  };

  await runSync(port);

  const doNotBuyRes = await fetch(`http://127.0.0.1:${port}/api/do-not-buy`);
  const doNotBuyList = await doNotBuyRes.json();
  assert.ok(doNotBuyList.some((e: any) => e.symbol === "BURNX"), `expected BURNX on the do-not-buy list even though the whipsaw gate downgraded the SELL, got: ${JSON.stringify(doNotBuyList)}`);
});

test("expiry: an unexpired do-not-buy entry blocks a BUY; an expired one does not", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  // Needs a resolvable price to even reach the BUY branch -- see
  // injectPricedGhostPosition's doc comment.
  injectPricedGhostPosition("BURNBLOCK", 30);
  injectPricedGhostPosition("BURNSTALE", 30);

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveDoNotBuy({ symbol: "BURNBLOCK", sourceId: "michael-burry", reason: "test: unexpired", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  rawStore.saveDoNotBuy({ symbol: "BURNSTALE", sourceId: "michael-burry", reason: "test: pre-expired", expiresAt: new Date(Date.now() - 60_000).toISOString() });
  rawStore.close();

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const blockedMsg = nextMsgId();
  const staleMsg = nextMsgId();
  MESSAGES = {
    [blockedMsg]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Trading Post BURNBLOCK", body: tradingPostBody("BURNBLOCK"), internalDateMs: Date.now() - 2000 },
    [staleMsg]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Trading Post BURNSTALE", body: tradingPostBody("BURNSTALE"), internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [blockedMsg, staleMsg] };
  RESPONSES = {
    BURNBLOCK: { symbol: "BURNBLOCK", growthScore: 90, sentimentScore: 80, riskProfile: "Medium", reasoning: "Fresh buy thesis.", whipsawCheck: "n/a", whipsawVerdict: "unclear", stance: "bullish", decision: "BUY" },
    BURNSTALE: { symbol: "BURNSTALE", growthScore: 90, sentimentScore: 80, riskProfile: "Medium", reasoning: "Fresh buy thesis.", whipsawCheck: "n/a", whipsawVerdict: "unclear", stance: "bullish", decision: "BUY" },
  };

  const sync = await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();

  assert.equal(trades.some((tr: any) => tr.symbol === "BURNBLOCK"), false, "the unexpired do-not-buy entry must block this BUY");
  assert.ok(trades.some((tr: any) => tr.symbol === "BURNSTALE" && tr.side === "buy"), `the expired do-not-buy entry must not block this BUY, trades: ${JSON.stringify(trades)}`);

  const logMessages: string[] = sync.logs.map((l: any) => l.message);
  assert.ok(logMessages.some((m) => /BURNBLOCK/.test(m) && /do-not-buy/i.test(m)));
});

test("BUY + bearish stance contradiction is forced to NONE with a loud log, and no trade is submitted", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const msgId = nextMsgId();
  MESSAGES = { [msgId]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Malformed contradiction fixture", body: tradingPostBody("BURNCX"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [msgId] };
  RESPONSES = {
    BURNCX: {
      symbol: "BURNCX",
      growthScore: 90,
      sentimentScore: 80,
      riskProfile: "Medium",
      reasoning: "Model contradiction fixture.",
      whipsawCheck: "n/a",
      whipsawVerdict: "unclear",
      stance: "bearish", // deliberately contradicts decision BUY below
      decision: "BUY",
    },
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "BURNCX");
  assert.ok(analysis, "expected a BURNCX analysis to be recorded");
  assert.equal(analysis.decision, "NONE", "a BUY+bearish contradiction must be forced to NONE, defensively -- this system never opens shorts");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  assert.equal(trades.some((tr: any) => tr.symbol === "BURNCX"), false, "no trade should be submitted for a contradiction");

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /BURNCX/.test(m) && /(contradiction|bearish)/i.test(m) && /BUY/i.test(m)),
    `expected a loud contradiction log naming BURNCX, got: ${JSON.stringify(logMessages)}`,
  );
});

test("stance defensive parse: an invalid/unrecognized stance value never triggers the bearish-mapping layer -- the ordinary SELL path still executes normally", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  await seedPosition(port, "BURNP", 10, 40);

  writeRegistry([BURRY_REGISTRY_ENTRY]);
  const msgId = nextMsgId();
  MESSAGES = { [msgId]: { from: "Michael Burry <michaeljburry@substack.com>", subject: "Short Thoughts NVDA", body: shortThoughtsBody("BURNP"), internalDateMs: Date.now() - 1000 } };
  QUERY_TO_IDS = { "from:michaeljburry@substack.com": [msgId] };
  RESPONSES = {
    BURNP: {
      symbol: "BURNP",
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Balance sheet deterioration.",
      whipsawCheck: "Verified fundamental breakdown.",
      whipsawVerdict: "reversal",
      stance: "short", // not one of the three valid enum values -- fails closed to "neutral"
      decision: "SELL",
    },
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "BURNP");
  assert.ok(analysis);
  assert.equal(analysis.decision, "SELL");
  assert.equal(analysis.stance, "neutral", "an invalid stance value must fail closed to neutral in the persisted analysis");

  const store = createProductionStore(sqlitePath);
  const invalidated = store.listActiveThesisInvalidatedSymbols(new Date().toISOString());
  store.close();
  assert.ok(!invalidated.includes("BURNP"), "neutral stance must never invalidate a thesis");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json();
  const exitTrade = trades.find((tr: any) => tr.symbol === "BURNP" && tr.side === "sell");
  assert.ok(exitTrade, "the ordinary (non-bearish-mapped) SELL decision path must still execute the exit");
  assert.ok(!/thesis_invalidation/.test(exitTrade.reasoning), "reasoning must not claim thesis_invalidation when stance failed closed to neutral");
});

test("registry default: a fresh registry ships michael-burry disabled -- no Gmail query is issued for it", async (t) => {
  resetFixtures();
  if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);

  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await runSync(port);

  assert.ok(fs.existsSync(registryPath));
  const onDisk = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  const burry = onDisk.find((s: any) => s.id === "michael-burry");
  assert.ok(burry, "expected the default registry to ship a michael-burry entry");
  assert.equal(burry.enabled, false);
});
