// Phase 2 final review, finding C1: a broker-side bracket-leg fill (a
// take-profit or stop-loss leg filling directly at Alpaca, discovered by
// Task 5's order-status poller -- src/server/orderStatusPoller.ts) used to
// record ONLY brokerLegStates[legId]="Filled" + exitClosedBrokerSide on the
// entry trade. No SELL-side ledger entry was ever created, so
// computeExpectedPositions (reconciliationEngine.ts) kept summing the BUY
// forever -- the ledger expected the position to still be open even after
// Alpaca's own bracket flattened it. The very next position reconciliation
// then reported a `missing_position` mismatch and latched block_new_buys
// (sticky -- never auto-clears), forever, for a perfectly healthy fill.
//
// This file exercises the fix end-to-end: BUY placed as a bracket -> its TP
// leg fills broker-side -> the poller discovers it -> the ledger must self-
// correct (a synthetic SELL trade record for the leg's filled_qty) so the
// very next reconciliation sees expected == actual == 0 for that symbol and
// reports "matched", never latching the breaker.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-leg-fill-ledger-"));
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

type MockOrder = {
  id: string;
  symbol: string;
  status: string;
  filled_qty: string;
  filled_avg_price?: string;
  type: string;
  limit_price?: string;
  stop_price?: string;
  client_order_id: string;
};

// Mutable, decoupled from the local trade ledger (same pattern as
// bracketLegCancelOnExit.test.ts) -- this is what lets the test simulate
// "the broker's bracket flattened the position" independently of whatever
// the local ledger currently believes.
let positionsFixture: unknown[] = [];
let postedOrders: Array<{ clientOrderId: string; body: any }>;
let ordersById: Map<string, MockOrder>;
let orderCounter: number;

function resetMockBroker() {
  positionsFixture = [];
  postedOrders = [];
  ordersById = new Map();
  orderCounter = 0;
}
resetMockBroker();

