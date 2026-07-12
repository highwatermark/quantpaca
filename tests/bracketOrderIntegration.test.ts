import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-bracket-orders-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Real (mocked) Alpaca broker path -- Task 4 is specifically about the
// order_class/take_profit/stop_loss fields carried on the live POST /orders
// call, so the dry-run (unconfigured broker) path is not the focus here (see
// bracketOrderDryRun.test.ts for that).
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
// Each test in this file buys a fresh symbol, but keep the cooldown out of
// the way regardless (pattern: idempotentOrders.test.ts).
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

let postedOrders: Array<{ clientOrderId: string; body: any }>;
let orderCounter: number;
// Symbols in this set get a 422 "bracket" rejection on their FIRST (bracket)
// POST /orders attempt, so the retry-with-suffix path can be exercised.
let bracketRejectSymbols: Set<string>;

function resetMockBroker() {
  postedOrders = [];
  orderCounter = 0;
  bracketRejectSymbols = new Set();
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
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      const clientOrderId = String(body.client_order_id || "");
      postedOrders.push({ clientOrderId, body });

      if (body.order_class === "bracket" && bracketRejectSymbols.has(body.symbol)) {
        return new Response(
          JSON.stringify({ code: 42210000, message: `invalid order_class "bracket": bracket orders are not supported for ${body.symbol}` }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }

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

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

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

async function auditMessages(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit`);
  const events = (await res.json()) as any[];
  return events.map((e) => String(e.message));
}

test("bracket entry: a BUY with a valid exit plan submits a broker-native bracket order with correctly rounded legs, and the returned leg ids are persisted on the trade", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setConfig(port, {});

  const buy = await placeOrder(port, { symbol: "BRKOK", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));

  const posted = postedOrders.find((o) => o.body.symbol === "BRKOK");
  assert.ok(posted, "expected a POST /orders call for BRKOK");
  assert.equal(posted!.body.order_class, "bracket");
  assert.equal(posted!.body.time_in_force, "gtc", "the whole bracket (entry + legs) must share one disclosed gtc time_in_force");
  assert.equal(posted!.body.type, "market");
  assert.equal(posted!.body.side, "buy");
  // Default 5%/15% plan on a $100 entry: stop 95.00, take-profit 115.00 -- both
  // already exact-tick, so rounding DOWN is a no-op here (tick precision is
  // covered exhaustively at the unit level in tests/bracketOrders.test.ts).
  assert.equal(Number(posted!.body.stop_loss?.stop_price), 95);
  assert.equal(Number(posted!.body.take_profit?.limit_price), 115);

  // The broker's returned `legs` array must be persisted on the trade record.
  assert.ok(Array.isArray(buy.body.trade.brokerLegOrderIds), "expected brokerLegOrderIds on the trade response");
  assert.equal(buy.body.trade.brokerLegOrderIds.length, 2);

  const rawStore = createProductionStore(sqlitePath);
  const persisted = rawStore.listTradeIntents(50).find((tr) => tr.symbol === "BRKOK");
  rawStore.close();
  assert.ok(persisted, "expected a persisted trade_intents row for BRKOK");
  assert.deepEqual(persisted!.brokerLegOrderIds, buy.body.trade.brokerLegOrderIds);
});

test("degenerate plan: a plan whose rounded stop/take-profit collapse (targetProfitPercent=0) falls back to a plain order and audits software-only protection", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // stopLossPercent 0 / targetProfitPercent 0 -> stop == take-profit == entry:
  // degenerate (take-profit must be STRICTLY > entry, stop STRICTLY < entry).
  await setConfig(port, { stopLossPercent: 0, targetProfitPercent: 0 });

  const buy = await placeOrder(port, { symbol: "BRKDEGEN", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));

  const posted = postedOrders.find((o) => o.body.symbol === "BRKDEGEN");
  assert.ok(posted, "expected a POST /orders call for BRKDEGEN");
  assert.equal(posted!.body.order_class, undefined, "a degenerate plan must never reach the broker as a bracket");
  assert.equal(posted!.body.time_in_force, "day", "the plain fallback keeps the pre-existing day time_in_force");
  assert.equal(postedOrders.filter((o) => o.body.symbol === "BRKDEGEN").length, 1, "no bracket attempt precedes the plain fallback for a validation failure");

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /BRKDEGEN/.test(m) && /software-only/i.test(m)),
    `expected an audit event noting software-only protection for BRKDEGEN, got: ${JSON.stringify(messages)}`,
  );
});

test("bracket rejection (422): a bracket order rejected by Alpaca retries once as a plain order with a -p suffixed client_order_id, and both attempts are audited", async (t) => {
  resetMockBroker();
  bracketRejectSymbols.add("BRK422");
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // The previous test left system config at stopLossPercent=0/targetProfitPercent=0
  // (degenerate on purpose, to force its own fallback) -- config persists across
  // tests in this file (one shared server/db instance), so restore a valid plan
  // here or this test's BUY would never attempt a bracket at all.
  await setConfig(port, {});

  const buy = await placeOrder(port, { symbol: "BRK422", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));

  const attempts = postedOrders.filter((o) => o.body.symbol === "BRK422");
  assert.equal(attempts.length, 2, "expected exactly two POST /orders attempts: bracket, then plain retry");
  assert.equal(attempts[0].body.order_class, "bracket");
  assert.equal(attempts[1].body.order_class, undefined, "the retry must be a plain order");
  assert.equal(attempts[1].clientOrderId, `${attempts[0].clientOrderId}-p`, "the retry client_order_id must be the original suffixed with -p");
  assert.notEqual(attempts[1].clientOrderId, attempts[0].clientOrderId, "the retry is a DIFFERENT order from the rejected bracket");

  assert.equal(buy.body.trade.clientOrderId, attempts[0].clientOrderId, "the trade record keeps the original (bracket) client_order_id");

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /BRK422/.test(m) && /reject/i.test(m)),
    `expected an audit event about the bracket rejection, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => /BRK422/.test(m) && /retr/i.test(m)),
    `expected an audit event about the plain retry, got: ${JSON.stringify(messages)}`,
  );
});

test("SELL orders never carry a bracket, even when a plan exists for the symbol", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setConfig(port, {});

  const buy = await placeOrder(port, { symbol: "BRKSELL", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));

  resetMockBrokerKeepCounter();

  const sell = await placeOrder(port, { symbol: "BRKSELL", qty: 1, side: "sell", price: 110 });
  assert.equal(sell.body.trade.status, "Accepted", JSON.stringify(sell.body));

  const sellPost = postedOrders.find((o) => o.body.symbol === "BRKSELL" && o.body.side === "sell");
  assert.ok(sellPost, "expected a POST /orders call for the SELL");
  assert.equal(sellPost!.body.order_class, undefined, "a SELL/liquidation must never carry order_class");
  assert.equal(sellPost!.body.time_in_force, "day");
  assert.equal(sellPost!.body.take_profit, undefined);
  assert.equal(sellPost!.body.stop_loss, undefined);

  function resetMockBrokerKeepCounter() {
    postedOrders = [];
  }
});
