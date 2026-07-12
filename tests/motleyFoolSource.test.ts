import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MOTLEY_FOOL_PROMPT_HINT } from "../src/server/sourceRegistry";

// Phase 2 Task 9 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 1 -- Motley Fool
// premium): end-to-end /api/sync acceptance tests for the Fool source,
// mirroring the wiring patterns in tests/signalSourceRegistryIngestion.test.ts
// (Gmail + registry fixtures) and tests/whipsawGateIntegration.test.ts
// (autoTrading + seeded positions for the SELL held/unheld check). Pure
// registry/senderPolicy unit tests live in sourceRegistry.test.ts and
// senderPolicy.test.ts instead of here.

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-motley-fool-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const registryPath = path.join(dataDir, "signal-sources.json");

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function writeRegistry(entries: unknown[]) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(entries));
}

type Fixture = { from: string; subject: string; body: string; internalDateMs: number };
let MESSAGES: Record<string, Fixture> = {};
// exact gmailQuery string -> ordered list of message ids that query returns
let QUERY_TO_IDS: Record<string, string[]> = {};
// ticker substring -> scripted Claude structured-analysis fixture for that
// symbol; matched against the prompt text exactly like
// signalSourceRegistryIngestion.test.ts does, so the unconditional YouTube-
// sentiment analysis call (no ticker match) safely resolves to UNKNOWN/NONE
// and never pollutes an email-derived assertion.
let RESPONSES: Record<string, Record<string, unknown>> = {};
const anthropicPrompts: string[] = [];
const anthropicCallSymbols: string[] = [];
const gmailListCalls: string[] = [];

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
        : { symbol: "UNKNOWN", growthScore: 0, sentimentScore: 0, riskProfile: "Low", reasoning: "n/a", whipsawCheck: "n/a", whipsawVerdict: "unclear", decision: "NONE" };
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(fixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    if (url.includes("/messages?")) {
      gmailListCalls.push(url);
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

async function getReviewedSignals(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`);
  assert.equal(res.status, 200);
  return res.json();
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
  gmailListCalls.length = 0;
  anthropicPrompts.length = 0;
  anthropicCallSymbols.length = 0;
}

const FOOL_RECOMMENDATION_BODY = `Fellow Fool,

We're adding a brand-new position to Epic Portfolio today: Acme Cloud Holdings (NASDAQ: ACME).

Acme's expanding cloud infrastructure business, disciplined capital allocation, and founder-led management make this a name we want in the portfolio for the next five years. We are initiating coverage with a BUY recommendation today at current prices.

As always, size this new position no larger than 3-5% of your overall portfolio, and remember our philosophy of buying great businesses and holding for the long term through volatility.

Fool on!
The Motley Fool Epic Portfolio Team`;

const PREMIUMINFO_TEASER_BODY = `Hi there,

Did you know members who upgraded to Epic Portfolio last year saw incredible returns? Now is the perfect time to unlock our top stock picks before prices go up again.

Click here to upgrade your membership today and get instant access to all of our premium research, model portfolios, and exclusive stock recommendations before anyone else.

This special offer expires soon -- don't wait!`;

function foolSellBody(symbol: string): string {
  return `Fellow Fool,

It's time to part ways with ${symbol}. We are issuing a SELL recommendation on ${symbol} today for Rule Breakers members -- the original growth thesis has broken down and we no longer see a path back to our original price target.

Please close your position in ${symbol} at your earliest convenience.

Fool on!
The Motley Fool Rule Breakers Team`;
}

test("acceptance: a Fool recommendation email produces a structured signal with source \"motley-fool\", trustTier \"high\", and the analysis prompt carries the promptHint", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  writeRegistry([
    {
      id: "motley-fool",
      gmailQuery: "from:fool@motley.fool.com",
      senderAllowlist: ["fool@motley.fool.com"],
      trustTier: "high",
      maxAgeHours: 96,
      enabled: true,
      promptHint: MOTLEY_FOOL_PROMPT_HINT,
    },
  ]);

  MESSAGES = {
    rec1: {
      from: "The Motley Fool <fool@motley.fool.com>",
      subject: "New Stock Recommendation: Epic Portfolio",
      body: FOOL_RECOMMENDATION_BODY,
      internalDateMs: Date.now() - 60 * 60 * 1000,
    },
  };
  QUERY_TO_IDS = { "from:fool@motley.fool.com": ["rec1"] };
  RESPONSES = {
    ACME: {
      symbol: "ACME",
      growthScore: 85,
      sentimentScore: 70,
      riskProfile: "Medium",
      reasoning: "New Epic Portfolio BUY recommendation with a disciplined long-term thesis.",
      whipsawCheck: "No pullback discussed; this is a fresh initiation, not a reaction to a dip.",
      whipsawVerdict: "unclear",
      decision: "BUY",
    },
  };

  const body = await runSync(port);

  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].symbol, "ACME");
  assert.deepEqual(anthropicCallSymbols, ["ACME"]);

  const reviewed = await getReviewedSignals(port);
  const signal = reviewed.find((s: any) => s.symbol === "ACME");
  assert.ok(signal, "expected a reviewed signal for ACME");
  assert.equal(signal.source, "motley-fool");
  assert.equal(signal.trustTier, "high");

  const acmePrompt = anthropicPrompts.find((p) => p.includes("ACME"));
  assert.ok(acmePrompt, "expected an analysis prompt referencing the ACME email");
  assert.match(acmePrompt!, /PRIMARY recommendation/);
  assert.match(acmePrompt!, /Hidden Gems/);
  assert.match(acmePrompt!, /Rule Breakers/);
});

