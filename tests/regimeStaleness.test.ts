import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-regime-staleness-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Broker "configured" (same reasoning as regimeMarketData.test.ts) so the sync
// wiring actually attempts a market-data refetch this cycle instead of
// short-circuiting on "broker not configured" -- the scenario under test is
// specifically "the refetch itself came back with nothing usable".
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

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

// Only a "NONE" decision fixture is needed -- this test is about the regime
// assessment itself, not the buy path.
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
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(analysisFixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "ZipTrader fixture sentiment: nothing notable this cycle." }]);
  }

  // Market-data bars: always fail this cycle (simulated data.alpaca.markets
  // outage) -- every symbol's series comes back "unavailable", which is what
  // must drive the fallback to the conservative default.
  if (url.includes("data.alpaca.markets")) {
    return new Response("simulated data.alpaca.markets outage", { status: 503 });
  }

  // MODULE 2 (the portfolio risk controller) unconditionally calls
  // getAlpacaPortfolio() whenever autoTrading is on, regardless of whether
  // there are any positions -- account/positions must be intercepted even
  // though this test never places a trade.
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
    if (url.includes("/positions") || url.includes("/orders")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
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

test("staleness: a persisted regime assessment older than 30 minutes with a failing refetch falls back to the conservative default, and the degradation is logged", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Seed a stale, non-conservative assessment directly (bypassing the fetch) --
  // this is what "reuse a <30-min-old assessment" would otherwise pick up.
  const staleAsOf = new Date(Date.now() - (REGIME_STALENESS_MS + 5 * 60 * 1000)).toISOString();
  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveRegimeAssessment({
    id: "reg-stale",
    timestamp: staleAsOf,
    asOf: staleAsOf,
    marketMode: "risk_on",
    volatilityLevel: "low",
    tradePermission: "allow",
    sizeMultiplier: 0.8,
    reason: "stale fixture assessment",
    inputs: { spyTrendPercent: 5, qqqTrendPercent: 5, broadMarketDrawdownPercent: 0, volatilityProxyPercent: 10 },
  });
  rawStore.close();

  await setAutoTrading(port);
  const body = await runSync(port);

  const store = createProductionStore(sqlitePath);
  const regime = store.latestRegimeAssessment();
  store.close();
  assert.ok(regime, "expected a persisted regime assessment after the sync");
  assert.equal(regime!.marketMode, "unclear", "a stale assessment + failing refetch must fall back to the conservative default");
  assert.equal(regime!.tradePermission, "reduce_size");
  assert.equal(regime!.sizeMultiplier, 0.5);
  assert.notEqual(regime!.id, "reg-stale", "the stale seed row must not simply be reused as-is");

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /regime/i.test(m) && /(unavailable|conservative|degrad)/i.test(m)),
    `expected a log entry about the regime degradation, got: ${JSON.stringify(logMessages)}`,
  );
});
