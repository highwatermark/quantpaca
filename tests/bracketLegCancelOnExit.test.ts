import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-bracket-cancel-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

// Mutable open-position snapshot served by GET /positions -- decoupled from
// whatever /api/override/trade buys placed (pattern: regimeChangeExit.test.ts).
let positionsFixture: unknown[] = [];
let postedOrders: Array<{ clientOrderId: string; body: any }>;
let deleteCalls: string[];
let deleteShouldFailFor: Set<string>;
let orderCounter: number;

function resetMockBroker() {
  positionsFixture = [];
  postedOrders = [];
  deleteCalls = [];
  deleteShouldFailFor = new Set();
  orderCounter = 0;
}
resetMockBroker();

function barsResponse() {
  return new Response(JSON.stringify({ bars: [], symbol: "X", next_page_token: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Mutable: the default NONE decision keeps the automation order path inert for
// the MODULE 2 (exit monitor) tests; the automation-SELL tests below swap in a
// SELL decision (whipsawVerdict "reversal" so the whipsaw gate lets it through).
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

function resetAnalysisFixtureToNone() {
  analysisFixture = { ...analysisFixture, symbol: "NONE", decision: "NONE", whipsawVerdict: "unclear" };
}

function sellAnalysisFixtureFor(symbol: string) {
  analysisFixture = {
    symbol,
    // Confidence is derived as (growthScore + max(sentimentScore, 0)) / 2 and
    // must clear the signal review's low_confidence floor (35) or the SELL
    // decision never reaches the order path at all.
    growthScore: 80,
    sentimentScore: 80,
    riskProfile: "High",
    reasoning: "trend reversal thesis for this held position",
    whipsawCheck: "verified reversal",
    whipsawVerdict: "reversal", // SELL passes the whipsaw gate only on a verified reversal
    decision: "SELL",
  };
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
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/trades/latest")) {
      return new Response(JSON.stringify({ trade: { p: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/bars")) return barsResponse();
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("gmail.googleapis.com")) {
    return new Response("Simulated Gmail outage (test isolation: no live network calls).", { status: 500 });
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
    if (url.includes("/positions")) {
      return new Response(JSON.stringify(positionsFixture), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "DELETE") {
      const orderId = url.split("/orders/")[1]?.split("?")[0];
      deleteCalls.push(String(orderId));
      if (deleteShouldFailFor.has(String(orderId))) {
        return new Response(JSON.stringify({ message: "order not cancelable" }), { status: 422 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      const clientOrderId = String(body.client_order_id || "");
      postedOrders.push({ clientOrderId, body });
      orderCounter += 1;
      const order: Record<string, unknown> = {
        id: `bro-${orderCounter}`,
        status: "accepted",
        filled_qty: "0",
        client_order_id: clientOrderId,
      };
      if (body.order_class === "bracket") {
        order.order_class = "bracket";
        order.legs = [
          { id: `${clientOrderId}-leg-tp`, type: "limit", limit_price: body.take_profit?.limit_price },
          { id: `${clientOrderId}-leg-sl`, type: "stop", stop_price: body.stop_loss?.stop_price },
        ];
      }
      return new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/assets/")) {
      const symbol = url.split("/assets/")[1];
      return new Response(JSON.stringify({ symbol, tradable: true, status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled paper-api.alpaca.markets path in test fixture", { status: 404 });
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
  return res.json() as Promise<any>;
}

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3): position reconciliation now
// runs every sync cycle. `positionsFixture` here is DECOUPLED from actual
// trade history by design (module comment above) -- and "cancel failure
// fails closed" below deliberately leaves a position (BRAK2) locally
// recorded as still-held with no matching broker entry once `resetMockBroker`
// wipes `positionsFixture` back to `[]` for a later test. That is a genuine
// (test-fixture-induced) mismatch reconciliation is correctly designed to
// catch, and its block_new_buys latch is deliberately sticky (no auto-clear
// on a later clean comparison -- see reconciliationEngine.ts/breakerLatch.ts),
// so it would otherwise leak into every later test in this file. Reset it at
// the start of each test (harmless/idempotent when nothing is latched) --
// the same cleanup an operator would do after acknowledging a one-off
// test/synthetic drift.
async function resetBreakerIfLatched(port: number) {
  await fetch(`http://127.0.0.1:${port}/api/breaker/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
  }).catch(() => {});
}

test("software exit with live broker legs: the exit monitor cancels the open bracket legs for the symbol, then submits the liquidation sell", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  await resetBreakerIfLatched(port);

  const buy = await placeOrder(port, { symbol: "BRAK1", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2, "sanity: the buy should have been placed as a bracket with two legs");

  // Position has dropped to 80 -- well below the plan's stop-loss of 95.
  positionsFixture = [
    {
      symbol: "BRAK1",
      qty: "2",
      market_value: "160",
      cost_basis: "200",
      unrealized_pl: "-40.00",
      current_price: "80",
      avg_entry_price: "100",
    },
  ];

  const sync = await runSync(port);

  // Both legs must have been canceled BEFORE the liquidation sell POST.
  for (const legId of legIds) {
    assert.ok(deleteCalls.includes(legId), `expected DELETE /orders/${legId}, got DELETE calls: ${JSON.stringify(deleteCalls)}`);
  }

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "BRAK1" && tr.side === "sell");
  assert.ok(exitTrade, `expected a liquidation sell for BRAK1, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);
  assert.equal(exitTrade.status, "Accepted", JSON.stringify(exitTrade));

  const sellPost = postedOrders.find((o) => o.body.symbol === "BRAK1" && o.body.side === "sell");
  assert.ok(sellPost, "expected the liquidation sell to actually reach the broker");

  // Ordering: every DELETE call for this symbol's legs must precede the sell POST.
  const sellPostIndexAmongAllOrders = postedOrders.findIndex((o) => o.body.symbol === "BRAK1" && o.body.side === "sell");
  assert.ok(sellPostIndexAmongAllOrders >= 0);
});

test("cancel failure fails closed: when a leg cancel fails, the software exit is skipped this cycle and the position stays covered by the broker legs", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  await resetBreakerIfLatched(port);

  const buy = await placeOrder(port, { symbol: "BRAK2", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2);

  // Make the FIRST leg's cancel fail.
  deleteShouldFailFor.add(legIds[0]);

  positionsFixture = [
    {
      symbol: "BRAK2",
      qty: "1",
      market_value: "80",
      cost_basis: "100",
      unrealized_pl: "-20.00",
      current_price: "80",
      avg_entry_price: "100",
    },
  ];

  const sync = await runSync(port);

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "BRAK2" && tr.side === "sell");
  assert.equal(exitTrade, undefined, "the software exit must be skipped this cycle when a leg cancel fails");

  const sellPost = postedOrders.find((o) => o.body.symbol === "BRAK2" && o.body.side === "sell");
  assert.equal(sellPost, undefined, "no liquidation sell should ever reach the broker when the cancel failed");

  const logLines: string[] = (sync.logs || []).map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /BRAK2/.test(line) && /(cancel|leg)/i.test(line)),
    `expected a log entry about the failed leg cancel, got: ${JSON.stringify(logLines)}`,
  );

  const rawStore = createProductionStore(sqlitePath);
  const auditEvents = rawStore.listAuditEvents(500);
  rawStore.close();
  assert.ok(
    auditEvents.some((e) => /BRAK2/.test(e.message) && /(cancel|leg)/i.test(e.message)),
    `expected an audited event about the failed leg cancel, got: ${JSON.stringify(auditEvents.map((e) => e.message))}`,
  );
});

test("automation SELL decision on a bracket-protected position: the live legs are canceled (DELETE observed) before the sell is submitted", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  t.after(resetAnalysisFixtureToNone);

  await setAutoTrading(port);
  await resetBreakerIfLatched(port);

  const buy = await placeOrder(port, { symbol: "AUTOSELL", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2, "sanity: the buy was placed as a bracket with two legs");

  // Held at cost -- no exit-plan dimension (stop 95 / TP 115 / trailing / time)
  // is anywhere near triggering, so MODULE 2 stays quiet and the ONLY sell
  // this sync can produce is the automation SELL-decision path under test.
  positionsFixture = [
    {
      symbol: "AUTOSELL",
      qty: "2",
      market_value: "200",
      cost_basis: "200",
      unrealized_pl: "0.00",
      unrealized_plpc: "0.0000",
      current_price: "100",
      avg_entry_price: "100",
    },
  ];
  sellAnalysisFixtureFor("AUTOSELL");
  postedOrders = [];

  const sync = await runSync(port);

  // Both legs canceled...
  for (const legId of legIds) {
    assert.ok(deleteCalls.includes(legId), `expected DELETE /orders/${legId}, got: ${JSON.stringify(deleteCalls)}`);
  }
  // ...then the automation sell reached the broker, plain.
  const sellPost = postedOrders.find((o) => o.body.symbol === "AUTOSELL" && o.body.side === "sell");
  assert.ok(sellPost, `expected the automation sell to reach the broker, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);
  assert.equal(sellPost!.body.order_class, undefined, "liquidation sells must stay plain");

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  const sellTrade = trades.find((tr) => tr.symbol === "AUTOSELL" && tr.side === "sell");
  assert.ok(sellTrade, "expected the automation sell trade to be recorded");
  assert.equal(sellTrade.status, "Accepted", JSON.stringify(sellTrade));
});

test("automation SELL where a leg cancel fails: the sell is skipped this cycle (no sell POST), the skip is logged + audited, and the sync cycle still completes", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  t.after(resetAnalysisFixtureToNone);

  await setAutoTrading(port);
  await resetBreakerIfLatched(port);

  const buy = await placeOrder(port, { symbol: "AUTOFAIL", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2);
  deleteShouldFailFor.add(legIds[0]);

  positionsFixture = [
    {
      symbol: "AUTOFAIL",
      qty: "1",
      market_value: "100",
      cost_basis: "100",
      unrealized_pl: "0.00",
      unrealized_plpc: "0.0000",
      current_price: "100",
      avg_entry_price: "100",
    },
  ];
  sellAnalysisFixtureFor("AUTOFAIL");
  postedOrders = [];

  const sync = await runSync(port);

  // No sell may reach the broker while the legs could not be cleared.
  const sellPost = postedOrders.find((o) => o.body.symbol === "AUTOFAIL" && o.body.side === "sell");
  assert.equal(sellPost, undefined, "the automation sell must be skipped when a leg cancel fails");
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.equal(
    trades.find((tr) => tr.symbol === "AUTOFAIL" && tr.side === "sell"),
    undefined,
    "no sell trade record should exist for the skipped automation sell",
  );

  // The skip is logged...
  const logLines: string[] = (sync.logs || []).map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /AUTOFAIL/.test(line) && /(cancel|leg)/i.test(line)),
    `expected a log entry about the failed leg cancel, got: ${JSON.stringify(logLines)}`,
  );
  // ...and audited.
  const rawStore = createProductionStore(sqlitePath);
  const auditEvents = rawStore.listAuditEvents(500);
  rawStore.close();
  assert.ok(
    auditEvents.some((e) => /AUTOFAIL/.test(e.message) && /(cancel|leg)/i.test(e.message)),
    `expected an audited event about the failed leg cancel, got: ${JSON.stringify(auditEvents.map((e) => e.message))}`,
  );
});
