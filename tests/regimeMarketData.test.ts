import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-regime-market-data-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Deliberately the OPPOSITE of exitPlanMonitoring.test.ts / whipsawGateIntegration
// .test.ts: this file needs the broker "configured" (real credentials shape, real
// data.alpaca.markets + paper-api.alpaca.markets calls through the real code
// paths) to prove the regime market-data fetch and the buy-path sizing wiring
// both work against the real host/auth pattern -- not just the always-simulated
// path every other integration test exercises. Every Alpaca host is therefore
// intercepted below, alongside api.anthropic.com (same as whipsawGateIntegration
// .test.ts) and Gmail (never called -- no Authorization header is sent).
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

// --- Bar fixtures ------------------------------------------------------------

// A mild, steady rise: sma20 vs sma50 stays within regimeEngine's [-3, 3] trend
// band, drawdown is 0 (the series only ever rises, so the current close is
// always the window's peak), and daily returns are tiny -- low/normal vol. None
// of the "extreme vol", "drawdown <= -7/-12", or "trend > 3" branches fire, so
// detectRegime falls through to the final risk_on bucket (sizeMultiplier 0.8,
// tradePermission "allow"). This is the fixture used for the "buy path
// consumes it" assertion below, where the exact 0.8x is checked via qty math.
function buildBar(daysAgo: number, close: number) {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { t, o: close, h: close, l: close, c: close, v: 1000 };
}

function buildMildRiseBars(count = 60, start = 400, step = 0.05) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = count - 1 - i;
    bars.push(buildBar(daysAgo, start + i * step));
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

let analysisFixture: Record<string, unknown> = {
  symbol: "NONE",
  growthScore: 0,
  sentimentScore: 0,
  riskProfile: "Low",
  reasoning: "no thesis this cycle",
  whipsawCheck: "n/a",
  whipsawVerdict: "unclear",
  decision: "NONE",
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  // --- Claude (same pattern as whipsawGateIntegration.test.ts) ---
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
      return barsResponse(buildMildRiseBars());
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
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
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

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body;
}

test("a sync with real (fixture) market data persists a non-unclear regime assessment with recorded inputs, and the buy path sizes with the regime multiplier applied", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  analysisFixture = {
    symbol: "RONE",
    growthScore: 90,
    sentimentScore: 90,
    riskProfile: "Medium",
    reasoning: "Fundamentals are strong and improving.",
    whipsawCheck: "This is a whipsaw -- volatility-driven, dip likely to recover.",
    whipsawVerdict: "whipsaw", // BUY + whipsaw keeps full confidence (see whipsawGate.ts)
    decision: "BUY",
  };

  await setAutoTrading(port);
  const body = await runSync(port);

  const analysis = body.analyses.find((a: any) => a.symbol === "RONE");
  assert.ok(analysis, `expected an RONE BUY analysis, logs: ${JSON.stringify(body.logs?.map((l: any) => l.message))}`);
  assert.equal(analysis.decision, "BUY");

  // --- Regime assessment: persisted, non-"unclear", with real inputs recorded ---
  const store = createProductionStore(sqlitePath);
  const regime = store.latestRegimeAssessment();
  store.close();
  assert.ok(regime, "expected a persisted regime assessment");
  assert.equal(regime!.marketMode, "risk_on", `expected risk_on from the mild-rise fixture, got ${JSON.stringify(regime)}`);
  assert.equal(regime!.tradePermission, "allow");
  assert.equal(regime!.sizeMultiplier, 0.8);
  assert.ok(regime!.asOf, "expected asOf to be recorded on the persisted assessment");
  assert.ok(regime!.inputs, "expected inputs to be recorded alongside the assessment");
  assert.equal(typeof regime!.inputs!.spyTrendPercent, "number");
  assert.equal(typeof regime!.inputs!.qqqTrendPercent, "number");
  assert.equal(typeof regime!.inputs!.broadMarketDrawdownPercent, "number");
  assert.equal(typeof regime!.inputs!.volatilityProxyPercent, "number");

  // --- Buy path consumes it: qty reflects the 0.8x regime multiplier ---
  // equity 100000, maxPositionSizePercent 10% -> maxPositionNotional 10000 (also
  // the max_notional cap, same value here) -> confidenceMultiplier
  // min(1, 90/100) = 0.9 -> 9000 -> stopDistance 5% (<=8%, no haircut) -> regime
  // 0.8x -> 7200 -> floor(7200 / 100 price) = 72. Without the regime multiplier
  // this would be 90 -- the exact value proves the fetched regime, not just
  // "some" regime, drove the sizing.
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  const buyTrade = trades.find((tr) => tr.symbol === "RONE" && tr.side === "buy");
  assert.ok(buyTrade, `expected a BUY trade for RONE, logs: ${JSON.stringify(body.logs?.map((l: any) => l.message))}`);
  assert.equal(buyTrade.status, "Accepted", JSON.stringify(buyTrade.riskDecision));
  assert.equal(buyTrade.qty, 72, "qty should reflect the 0.8x risk_on regime multiplier (90 without it)");
});
