import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-regime-change-exit-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Broker "configured" (pattern: regimeMarketData.test.ts / regimeStaleness.test.ts) --
// this test needs the real fetchMarketRegimeInputs path (SPY/QQQ/BITO bars) driving
// detectRegime, joined with an open position + persisted buy-side exit plan (pattern:
// exitPlanMonitoring.test.ts) so MODULE 2's regime-change dimension (Task 9,
// docs/GO_LIVE_PLAN.md Phase 1.3) actually has something to evaluate.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

// --- Bar fixtures ------------------------------------------------------------

function buildBar(daysAgo: number, close: number) {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { t, o: close, h: close, l: close, c: close, v: 1000 };
}

// Same "mild, steady rise" fixture as regimeMarketData.test.ts: falls through
// detectRegime to the risk_on/allow bucket -- a benign regime that must NOT
// trigger a regime-change exit even though the plan under test has
// regimeChangeAction "close".
function buildMildRiseBars(count = 60, start = 400, step = 0.05) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = count - 1 - i;
    bars.push(buildBar(daysAgo, start + i * step));
  }
  return bars;
}

// Flat for 55 days then a steep 5-day crash from 400 to 320 -- a -20% drawdown
// off the series peak. detectRegime's very first branch (`drawdown <= -12`)
// fires regardless of trend/volatility, landing on risk_off/close_only. Used
// for both SPY (drives broadMarketDrawdownPercent) and QQQ/BITO (trend only)
// since the mocked /bars endpoint below serves the same series to every
// symbol -- detectRegime only reads QQQ/BITO for trend, and the drawdown
// branch already wins regardless of what trend value they produce.
function buildCrashBars(count = 60) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = count - 1 - i;
    const stepsFromEnd = count - 1 - i; // 0 for the last (most recent) bar
    const close = stepsFromEnd < 5 ? 400 - (5 - stepsFromEnd) * 16 : 400;
    bars.push(buildBar(daysAgo, close));
  }
  return bars;
}

