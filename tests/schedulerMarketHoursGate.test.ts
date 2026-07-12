import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-scheduler-market-hours-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// A CONFIGURED broker is required here: checkMarketOpenForScheduledCycle only
// ever fetches GET /v2/clock when a broker is configured (see server.ts) --
// this is exactly the real Alpaca clock check under test.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";

// Controls what GET /v2/clock returns for this test file's fetch interceptor.
// "open" -> is_open:true, "closed" -> is_open:false, "fail" -> HTTP 500.
let clockMode: "open" | "closed" | "fail" = "open";
let anthropicCallCount = 0;
// Broker positions returned by GET /positions -- mutable per test so the
// protective-exit tests below can seed an open position that MODULE 2's
// legacy stop-loss will trigger on (unrealized loss beyond stopLossPercent).
let openPositions: any[] = [];

function losingPosition(symbol: string) {
  // cost_basis 1000, unrealized_pl -100 -> unrealized_plpc -0.10 -> -10% loss,
  // beyond the 5% stopLossPercent -> MODULE 2's legacy stop-loss fires.
  return {
    symbol,
    qty: "10",
    market_value: "900",
    cost_basis: "1000",
    unrealized_pl: "-100",
    current_price: "90",
    avg_entry_price: "100",
  };
}

function buildBar(daysAgo: number, close: number) {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { t, o: close, h: close, l: close, c: close, v: 1000 };
}
function buildMildRiseBars(count = 60, start = 400, step = 0.05) {
  const bars = [];
  for (let i = 0; i < count; i++) bars.push(buildBar(count - 1 - i, start + i * step));
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

const analysisFixture = {
  symbol: "MHGT",
  growthScore: 90,
  sentimentScore: 90,
  riskProfile: "Medium",
  reasoning: "Should never actually be reached this cycle.",
  whipsawCheck: "This is a whipsaw.",
  whipsawVerdict: "whipsaw",
  decision: "BUY",
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    anthropicCallCount++;
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

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/clock")) {
      if (clockMode === "fail") return new Response("simulated clock outage", { status: 500 });
      return new Response(JSON.stringify({ is_open: clockMode === "open" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: "100000", buying_power: "100000", portfolio_value: "100000", equity: "100000",
          last_equity: "100000", long_market_value: "0", daytrade_count: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/positions")) {
      return new Response(JSON.stringify(openPositions), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: `bro-${Math.random().toString(36).slice(2, 8)}`, status: "accepted", filled_qty: "0" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled paper-api.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/trades/latest")) {
      return new Response(JSON.stringify({ trade: { p: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/bars")) return barsResponse(buildMildRiseBars());
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called (scheduled cycles carry no Authorization header).", { status: 500 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app, runScheduledSyncTickForTests } = await import("../server");

async function setAutoTrading(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: true, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 5, targetProfitPercent: 15 },
    }),
  });
  assert.equal(res.status, 200);
}

test("market closed (is_open:false): a scheduled cycle places zero orders, makes zero Claude calls, still runs the exit monitor, and logs the skip", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  clockMode = "closed";
  anthropicCallCount = 0;

  await runScheduledSyncTickForTests();

  assert.equal(anthropicCallCount, 0, "a market-closed scheduled cycle must make zero Claude API calls");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  assert.deepEqual(trades, [], "a market-closed scheduled cycle must place zero orders");

  const logs = await (await fetch(`http://127.0.0.1:${port}/api/logs`)).json() as any[];
  const messages: string[] = logs.map((l) => l.message);
  assert.ok(
    messages.some((m) => /market closed/i.test(m) && /skip/i.test(m)),
    `expected a logged skip for the reduced cycle, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => /is_open=false/i.test(m)),
    `expected the clock check result itself to be logged, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => /active risk evaluator/i.test(m)),
    `expected MODULE 2 (exit monitoring) to still have run during a reduced cycle, got: ${JSON.stringify(messages)}`,
  );
});

test("clock fetch failure is treated as closed (fail closed): same reduced-cycle behavior as an explicit is_open:false", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  clockMode = "fail";
  anthropicCallCount = 0;

  await runScheduledSyncTickForTests();

  assert.equal(anthropicCallCount, 0, "a clock-fetch-failure scheduled cycle must make zero Claude API calls (fail closed)");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  assert.deepEqual(trades, [], "a clock-fetch-failure scheduled cycle must place zero orders");

  const logs = await (await fetch(`http://127.0.0.1:${port}/api/logs`)).json() as any[];
  const messages: string[] = logs.map((l) => l.message);
  assert.ok(
    messages.some((m) => /clock check failed/i.test(m) && /closed/i.test(m)),
    `expected the clock fetch failure to be logged as failing closed, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => /market closed/i.test(m) && /skip/i.test(m)),
    `expected the reduced-cycle skip to be logged, got: ${JSON.stringify(messages)}`,
  );
});

// Shared body for the two protective-exit-while-closed cases below. The
// standing principle (cooldown, breaker, and the per-cycle BUY cap all
// already encode it): de-risking always stays available. A closed/unknown
// market must fail closed for BUYs (risk-increasing) but must NEVER suppress
// an already-triggered protective liquidation (risk-reducing) -- when the
// market is genuinely closed, Alpaca queues the day market order for the
// open; when the clock merely failed transiently, protection proceeds
// immediately. BUY suppression in a scheduled closed cycle happens upstream
// (the reduced cycle skips ingestion/analysis entirely -- zero Claude calls,
// so no BUY decision can even form); the chokepoint's buy-only block is
// defense-in-depth behind that.
async function assertProtectiveSellProceedsWhileClosed(t: any, symbol: string) {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => {
    listener.close();
    openPositions = [];
  });

  await setAutoTrading(port);
  openPositions = [losingPosition(symbol)];
  anthropicCallCount = 0;

  const tradesBefore = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const buysBefore = tradesBefore.filter((tr) => tr.side === "buy").length;

  await runScheduledSyncTickForTests();

  assert.equal(anthropicCallCount, 0, "the reduced cycle must still make zero Claude calls -- no BUY decision can form");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const protectiveSell = trades.find((tr) => tr.symbol === symbol && tr.side === "sell");
  assert.ok(protectiveSell, `expected a protective stop-loss SELL for ${symbol} despite the closed/unknown market, got: ${JSON.stringify(trades)}`);
  assert.equal(
    protectiveSell.status,
    "Accepted",
    `the protective SELL must reach the broker (risk-reducing orders are never blocked by the market-hours gate), got: ${JSON.stringify(protectiveSell)}`,
  );

  const buysAfter = trades.filter((tr) => tr.side === "buy").length;
  assert.equal(buysAfter, buysBefore, "no new BUY order may be placed during a closed/unknown-market scheduled cycle");

  const logs = await (await fetch(`http://127.0.0.1:${port}/api/logs`)).json() as any[];
  const messages: string[] = logs.map((l) => l.message);
  assert.ok(
    messages.some((m) => /market closed/i.test(m) && /skip/i.test(m)),
    `expected the reduced-cycle skip (the clock reason for why no BUY can happen) to be logged, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => new RegExp(symbol).test(m) && /stop loss|liquidated/i.test(m)),
    `expected the protective liquidation to be logged for ${symbol}, got: ${JSON.stringify(messages)}`,
  );
}

test("clock fetch FAILURE (treated closed): an already-triggered protective stop-loss SELL still executes; no BUY is placed", async (t) => {
  clockMode = "fail";
  await assertProtectiveSellProceedsWhileClosed(t, "PROTA");
});

test("market genuinely closed (is_open:false): an already-triggered protective stop-loss SELL still executes (broker queues it for the open); no BUY is placed", async (t) => {
  clockMode = "closed";
  await assertProtectiveSellProceedsWhileClosed(t, "PROTB");
});

test("market open (is_open:true): a scheduled cycle runs full scope -- Claude is called and a BUY order is placed", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  clockMode = "open";
  anthropicCallCount = 0;

  await runScheduledSyncTickForTests();

  assert.ok(anthropicCallCount > 0, "a market-open scheduled cycle must make Claude API calls");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  assert.ok(
    trades.some((tr: any) => tr.symbol === "MHGT" && tr.side === "buy"),
    `expected a BUY trade for MHGT once the market is open, got: ${JSON.stringify(trades)}`,
  );
});
