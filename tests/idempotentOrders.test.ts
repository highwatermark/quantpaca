import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-idempotent-orders-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Real (mocked) Alpaca broker path -- Task 13 is specifically about the
// client_order_id carried on the live POST /orders call, so the dry-run
// (unconfigured broker) path is not exercised by this file's main scenario.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
// This file's whole point is submitting the SAME buy for the SAME symbol twice
// in a row -- the (unrelated, pre-existing) per-symbol cooldown gate would
// otherwise RiskRejected the second attempt before it ever reaches the broker,
// same reasoning as tests/portfolioExposureCap.test.ts overriding an unrelated cap.
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

// Mock Alpaca order book keyed by client_order_id -- models Alpaca's own
// idempotency: a second POST /orders with a client_order_id already on file is
// rejected with a 422 duplicate error rather than creating a second order; the
// existing order can still be fetched back via GET /orders:by_client_order_id.
let orderStore: Map<string, { id: string; status: string; filled_qty: string; client_order_id: string }>;
let postedClientOrderIds: string[];
let orderCounter: number;

function resetMockBroker() {
  orderStore = new Map();
  postedClientOrderIds = [];
  orderCounter = 0;
}
resetMockBroker();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("paper-api.alpaca.markets")) {
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
    if (url.includes("/orders:by_client_order_id")) {
      const clientOrderId = new URL(url).searchParams.get("client_order_id") || "";
      const existing = orderStore.get(clientOrderId);
      if (!existing) return new Response(JSON.stringify({ message: "order not found" }), { status: 404 });
      return new Response(JSON.stringify(existing), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      const clientOrderId = String(body.client_order_id || "");
      postedClientOrderIds.push(clientOrderId);

      const existing = orderStore.get(clientOrderId);
      if (existing) {
        // Real Alpaca behavior on a duplicate client_order_id: 422, not a
        // silent 200 echo. The caller is expected to resolve the existing
        // order via GET /orders:by_client_order_id.
        return new Response(
          JSON.stringify({ code: 40010001, message: "client_order_id must be unique" }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }

      orderCounter += 1;
      const order = { id: `bro-${orderCounter}`, status: "accepted", filled_qty: "0", client_order_id: clientOrderId };
      orderStore.set(clientOrderId, order);
      return new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } });
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

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("Task 13: resubmitting the same intent twice sends the identical client_order_id both times and results in exactly one broker order and one local trade record", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const first = await placeOrder(port, { symbol: "IDEMP", qty: 3, side: "buy", price: 50 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.trade.status, "Accepted", JSON.stringify(first.body));
  assert.ok(first.body.trade.clientOrderId, "expected the trade to carry a clientOrderId");

  const second = await placeOrder(port, { symbol: "IDEMP", qty: 3, side: "buy", price: 50 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.trade.status, "Accepted", JSON.stringify(second.body));

  // Same intent content -> the exact same client_order_id, both times.
  assert.equal(second.body.trade.clientOrderId, first.body.trade.clientOrderId);
  assert.equal(postedClientOrderIds.length, 2, "expected two POST /orders calls -- the actual resubmission reached the broker");
  assert.equal(
    postedClientOrderIds[0],
    postedClientOrderIds[1],
    "both POST /orders calls must carry the identical client_order_id",
  );

  // The mock Alpaca deduped the second POST (422) and the code resolved it via
  // GET /orders:by_client_order_id -- both attempts map to the SAME broker order,
  // and only one order was ever created broker-side.
  assert.equal(second.body.trade.brokerOrderId, first.body.trade.brokerOrderId);
  assert.equal(orderStore.size, 1, "the mock Alpaca must have created exactly one order across both attempts");

  // No double-record locally: exactly one trade_intents row maps to this
  // client_order_id, so Phase 2 reconciliation sees one local trade per broker order.
  const rawStore = createProductionStore(sqlitePath);
  const matching = rawStore.listTradeIntents(500).filter((tr) => tr.clientOrderId === first.body.trade.clientOrderId);
  rawStore.close();
  assert.equal(matching.length, 1, `expected exactly one local trade record, got: ${JSON.stringify(matching)}`);
  assert.equal(matching[0].brokerOrderId, first.body.trade.brokerOrderId);
});

test("Task 13: two genuinely different intents (different symbols) get different client_order_ids and both reach the broker as separate orders", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const a = await placeOrder(port, { symbol: "IDEMPA", qty: 1, side: "buy", price: 10 });
  const b = await placeOrder(port, { symbol: "IDEMPB", qty: 1, side: "buy", price: 10 });

  assert.equal(a.body.trade.status, "Accepted", JSON.stringify(a.body));
  assert.equal(b.body.trade.status, "Accepted", JSON.stringify(b.body));
  assert.notEqual(a.body.trade.clientOrderId, b.body.trade.clientOrderId);
  assert.notEqual(a.body.trade.brokerOrderId, b.body.trade.brokerOrderId);
  assert.equal(orderStore.size, 2, "two distinct intents must create two distinct broker orders");
});
