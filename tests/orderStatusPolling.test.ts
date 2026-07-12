import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-order-status-poll-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";
// This file places well over the default 10/day risk cap across its tests
// (including a dedicated 26-buy poll-cap test) -- raise the limit so an
// unrelated risk rejection doesn't masquerade as a polling failure.
process.env.QUANTPACA_MAX_DAILY_TRADES = "200";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

// Mock-Alpaca broker state -----------------------------------------------
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

let postedOrders: Array<{ clientOrderId: string; body: any }>;
let deleteCalls: string[];
let deleteShouldFailFor: Set<string>;
let getOrderCalls: string[];
let getOrderShouldFailFor: Set<string>;
let ordersById: Map<string, MockOrder>;
let orderCounter: number;
// GET /v2/clock -- "open" unless a test explicitly flips this to exercise a
// reduced (scheduled + market-closed) cycle.
let clockIsOpen = true;

function resetMockBroker() {
  postedOrders = [];
  deleteCalls = [];
  deleteShouldFailFor = new Set();
  getOrderCalls = [];
  getOrderShouldFailFor = new Set();
  ordersById = new Map();
  orderCounter = 0;
}
resetMockBroker();

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
    if (url.endsWith("/clock")) {
      return new Response(JSON.stringify({ is_open: clockIsOpen }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: "500000",
          buying_power: "500000",
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
    if (url.includes("/orders") && init?.method === "DELETE") {
      const orderId = url.split("/orders/")[1]?.split("?")[0];
      deleteCalls.push(String(orderId));
      if (deleteShouldFailFor.has(String(orderId))) {
        return new Response(JSON.stringify({ message: "order not cancelable" }), { status: 422 });
      }
      return new Response(null, { status: 204 });
    }
    // Single-order GET (/orders/{id}) -- checked BEFORE the generic list GET
    // below, since both share the `/orders` prefix.
    const singleOrderMatch = url.match(/\/orders\/([^/?]+)(?:\?|$)/);
    if (singleOrderMatch && (!init?.method || init.method === "GET")) {
      const orderId = decodeURIComponent(singleOrderMatch[1]);
      getOrderCalls.push(orderId);
      if (getOrderShouldFailFor.has(orderId)) {
        return new Response(JSON.stringify({ message: "simulated broker outage" }), { status: 500 });
      }
      const order = ordersById.get(orderId);
      if (!order) return new Response(JSON.stringify({ message: "order not found" }), { status: 404 });
      return new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      // Generic open-orders LIST endpoint -- intentionally returns an array
      // (not a single order object) so fetchBrokerOrder's shape guard treats
      // any accidental match here as a malformed single-order response.
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

const { app, runScheduledSyncTickForTests } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");

async function setConfig(port: number, overrides: { stopLossPercent?: number; targetProfitPercent?: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: {
        autoTrading: false,
        runIntervalMins: 15,
        maxPositionSizePercent: 10,
        stopLossPercent: 5,
        targetProfitPercent: 15,
        ...overrides,
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

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3): position reconciliation
// now runs every sync cycle, comparing the local trade ledger against GET
// /positions -- which this file hardcodes to always return `[]` (this file's
// subject is order-STATUS polling, not position reconciliation). Once a test
// here actually marks an order "filled" (several deliberately do, to exercise
// the poller), the very next reconciliation sees a locally-held position with
// nothing on the (always-empty) mocked broker and latches block_new_buys --
// sticky by design (no auto-clear on a later clean comparison), so it would
// otherwise leak into every later test in this shared-db file. Reset it at
// the start of each test (harmless/idempotent when nothing is latched).
async function resetBreakerIfLatched(port: number) {
  await fetch(`http://127.0.0.1:${port}/api/breaker/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
  }).catch(() => {});
}

async function auditMessages(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit`);
  const events = (await res.json()) as any[];
  return events.map((e) => String(e.message));
}

function findTrade(symbol: string) {
  const store = createProductionStore(sqlitePath);
  const trade = store.listTradeIntents(500).find((tr) => tr.symbol === symbol && tr.side === "buy");
  store.close();
  return trade;
}

function backdateTradeTimestamp(tradeId: string, minutesAgo: number) {
  const store = createProductionStore(sqlitePath);
  const trade = store.getTradeIntentById(tradeId);
  assert.ok(trade, `expected a persisted trade for id ${tradeId}`);
  trade!.timestamp = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  store.saveTradeIntent(trade!);
  store.close();
}

// This test runs FIRST, deliberately, before any other test in this file
// creates a trade/leg that's left in a non-terminal, un-resolvable state
// (e.g. a deliberately-still-live leg for a fail-closed test). Every other
// test in this file shares one sqlite db/process (matching this codebase's
// existing test convention), so ordering here is what guarantees this test
// sees EXACTLY the 26 candidates it creates -- not 26 plus whatever earlier
// tests left pending.
test("poll cap: 26 pending orders in one cycle only polls 25 (oldest first), and the cap is logged", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  // Degenerate plan -> plain orders, no legs, so each buy contributes exactly
  // one pollable candidate (its own entry order).
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const brokerOrderIds: string[] = [];
  for (let i = 1; i <= 26; i++) {
    const symbol = `CAP${String(i).padStart(2, "0")}`;
    const buy = await placeOrder(port, { symbol, qty: 1, side: "buy", price: 10 });
    assert.equal(buy.body.trade.status, "Accepted", `${symbol}: ${JSON.stringify(buy.body)}`);
    brokerOrderIds.push(buy.body.trade.brokerOrderId);
  }
  // Mark every one of the 26 orders filled at the broker BEFORE polling, so
  // whichever 25 get polled this cycle immediately resolve to a terminal
  // state -- this test must not leave lingering pollable candidates behind
  // for every OTHER test in this file (which shares one process/db).
  for (const id of brokerOrderIds) {
    const order = ordersById.get(id)!;
    order.status = "filled";
    order.filled_qty = "1";
  }

  getOrderCalls = [];
  const sync = await runSync(port);

  assert.equal(getOrderCalls.length, 25, `expected exactly 25 single-order polls, got: ${getOrderCalls.length}`);

  const logLines: string[] = (sync.logs || []).map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /capped/i.test(line) && /26/.test(line) && /25/.test(line)),
    `expected a cap log line mentioning 26 candidates / 25 polled, got: ${JSON.stringify(logLines)}`,
  );

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /capped/i.test(m) && /26/.test(m) && /25/.test(m)),
    `expected an audited cap event, got: ${JSON.stringify(messages)}`,
  );

  // Drain the one remaining (uncapped-out) candidate so this test leaves
  // ZERO pollable candidates behind for the rest of the file.
  await runSync(port);
});

test("Accepted -> poll returns filled: local state becomes Filled, quantities recorded, and the transition is audited", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  // Degenerate exit plan -> plain (non-bracket) order, so this test isolates
  // the trade's OWN order-status polling from bracket-leg polling.
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "FILLME", qty: 5, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const brokerOrderId = buy.body.trade.brokerOrderId as string;

  const order = ordersById.get(brokerOrderId)!;
  order.status = "filled";
  order.filled_qty = "5";
  order.filled_avg_price = "101";

  await runSync(port);

  const trade = findTrade("FILLME");
  assert.ok(trade, "expected a persisted trade for FILLME");
  assert.equal(trade!.status, "Filled");
  assert.equal(trade!.filledQty, 5);
  assert.equal(trade!.remainingQty, 0);

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /FILLME/.test(m) && /Accepted -> Filled/.test(m)),
    `expected an audited Accepted -> Filled transition, got: ${JSON.stringify(messages)}`,
  );
});

