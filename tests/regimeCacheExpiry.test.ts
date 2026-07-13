import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-regime-cache-expiry-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
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

let barsRequestCount = 0;

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

  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/bars")) {
      barsRequestCount++;
      return barsResponse(buildMildRiseBars());
    }
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

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

test("cache expiry: a fetchedAt older than REGIME_STALENESS_MS refetches, even though asOf alone would look fresh", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Seed an assessment whose fetchedAt is 31 minutes old but whose `asOf`
  // (newest-bar timestamp) is recent -- proving the reuse decision keys on
  // fetchedAt, not asOf (the bug this task fixes: under the old inverted
  // semantics a recent asOf alone would have looked "fresh enough" to reuse).
  const oldFetchedAt = new Date(Date.now() - (REGIME_STALENESS_MS + 60_000)).toISOString();
  const recentAsOf = new Date().toISOString();
  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveRegimeAssessment({
    id: "reg-expiring",
    timestamp: oldFetchedAt,
    asOf: recentAsOf,
    fetchedAt: oldFetchedAt,
    marketMode: "risk_off",
    volatilityLevel: "high",
    tradePermission: "block_new_buys",
    sizeMultiplier: 0.3,
    reason: "expiring fixture assessment",
    inputs: { spyTrendPercent: -5 },
  });
  rawStore.close();

  await setAutoTrading(port);
  barsRequestCount = 0;
  const body = await runSync(port);

  assert.equal(barsRequestCount, 3, "a fetchedAt older than REGIME_STALENESS_MS must trigger a fresh 3-request refetch");

  const store = createProductionStore(sqlitePath);
  const regime = store.latestRegimeAssessment();
  store.close();
  assert.notEqual(regime!.id, "reg-expiring", "the expired seed row must not simply be reused as-is");
  assert.equal(regime!.marketMode, "risk_on", "the fresh fetch (mild-rise fixture) must drive the new assessment");
  assert.ok(regime!.fetchedAt, "the fresh fetch must record a new fetchedAt");

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /regime assessment refreshed/i.test(m)),
    `expected a "regime assessment refreshed" log entry, got: ${JSON.stringify(logMessages)}`,
  );
});