function barsResponse(bars: unknown[]) {
  return new Response(JSON.stringify({ bars, symbol: "X", next_page_token: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureMessageResponse(content: Array<{ type: "text"; text: string }>) {
  return new Response(
    JSON.stringify({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Only a "NONE" decision fixture is needed -- this test is about the
// regime-change exit dimension, not the buy path (pattern: regimeStaleness
// .test.ts).
const analysisFixture = {
  symbol: "NONE",
  growthScore: 0,
  sentimentScore: 0,
  riskProfile: "Low",
  reasoning: "no thesis this cycle",
  whipsawCheck: "n/a",
  whipsawVerdict: "unclear",
  decision: "NONE",
};

// Mutable so each test/phase can drive detectRegime toward a different regime.
let currentBars: unknown[] = buildMildRiseBars();
// Mutable open-position snapshot served by GET /positions -- decoupled from
// whatever /api/override/trade buys placed (those only seed trade_intents +
// exit_plans; MODULE 2 reads live positions straight from this mock, exactly
// like a real broker account).
let positionsFixture: unknown[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  // --- Claude (same pattern as regimeMarketData.test.ts) ---
  if (url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    if (body.output_config) {
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(analysisFixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "ZipTrader fixture sentiment: nothing notable this cycle." }]);
  }

  // --- Alpaca market data (data.alpaca.markets): SPY/QQQ/BITO bars + price lookup ---
  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/trades/latest")) {
      return new Response(JSON.stringify({ trade: { p: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/bars")) {
      return barsResponse(currentBars);
    }
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

  // --- Alpaca trading host (paper-api.alpaca.markets): account/positions/orders ---
  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: "100000",
          buying_power: "100000",
          portfolio_value: "100000",
          equity: "100000",
          last_equity: "100000",
          long_market_value: "0",
          daytrade_count: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/positions")) {
      return new Response(JSON.stringify(positionsFixture), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "bro-1", status: "accepted", filled_qty: "0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/assets/")) {
      // Phase 2 Task 3 tradability guard: always tradable/active here -- not
      // under test in this file.
      const symbol = url.split("/assets/")[1];
      return new Response(JSON.stringify({ symbol, tradable: true, status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled paper-api.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called in this test file (no Authorization header sent).", { status: 500 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");
const { REGIME_STALENESS_MS } = await import("../src/server/marketDataFetcher");

async function setAutoTrading(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: {
        autoTrading: true,
        runIntervalMins: 15,
        maxPositionSizePercent: 10,
        stopLossPercent: 5,
        targetProfitPercent: 15,
      },
    }),
  });
  assert.equal(res.status, 200);
}

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal((body as any).success, true);
  return body as any;
}

// Backdates the persisted regime assessment's fetchedAt beyond
// REGIME_STALENESS_MS so the next sync refetches instead of reusing the
// previous test's cached assessment (pattern: regimeStaleness.test.ts).
// Needed because both tests in this file share one server/store within the
// same process. Phase 2 Task 1, Item A: the reuse decision keys on
// `fetchedAt` (when the fetch happened), not `asOf` (the newest-bar
// timestamp) -- see domainTypes.ts's RegimeAssessment.fetchedAt comment.
function forceRegimeRefetchNextSync() {
  const rawStore = createProductionStore(sqlitePath);
  const latest = rawStore.latestRegimeAssessment();
  if (latest) {
    rawStore.saveRegimeAssessment({
      ...latest,
      fetchedAt: new Date(Date.now() - (REGIME_STALENESS_MS + 5 * 60 * 1000)).toISOString(),
    });
  }
  rawStore.close();
}

test("regime-change exit: a close_only regime (deep-drawdown bars) liquidates a position whose plan opts into regimeChangeAction \"close\", with reasoning naming the regime", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  currentBars = buildCrashBars();
  positionsFixture = [];

  await setAutoTrading(port);

  const buy = await placeOrder(port, { symbol: "RGCLOSE", qty: 3, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body.trade.riskDecision));

  // createExitPlan (src/server/exitEngine.ts) always sets regimeChangeAction
  // "close" -- confirm the plan this sync will evaluate actually carries it,
  // since that's the gate under test.
  const preCheckStore = createProductionStore(sqlitePath);
  const preCheckPlan = preCheckStore.latestBuySideExitPlanForSymbol("RGCLOSE");
  preCheckStore.close();
  assert.equal(preCheckPlan?.exitPlan.regimeChangeAction, "close");

  // The position now exists at the broker, at cost (no P/L) -- price stays at
  // 100 so no other exit dimension (stop-loss 95, take-profit 115, trailing,
  // time-exit) is anywhere near triggering; only the regime dimension is live.
  positionsFixture = [
    {
      symbol: "RGCLOSE",
      qty: "3",
      market_value: "300",
      cost_basis: "300",
      unrealized_pl: "0.00",
      current_price: "100",
      avg_entry_price: "100",
    },
  ];

  const sync = await runSync(port);

  const store = createProductionStore(sqlitePath);
  const regime = store.latestRegimeAssessment();
  store.close();
  assert.ok(regime, "expected a persisted regime assessment");
  assert.equal(regime!.marketMode, "risk_off", `expected risk_off from the crash fixture, got ${JSON.stringify(regime)}`);
  assert.equal(regime!.tradePermission, "close_only");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "RGCLOSE" && tr.side === "sell");
  assert.ok(exitTrade, `expected a regime-change sell closing RGCLOSE, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);
  assert.equal(exitTrade.status, "Accepted", JSON.stringify(exitTrade.riskDecision));
  assert.equal(exitTrade.qty, 3, "the full open quantity must be liquidated");
  assert.match(exitTrade.reasoning, /regime_change/);
  assert.match(exitTrade.reasoning, /risk_off/);
  assert.match(exitTrade.reasoning, /close_only/);
});

test("no regime exit: a benign regime (mild-rise bars) does not liquidate a position whose plan opts into regimeChangeAction \"close\"", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  forceRegimeRefetchNextSync();
  currentBars = buildMildRiseBars();
  positionsFixture = [];

  await setAutoTrading(port);

  const buy = await placeOrder(port, { symbol: "RGBENIGN", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body.trade.riskDecision));

  const preCheckStore = createProductionStore(sqlitePath);
  const preCheckPlan = preCheckStore.latestBuySideExitPlanForSymbol("RGBENIGN");
  preCheckStore.close();
  assert.equal(preCheckPlan?.exitPlan.regimeChangeAction, "close");

  positionsFixture = [
    {
      symbol: "RGBENIGN",
      qty: "2",
      market_value: "200",
      cost_basis: "200",
      unrealized_pl: "0.00",
      current_price: "100",
      avg_entry_price: "100",
    },
  ];

  const sync = await runSync(port);

  const store = createProductionStore(sqlitePath);
  const regime = store.latestRegimeAssessment();
  store.close();
  assert.ok(regime, "expected a persisted regime assessment");
  assert.notEqual(regime!.tradePermission, "close_only", `expected a benign (non close_only) regime, got ${JSON.stringify(regime)}`);

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "RGBENIGN" && tr.side === "sell");
  assert.equal(
    exitTrade,
    undefined,
    `expected no sell for RGBENIGN under a benign regime, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`,
  );
});

test("fail-open for protection: a throwing regime-assessment store read degrades to the conservative default and MODULE 2 exits still evaluate (a triggered take-profit fires)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  currentBars = buildMildRiseBars();
  positionsFixture = [];

  await setAutoTrading(port);

  const buy = await placeOrder(port, { symbol: "RGDBFAIL", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body.trade.riskDecision));
  // Plan created by executeTradeIntent: takeProfitPrice = 115 (15% target).
  // The mocked position below sits at 130 -- take_profit is clearly triggered.
  positionsFixture = [
    {
      symbol: "RGDBFAIL",
      qty: "2",
      market_value: "260",
      cost_basis: "200",
      unrealized_pl: "60.00",
      current_price: "130",
      avg_entry_price: "100",
    },
  ];

  // Sabotage the regime-assessment storage via a second raw DB handle (pattern:
  // tests/symbolCooldown.test.ts): the server's long-lived store handle will now
  // throw "no such table" on latestRegimeAssessment()/saveRegimeAssessment().
  // This MUST NOT suppress MODULE 2 -- exits are protective, so a broken regime
  // store degrades to the conservative default (reduce_size, which can never
  // fire regime exits) while every other exit dimension still evaluates.
  // NOTE: this test must stay LAST in the file, and no createProductionStore
  // helper may be called between the drop and the sync -- opening a new store
  // handle recreates the table (CREATE TABLE IF NOT EXISTS) and would silently
  // defuse the sabotage.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(sqlitePath);
  raw.exec("DROP TABLE regime_assessments");
  raw.close();

  const sync = await runSync(port);

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "RGDBFAIL" && tr.side === "sell");
  assert.ok(
    exitTrade,
    `expected the take-profit exit to fire despite the broken regime store, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`,
  );
  assert.match(exitTrade.reasoning, /take_profit/);

  // And the degradation must be visible in the sync log, not silent.
  const logLines: string[] = sync.logs.map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /regime/i.test(line) && /(unavailable|conservative|degrad|fail)/i.test(line)),
    `expected a log entry about the regime store degradation, got: ${JSON.stringify(logLines)}`,
  );
});