const NONE_ANALYSIS = {
  symbol: "NONE",
  growthScore: 0,
  sentimentScore: 0,
  riskProfile: "Low",
  reasoning: "no thesis this cycle",
  whipsawCheck: "n/a",
  whipsawVerdict: "unclear",
  decision: "NONE",
};

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
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(NONE_ANALYSIS) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    return new Response("Simulated Gmail outage (test isolation: no live network calls).", { status: 500 });
  }

  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/trades/latest")) {
      return new Response(JSON.stringify({ trade: { p: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/bars")) {
      return new Response(JSON.stringify({ bars: [], symbol: "X", next_page_token: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: "500000",
          buying_power: "500000",
          portfolio_value: "500000",
          equity: "500000",
          last_equity: "500000",
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
      return new Response(null, { status: 204 });
    }
    // Single-order GET (/orders/{id}) -- checked BEFORE the generic list GET
    // below, since both share the `/orders` prefix.
    const singleOrderMatch = url.match(/\/orders\/([^/?]+)(?:\?|$)/);
    if (singleOrderMatch && (!init?.method || init.method === "GET")) {
      const orderId = decodeURIComponent(singleOrderMatch[1]);
      const order = ordersById.get(orderId);
      if (!order) return new Response(JSON.stringify({ message: "order not found" }), { status: 404 });
      return new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      const clientOrderId = String(body.client_order_id || "");
      postedOrders.push({ clientOrderId, body });
      orderCounter += 1;
      const entryId = `bro-${orderCounter}`;
      const entryOrder: MockOrder = {
        id: entryId,
        symbol: body.symbol,
        status: "accepted",
        filled_qty: "0",
        type: body.type || "market",
        client_order_id: clientOrderId,
      };
      ordersById.set(entryId, entryOrder);
      const responseBody: Record<string, unknown> = { ...entryOrder };
      if (body.order_class === "bracket") {
        const tpId = `${clientOrderId}-leg-tp`;
        const slId = `${clientOrderId}-leg-sl`;
        ordersById.set(tpId, {
          id: tpId,
          symbol: body.symbol,
          status: "accepted",
          filled_qty: "0",
          type: "limit",
          limit_price: String(body.take_profit?.limit_price ?? ""),
          client_order_id: clientOrderId,
        });
        ordersById.set(slId, {
          id: slId,
          symbol: body.symbol,
          status: "accepted",
          filled_qty: "0",
          type: "stop",
          stop_price: String(body.stop_loss?.stop_price ?? ""),
          client_order_id: clientOrderId,
        });
        responseBody.order_class = "bracket";
        responseBody.legs = [{ id: tpId, type: "limit" }, { id: slId, type: "stop" }];
      }
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
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
  return { status: res.status, body: (await res.json()) as any };
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

async function resetBreakerIfLatched(port: number) {
  await fetch(`http://127.0.0.1:${port}/api/breaker/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
  }).catch(() => {});
}

async function latestReconciliation(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/reconciliation/latest`, { headers: { "x-admin-token": ADMIN_TOKEN } });
  return res.json() as Promise<any>;
}

async function latestBreaker(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/breaker/latest`, { headers: { "x-admin-token": ADMIN_TOKEN } });
  return res.json() as Promise<any>;
}

function findTrade(symbol: string, side: "buy" | "sell") {
  const store = createProductionStore(sqlitePath);
  const trades = store.listTradeIntents(500).filter((tr) => tr.symbol === symbol && tr.side === side);
  store.close();
  return trades;
}

test("TP leg fills broker-side: the ledger self-corrects (synthetic SELL entry) so reconciliation matches and the breaker never latches", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  await resetBreakerIfLatched(port);

  const buy = await placeOrder(port, { symbol: "LEGLDGR", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2, "sanity: the buy should have been placed as a bracket with two legs");
  const tpLegId = legIds.find((id) => id.endsWith("-leg-tp"))!;
  assert.ok(tpLegId);

  // Broker still shows the open position (nothing has filled broker-side yet).
  positionsFixture = [
    {
      symbol: "LEGLDGR",
      qty: "2",
      market_value: "200",
      cost_basis: "200",
      unrealized_pl: "0.00",
      unrealized_plpc: "0.0000",
      current_price: "100",
      avg_entry_price: "100",
    },
  ];

  // Sanity: reconciliation matches BEFORE the leg fill (expected == actual == 2).
  await runSync(port);
  const preFillReport = await latestReconciliation(port);
  assert.equal(preFillReport.status, "matched", `sanity pre-fill reconciliation should already match: ${JSON.stringify(preFillReport)}`);

  // The take-profit leg fills broker-side; the bracket's OCO semantics mean
  // the whole position is now flat at the broker.
  const tpOrder = ordersById.get(tpLegId)!;
  tpOrder.status = "filled";
  tpOrder.filled_qty = "2";
  tpOrder.filled_avg_price = "115";
  positionsFixture = [];

  const sync = await runSync(port);

  // The poller must have discovered the fill.
  const entryTrades = findTrade("LEGLDGR", "buy");
  assert.equal(entryTrades.length, 1);
  const entryTrade = entryTrades[0];
  assert.equal(entryTrade.brokerLegStates?.[tpLegId], "Filled");
  assert.ok(entryTrade.exitClosedBrokerSide, "expected exitClosedBrokerSide to be recorded");

  // C1: a synthetic SELL-side ledger entry for the leg's filled_qty must now
  // exist -- this is what lets computeExpectedPositions net back to zero.
  const sellTrades = findTrade("LEGLDGR", "sell");
  assert.equal(sellTrades.length, 1, `expected exactly one synthetic SELL ledger entry, got: ${JSON.stringify(sellTrades)}`);
  assert.equal(sellTrades[0].filledQty ?? sellTrades[0].qty, 2);
  assert.ok(
    ["Filled", "Accepted", "PartiallyFilled"].includes(sellTrades[0].status),
    `expected the synthetic sell to count toward the broker-successful ledger, got status ${sellTrades[0].status}`,
  );

  // The very next reconciliation must see expected == actual == 0 for this
  // symbol -- no missing_position mismatch, no latch.
  const report = await latestReconciliation(port);
  assert.equal(
    report.status,
    "matched",
    `expected reconciliation to match after the ledger self-corrected, got: ${JSON.stringify(report)}`,
  );
  assert.equal(
    (report.mismatches || []).some((m: any) => m.symbol === "LEGLDGR"),
    false,
    `expected no LEGLDGR mismatch, got: ${JSON.stringify(report.mismatches)}`,
  );

  const breaker = await latestBreaker(port);
  assert.notEqual(breaker.status, "block_new_buys", `breaker must not have latched: ${JSON.stringify(breaker)}`);

  // A subsequent BUY (of a different, unrelated symbol) must not be blocked
  // by a stale reconciliation-mismatch latch.
  const nextBuy = await placeOrder(port, { symbol: "UNRELATED", qty: 1, side: "buy", price: 50 });
  assert.equal(nextBuy.body.trade.status, "Accepted", JSON.stringify(nextBuy.body));

  // A subsequent sync cycle must not try to re-evaluate/re-liquidate the now-
  // flat LEGLDGR lot (MODULE 2 iterates live broker positions, which no
  // longer include it).
  const logLines: string[] = (sync.logs || []).map((l: any) => l.message);
  assert.equal(
    logLines.some((m: string) => /LEGLDGR/.test(m) && /(PLAN EXIT|PROTECTIVE BOUND|Liquidated)/i.test(m)),
    false,
    `expected no further software-exit evaluation of the already-flat LEGLDGR lot, got: ${JSON.stringify(logLines)}`,
  );
});