test("partial fill, young: quantities are tracked and no cancel is issued", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "PARTY", qty: 10, side: "buy", price: 50 });
  const brokerOrderId = buy.body.trade.brokerOrderId as string;
  const order = ordersById.get(brokerOrderId)!;
  order.status = "partially_filled";
  order.filled_qty = "4";

  await runSync(port);

  const trade = findTrade("PARTY");
  assert.equal(trade!.status, "PartiallyFilled");
  assert.equal(trade!.filledQty, 4);
  assert.equal(trade!.remainingQty, 6);
  assert.equal(deleteCalls.includes(brokerOrderId), false, "a young partial fill must not be canceled");

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /PARTY/.test(m) && /4\/10 filled/.test(m) && /6 remaining/.test(m)),
    `expected an audited partial-fill quantity message, got: ${JSON.stringify(messages)}`,
  );
});

test("partial fill, stale (>30 min): remainder is canceled, position size adjusted to the filled amount, and it is audited", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "STALEP", qty: 10, side: "buy", price: 50 });
  const tradeId = buy.body.trade.id as string;
  const brokerOrderId = buy.body.trade.brokerOrderId as string;
  const order = ordersById.get(brokerOrderId)!;
  order.status = "partially_filled";
  order.filled_qty = "3";

  backdateTradeTimestamp(tradeId, 40);

  await runSync(port);

  assert.ok(deleteCalls.includes(brokerOrderId), `expected the stale partial's remainder to be DELETE-canceled, got: ${JSON.stringify(deleteCalls)}`);

  const trade = findTrade("STALEP");
  assert.equal(trade!.qty, 3, "position size must be adjusted down to the confirmed filled amount");
  assert.equal(trade!.remainingQty, 0);

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /STALEP/.test(m) && /older than 30 min/.test(m) && /remainder canceled/.test(m) && /3\/10/.test(m)),
    `expected an audited stale-partial cancellation with quantities, got: ${JSON.stringify(messages)}`,
  );
});