test("acceptance: a premiuminfo teaser matched by a broadened query produces zero signals, zero Claude analysis calls for it, and a blocklisted-sender log", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // A deliberately broadened query (as an operator might write to catch every
  // fool.com sender) that happens to also match the premiuminfo marketing
  // sender -- it must never reach Claude regardless of the query's reach.
  writeRegistry([
    { id: "broadfool", gmailQuery: "from:(fool.com)", senderAllowlist: ["fool@motley.fool.com"], trustTier: "high", maxAgeHours: 96, enabled: true },
  ]);

  // Distinct message ids and a distinct symbol from the previous test --
  // this app/db is shared across tests in this file (module-level, like
  // signalSourceRegistryIngestion.test.ts), so reusing a symbol or Gmail
  // message id here would collide with the prior test's persisted signal
  // (dedup keys on source + message id + body hash).
  const now = Date.now();
  MESSAGES = {
    "rec-broad": { from: "The Motley Fool <fool@motley.fool.com>", subject: "New Stock Recommendation: Epic Portfolio", body: FOOL_RECOMMENDATION_BODY.replace("ACME", "BACME"), internalDateMs: now - 1000 },
    "teaser-broad": { from: "The Motley Fool <fool@premiuminfo.fool.com>", subject: "Don't miss this: Upgrade to Epic Portfolio today!", body: PREMIUMINFO_TEASER_BODY, internalDateMs: now - 1000 },
  };
  QUERY_TO_IDS = { "from:(fool.com)": ["rec-broad", "teaser-broad"] };
  RESPONSES = {
    BACME: {
      symbol: "BACME", growthScore: 80, sentimentScore: 60, riskProfile: "Medium",
      reasoning: "Legit recommendation.", whipsawCheck: "n/a", whipsawVerdict: "unclear", decision: "BUY",
    },
  };

  const body = await runSync(port);

  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].symbol, "BACME");
  assert.deepEqual(anthropicCallSymbols, ["BACME"], "the blocklisted teaser must never reach a Claude analysis call");
  assert.ok(
    !anthropicPrompts.some((p) => p.includes("Click here to upgrade")),
    "the premiuminfo teaser's own body text must never appear in any analysis prompt",
  );

  const reviewed = await getReviewedSignals(port);
  assert.ok(reviewed.some((s: any) => s.symbol === "BACME"), "expected the legit message's signal to be recorded");
  assert.equal(reviewed.filter((s: any) => s.source === "broadfool").length, 1, "the blocklisted teaser must produce zero reviewed signals of its own -- only the legit message's signal exists");

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /blocklisted sender/i.test(m) && /premiuminfo/i.test(m)),
    `expected a blocklisted-sender log naming the premiuminfo address, got: ${JSON.stringify(logMessages)}`,
  );
});

