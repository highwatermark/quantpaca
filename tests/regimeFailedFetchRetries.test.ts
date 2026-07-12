import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-regime-failed-retry-"));
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

// Toggled between the two syncs in the single test below: first sync
// simulates an outage, second sync simulates the outage clearing.
let barsShouldFail = true;
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
      if (barsShouldFail) {
        return new Response("simulated data.alpaca.markets outage", { status: 503 });
      }
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

test("a failed fetch never suppresses the next sync's retry, and a subsequent successful retry is used", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);

  // First sync: the market-data fetch fails outright.
  barsShouldFail = true;
  barsRequestCount = 0;
  const firstBody = await runSync(port);
  assert.equal(barsRequestCount, 3, "expected 3 attempted (failing) bars requests on the first sync");

  const store1 = createProductionStore(sqlitePath);
  const afterFailure = store1.latestRegimeAssessment();
  store1.close();
  assert.ok(afterFailure, "expected the degraded conservative assessment to be persisted for audit");
  assert.equal(afterFailure!.marketMode, "unclear");
  assert.equal(afterFailure!.tradePermission, "reduce_size");
  assert.equal(
    afterFailure!.fetchedAt,
    undefined,
    "a failed fetch must NOT write fetchedAt -- writing it would suppress the next sync's retry for 30 minutes",
  );

  const firstLogMessages: string[] = firstBody.logs.map((l: any) => l.message);
  assert.ok(
    firstLogMessages.some((m) => /regime/i.test(m) && /(unavailable|conservative|degrad|failed)/i.test(m)),
    `expected a log entry about the regime fetch failure, got: ${JSON.stringify(firstLogMessages)}`,
  );

  // Second sync, immediately after (well within 30 minutes): the outage
  // clears and the fetch now succeeds. Because the first sync wrote no
  // fetchedAt, this must retry rather than reuse the degraded assessment.
  barsShouldFail = false;
  barsRequestCount = 0;
  const secondBody = await runSync(port);
  assert.equal(barsRequestCount, 3, "a failed fetch must not suppress the very next sync's retry -- expected a fresh 3-request attempt");

  const store2 = createProductionStore(sqlitePath);
  const afterRetry = store2.latestRegimeAssessment();
  store2.close();
  assert.equal(afterRetry!.marketMode, "risk_on", "the successful retry (mild-rise fixture) must drive the fresh assessment");
  assert.ok(afterRetry!.fetchedAt, "the successful retry must record fetchedAt");

  const secondLogMessages: string[] = secondBody.logs.map((l: any) => l.message);
  assert.ok(
    secondLogMessages.some((m) => /regime assessment refreshed/i.test(m)),
    `expected a "regime assessment refreshed" log entry on the successful retry, got: ${JSON.stringify(secondLogMessages)}`,
  );
});