test("poll returns rejected: local state updates to Rejected", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "REJME", qty: 1, side: "buy", price: 20 });
  const brokerOrderId = buy.body.trade.brokerOrderId as string;
  ordersById.get(brokerOrderId)!.status = "rejected";

  await runSync(port);

  const trade = findTrade("REJME");
  assert.equal(trade!.status, "Rejected");
});

test("poll returns canceled: local state updates to Canceled", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "CANCME", qty: 1, side: "buy", price: 20 });
  const brokerOrderId = buy.body.trade.brokerOrderId as string;
  ordersById.get(brokerOrderId)!.status = "canceled";

  await runSync(port);

  const trade = findTrade("CANCME");
  assert.equal(trade!.status, "Canceled");
});

test("poll fetch failure (500): local state is unchanged, lastPollError is recorded and logged, never a fill", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "TIMEOUTME", qty: 1, side: "buy", price: 20 });
  const brokerOrderId = buy.body.trade.brokerOrderId as string;
  getOrderShouldFailFor.add(brokerOrderId);

  const sync = await runSync(port);

  const trade = findTrade("TIMEOUTME");
  assert.equal(trade!.status, "Accepted", "state must be unchanged after a poll failure -- never invent a fill");
  assert.notEqual(trade!.status, "Filled");
  assert.ok(trade!.lastPollError, "expected lastPollError to be recorded");

  const logLines: string[] = (sync.logs || []).map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /TIMEOUTME/.test(line) && /(fail|unchanged)/i.test(line)),
    `expected a log line about the poll failure, got: ${JSON.stringify(logLines)}`,
  );
});

test('poll returns {status:"filled"} with missing filled_qty: state unchanged + lastPollError (stays pollable); next well-formed poll resolves to Filled with correct quantities', async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "NOQTY", qty: 4, side: "buy", price: 25 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const brokerOrderId = buy.body.trade.brokerOrderId as string;

  // Malformed-but-200 broker response: a fill-implying status with NO usable
  // filled_qty. Accepting this at face value would record the internally
  // inconsistent (and, because terminal states are never re-polled,
  // permanently frozen) filledQty:0 / remainingQty:4 / status:Filled.
  const order = ordersById.get(brokerOrderId)!;
  order.status = "filled";
  delete (order as any).filled_qty;

  const sync = await runSync(port);

  let trade = findTrade("NOQTY");
  assert.equal(trade!.status, "Accepted", "a fill-implying status with unparsable filled_qty must not advance local state");
  assert.equal(trade!.filledQty, undefined, "no quantity may be invented from a malformed response");
  assert.ok(trade!.lastPollError, "expected lastPollError to be recorded");
  assert.match(String(trade!.lastPollError), /filled_qty/);

  const logLines: string[] = (sync.logs || []).map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /NOQTY/.test(line) && /filled_qty/.test(line)),
    `expected a log line about the unusable fill response, got: ${JSON.stringify(logLines)}`,
  );

  // The order stayed pollable, so the next well-formed response self-corrects.
  order.filled_qty = "4";
  order.filled_avg_price = "25.10";

  await runSync(port);

  trade = findTrade("NOQTY");
  assert.equal(trade!.status, "Filled");
  assert.equal(trade!.filledQty, 4);
  assert.equal(trade!.remainingQty, 0);
  assert.equal(trade!.lastPollError, undefined, "lastPollError must clear once a poll succeeds");
});

test("filled TP leg discovered: exit closed broker-side is recorded + audited, and a later sell skips the now-terminal leg (no DELETE)", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, {});

  const buy = await placeOrder(port, { symbol: "TPFILL", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2, "sanity: bracket buy should have two legs");
  const tpLegId = legIds.find((id) => id.endsWith("-leg-tp"))!;
  const slLegId = legIds.find((id) => id.endsWith("-leg-sl"))!;
  assert.ok(tpLegId && slLegId);

  const tpOrder = ordersById.get(tpLegId)!;
  tpOrder.status = "filled";
  tpOrder.filled_avg_price = "115";

  await runSync(port);

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /broker-side exit filled/.test(m) && /take-profit/.test(m) && /115/.test(m) && /TPFILL/.test(m)),
    `expected a broker-side-exit-filled audit message, got: ${JSON.stringify(messages)}`,
  );

  const trade = findTrade("TPFILL");
  assert.equal(trade!.brokerLegStates?.[tpLegId], "Filled");
  assert.ok(trade!.exitClosedBrokerSide, "expected exitClosedBrokerSide to be recorded on the entry trade");

  // A subsequent sell must not DELETE the already-terminal TP leg.
  deleteCalls = [];
  const sell = await placeOrder(port, { symbol: "TPFILL", qty: 1, side: "sell", price: 116 });
  assert.equal(sell.body.trade.status, "Accepted", JSON.stringify(sell.body));
  assert.equal(deleteCalls.includes(tpLegId), false, "the already-terminal TP leg must not receive a DELETE");
  assert.ok(deleteCalls.includes(slLegId), "the still-live SL leg must still be canceled before the sell");
});