test("registry migration end-to-end: an existing registry file missing motley-fool gets it appended, disabled, with a sync log line, and it is not queried this cycle", async (t) => {
  resetFixtures();
  writeRegistry([
    { id: "ziptrader", gmailQuery: "from:charlie-from-ziptrader@ghost.io", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
  ]);

  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  MESSAGES = {
    z1: { from: "Charlie <charlie-from-ziptrader@ghost.io>", subject: "ZipTrader thesis", body: "Thesis body: fundamentals accelerating, whipsaw-only pullback, high conviction entry for ZTMIG.", internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:charlie-from-ziptrader@ghost.io": ["z1"] };
  RESPONSES = {
    ZTMIG: { symbol: "ZTMIG", growthScore: 60, sentimentScore: 40, riskProfile: "Medium", reasoning: "n/a", whipsawCheck: "n/a", whipsawVerdict: "whipsaw", decision: "HOLD" },
  };

  const body = await runSync(port);

  const onDisk = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  assert.equal(onDisk.length, 2);
  const fool = onDisk.find((s: any) => s.id === "motley-fool");
  assert.ok(fool, "expected motley-fool to have been migrated into the existing file");
  assert.equal(fool.enabled, false);

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /motley-fool/i.test(m) && /migrat/i.test(m)),
    `expected a migration log line naming motley-fool, got: ${JSON.stringify(logMessages)}`,
  );

  assert.equal(gmailListCalls.length, 1, "the freshly migrated (disabled) motley-fool source must not be queried this same cycle");
  assert.ok(gmailListCalls.every((u) => decodeURIComponent(u).includes("from:charlie-from-ziptrader@ghost.io")));
});

test("default-disabled: a fresh default registry ships motley-fool disabled -- no Gmail query is issued for it in a sync cycle", async (t) => {
  resetFixtures();
  if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);

  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  MESSAGES = {
    z1: { from: "Charlie <charlie-from-ziptrader@ghost.io>", subject: "ZipTrader thesis", body: "Thesis body: fundamentals accelerating, whipsaw-only pullback, high conviction entry for ZTDFLT.", internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:charlie-from-ziptrader@ghost.io": ["z1"] };
  RESPONSES = {
    ZTDFLT: { symbol: "ZTDFLT", growthScore: 60, sentimentScore: 40, riskProfile: "Medium", reasoning: "n/a", whipsawCheck: "n/a", whipsawVerdict: "whipsaw", decision: "HOLD" },
  };

  await runSync(port);

  assert.ok(fs.existsSync(registryPath), "the default registry file should have been created");
  const onDisk = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  const fool = onDisk.find((s: any) => s.id === "motley-fool");
  assert.ok(fool, "expected the default file to ship a motley-fool entry");
  assert.equal(fool.enabled, false);

  // Only the ziptrader query should have been issued -- motley-fool is
  // disabled by default and must contribute zero Gmail list calls this cycle.
  assert.equal(gmailListCalls.length, 1, `expected exactly one Gmail list call, got: ${JSON.stringify(gmailListCalls)}`);
  assert.ok(gmailListCalls.every((u) => decodeURIComponent(u).includes("from:charlie-from-ziptrader@ghost.io")));
});

test("a Fool SELL on a held symbol (whipsaw verdict 'reversal') executes via the existing SELL decision path", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  await seedPosition(port, "HELDQ", 10, 40);

  writeRegistry([
    { id: "motley-fool", gmailQuery: "from:fool@motley.fool.com", senderAllowlist: ["fool@motley.fool.com"], trustTier: "high", maxAgeHours: 96, enabled: true },
  ]);
  MESSAGES = {
    sell1: { from: "The Motley Fool <fool@motley.fool.com>", subject: "Penalty Box Update: Selling HELDQ", body: foolSellBody("HELDQ"), internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:fool@motley.fool.com": ["sell1"] };
  RESPONSES = {
    HELDQ: {
      symbol: "HELDQ",
      // growthScore 80 / sentimentScore 20 -> rawAiConfidence round((80+20)/2)=50,
      // comfortably above signalEngine.ts's 35 low_confidence rejection floor
      // (matches the passing "reversal" SELL fixture pattern used by
      // tests/whipsawGateIntegration.test.ts).
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Growth thesis has broken down; closing the position per the Rule Breakers Penalty Box update.",
      whipsawCheck: "This is a verified fundamental breakdown, not a volatility shakeout.",
      whipsawVerdict: "reversal",
      decision: "SELL",
    },
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "HELDQ");
  assert.ok(analysis, "expected a HELDQ analysis to be recorded");
  assert.equal(analysis.decision, "SELL");

  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`);
  const trades = await tradesRes.json();
  assert.ok(
    trades.some((tr: any) => tr.symbol === "HELDQ" && tr.side === "sell"),
    `expected a real sell trade for HELDQ once the SELL reaches the existing decision path, got: ${JSON.stringify(trades)}`,
  );
});

test("the same Fool SELL fixture on an UNHELD symbol is a no-op -- the SELL decision is still recorded honestly, but no sell trade is submitted", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  // Deliberately no seedPosition call -- AWOLQ is never bought, so there is
  // no held position for the SELL branch to close.

  writeRegistry([
    { id: "motley-fool", gmailQuery: "from:fool@motley.fool.com", senderAllowlist: ["fool@motley.fool.com"], trustTier: "high", maxAgeHours: 96, enabled: true },
  ]);
  MESSAGES = {
    sell1: { from: "The Motley Fool <fool@motley.fool.com>", subject: "Penalty Box Update: Selling AWOLQ", body: foolSellBody("AWOLQ"), internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:fool@motley.fool.com": ["sell1"] };
  RESPONSES = {
    AWOLQ: {
      symbol: "AWOLQ",
      // growthScore 80 / sentimentScore 20 -> rawAiConfidence round((80+20)/2)=50,
      // comfortably above signalEngine.ts's 35 low_confidence rejection floor
      // (matches the passing "reversal" SELL fixture pattern used by
      // tests/whipsawGateIntegration.test.ts).
      growthScore: 80,
      sentimentScore: 20,
      riskProfile: "High",
      reasoning: "Growth thesis has broken down; closing the position per the Rule Breakers Penalty Box update.",
      whipsawCheck: "This is a verified fundamental breakdown, not a volatility shakeout.",
      whipsawVerdict: "reversal",
      decision: "SELL",
    },
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "AWOLQ");
  assert.ok(analysis, "the SELL decision must still be recorded honestly even though no position exists to close");
  assert.equal(analysis.decision, "SELL", "an unheld symbol must not silently mutate the recorded decision -- it's a no-op at the trade-execution step, not upstream");

  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`);
  const trades = await tradesRes.json();
  assert.equal(trades.some((tr: any) => tr.symbol === "AWOLQ"), false, "no trade of any kind should exist for a symbol never held and never bought");
});