test('422 "not cancelable" on a believed-live leg: re-polling once confirms it is actually terminal, and the sell proceeds without failing closed', async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, {});

  const buy = await placeOrder(port, { symbol: "R422OK", qty: 1, side: "buy", price: 100 });
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  const tpLegId = legIds.find((id) => id.endsWith("-leg-tp"))!;
  const slLegId = legIds.find((id) => id.endsWith("-leg-sl"))!;

  // The broker will reject the DELETE for the SL leg as "not cancelable"
  // (e.g. it was already OCO-canceled when the TP leg filled), and a re-poll
  // of that same leg confirms it is indeed terminal (canceled) already.
  deleteShouldFailFor.add(slLegId);
  ordersById.get(slLegId)!.status = "canceled";

  getOrderCalls = [];
  const sell = await placeOrder(port, { symbol: "R422OK", qty: 1, side: "sell", price: 110 });

  assert.ok(deleteCalls.includes(tpLegId), "expected the live TP leg to be canceled normally");
  assert.ok(deleteCalls.includes(slLegId), "expected a DELETE attempt for the SL leg (which came back 422)");
  assert.ok(getOrderCalls.includes(slLegId), "expected a single-order re-poll of the SL leg after its 422");

  assert.equal(sell.status, 200, JSON.stringify(sell.body));
  assert.equal(sell.body.trade.status, "Accepted", JSON.stringify(sell.body));
  assert.equal(sell.body.success, true);
  assert.equal(sell.body.orderPlaced, true, "the sell must actually reach the broker once the leg is confirmed terminal");

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /R422OK/.test(m) && /already terminal/.test(m) && new RegExp(slLegId).test(m)),
    `expected an audit event about the leg being confirmed terminal via re-poll, got: ${JSON.stringify(messages)}`,
  );

  const trade = findTrade("R422OK");
  assert.equal(trade!.brokerLegStates?.[slLegId], "Canceled");
});

test('422 "not cancelable" on a leg that re-polls as STILL live: fails closed exactly as before (no sell)', async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  await setConfig(port, {});

  const buy = await placeOrder(port, { symbol: "R422LIVE", qty: 1, side: "buy", price: 100 });
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  const slLegId = legIds.find((id) => id.endsWith("-leg-sl"))!;

  deleteShouldFailFor.add(slLegId);
  // Re-poll shows the leg is STILL live (accepted, the default) -- the
  // cancel must fail closed, same as before Task 5.
  ordersById.get(slLegId)!.status = "accepted";

  postedOrders = [];
  const sell = await placeOrder(port, { symbol: "R422LIVE", qty: 1, side: "sell", price: 110 });

  const sellPost = postedOrders.find((o) => o.body.symbol === "R422LIVE" && o.body.side === "sell");
  assert.equal(sellPost, undefined, "the sell must be skipped when the re-polled leg is still live");
  assert.notEqual(sell.status, 200, JSON.stringify(sell.body));
  assert.notEqual(sell.body.success, true);
});

test("the poller also runs on a REDUCED (scheduled, market-closed) cycle -- order-status truth is not gated on the ingestion/analysis loop", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  await resetBreakerIfLatched(port);
  t.after(() => listener.close());
  t.after(() => {
    clockIsOpen = true;
  });
  // The scheduler tick only invokes a cycle at all when autoTrading is on
  // (see server.ts's scheduler wiring) -- this is a real config write, not
  // the shared setConfig() helper, since that helper hardcodes autoTrading
  // false for the rest of this file's manual-override-driven tests.
  const configRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: true, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 0, targetProfitPercent: 0 },
    }),
  });
  assert.equal(configRes.status, 200);

  const buy = await placeOrder(port, { symbol: "REDUCED1", qty: 2, side: "buy", price: 30 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const brokerOrderId = buy.body.trade.brokerOrderId as string;
  const order = ordersById.get(brokerOrderId)!;
  order.status = "filled";
  order.filled_qty = "2";

  clockIsOpen = false;
  await runScheduledSyncTickForTests();

  const logs = await (await fetch(`http://127.0.0.1:${port}/api/logs`)).json() as any[];
  const messages: string[] = logs.map((l) => l.message);
  assert.ok(
    messages.some((m) => /market closed/i.test(m) && /skip/i.test(m)),
    `sanity: expected this to actually be a reduced cycle, got: ${JSON.stringify(messages)}`,
  );

  const trade = findTrade("REDUCED1");
  assert.equal(trade!.status, "Filled", "the poller must still resolve order status on a reduced/market-closed cycle");
  assert.equal(trade!.filledQty, 2);
});
