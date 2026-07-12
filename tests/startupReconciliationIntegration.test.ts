// Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation --
// full-server acceptance/orphan/admin-route tests, same style as
// tests/orderStatusPolling.test.ts and tests/tradabilityGuard.test.ts (a real
// app.listen() instance, a mocked Alpaca broker via globalThis.fetch, real
// SQLite persistence). See tests/startupReconciliation.test.ts for the
// module-level unit tests (pure functions + fake-deps orchestration) and
// tests/scheduler.test.ts for the scheduler-skip test (reuses that file's
// existing harness).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-startup-reconciliation-"));
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
const dbJsonPath = path.join(dataDir, "db.json");

type MockOrder = {
  id: string;
  symbol: string;
  status: string;
  filled_qty: string;
  client_order_id?: string;
};

const OPEN_STATUSES = new Set(["accepted", "new", "pending_new", "partially_filled"]);

let ordersById: Map<string, MockOrder>;
let orderCounter: number;
let failOpenOrdersFetch: boolean;
const sentTelegramMessages: string[] = [];

function resetMockBroker() {
  ordersById = new Map();
  orderCounter = 0;
  failOpenOrdersFetch = false;
}
resetMockBroker();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: "500000", buying_power: "500000", portfolio_value: "100000", equity: "100000",
          last_equity: "100000", long_market_value: "0", daytrade_count: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/positions")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/assets/")) {
      const symbol = url.split("/assets/")[1];
      return new Response(JSON.stringify({ symbol, tradable: true, status: "active" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/orders") && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/orders?status=open")) {
      if (failOpenOrdersFetch) return new Response(JSON.stringify({ message: "simulated outage" }), { status: 500 });
      const open = Array.from(ordersById.values()).filter((o) => OPEN_STATUSES.has(o.status));
      return new Response(
        JSON.stringify(open.map((o) => ({ id: o.id, symbol: o.symbol, client_order_id: o.client_order_id, status: o.status, qty: "1", side: "buy" }))),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Single-order GET (/orders/{id}) -- checked before the generic list GET.
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
      orderCounter += 1;
      const id = `bro-${orderCounter}`;
      const order: MockOrder = { id, symbol: body.symbol, status: "accepted", filled_qty: "0", client_order_id: body.client_order_id };
      ordersById.set(id, order);
      return new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unhandled paper-api.alpaca.markets path in test fixture", { status: 404 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app, runStartupReconciliationForTests } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");
const startupReconciliation = await import("../src/server/startupReconciliation");

async function setConfig(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: false, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 0, targetProfitPercent: 0 },
    }),
  });
  assert.equal(res.status, 200);
}

function enableTelegram() {
  const raw = fs.existsSync(dbJsonPath) ? JSON.parse(fs.readFileSync(dbJsonPath, "utf8")) : {};
  raw.config = { ...(raw.config || {}), telegram: { botToken: "test-telegram-bot-token", chatId: "test-chat-id", enabled: true } };
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(dbJsonPath, JSON.stringify(raw, null, 2), "utf8");
}

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function health(port: number) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as any;
}

function findTrade(symbol: string) {
  const store = createProductionStore(sqlitePath);
  const trade = store.listTradeIntents(500).find((tr) => tr.symbol === symbol && tr.side === "buy");
  store.close();
  return trade;
}

test("acceptance: an order accepted pre-crash is recovered into local state on restart, and tradingReady flips to true", async (t) => {
  resetMockBroker();
  startupReconciliation.__setStateForTest({ tradingReady: true, orphanOrders: [] });
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setConfig(port);

  // Pre-crash: the BUY was accepted by the broker while trading was ready.
  const buy = await placeOrder(port, { symbol: "RECOVER", qty: 5, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const brokerOrderId = buy.body.trade.brokerOrderId as string;

  // The broker actually filled it before/during the crash.
  const order = ordersById.get(brokerOrderId)!;
  order.status = "filled";
  order.filled_qty = "5";

  // Simulate a restart: reconciliation has not run yet this "boot".
  startupReconciliation.__setStateForTest({ tradingReady: false, orphanOrders: [] });
  assert.equal((await health(port)).startupReconciliation.tradingReady, false);

  await runStartupReconciliationForTests();

  const trade = findTrade("RECOVER");
  assert.ok(trade, "expected a persisted trade for RECOVER");
  assert.equal(trade!.status, "Filled", "the pre-crash Accepted trade must be recovered to Filled");

  const healthAfter = await health(port);
  assert.equal(healthAfter.startupReconciliation.tradingReady, true);
  assert.equal(healthAfter.startupReconciliation.hasUnresolvedOrphans, false);
});

// From here on, tests deliberately do NOT resetMockBroker() -- this file
// shares one SQLite store/process across all its tests (same convention as
// tests/orderStatusPolling.test.ts), so wiping the broker's order map out
// from under a PRIOR test's still-non-terminal local trade would turn its
// broker order 404 (poll failure) for every later reconciliation attempt.
// Any broker state a test adds purely for its own purposes (e.g. the manual
// orphan order below) is cleaned up at the end of that test instead.
test("orphan sweep: an unmatched open broker order blocks new BUYs and alerts Telegram; SELLs stay available; admin clear unblocks", async (t) => {
  sentTelegramMessages.length = 0;
  startupReconciliation.__setStateForTest({ tradingReady: false, orphanOrders: [] });
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setConfig(port);
  // Order matters: POST /api/config (setConfig) round-trips db.config through
  // stripPersistedSecrets, which always zeroes telegram.botToken -- this
  // direct db.json write must happen AFTER, or setConfig would immediately
  // wipe it back out (same reasoning as schedulerAutoPauseThreeFailures.test.ts's
  // enableTelegram comment).
  enableTelegram();

  // A manual order placed directly at the broker -- never went through this
  // system, so no local trade record references it.
  ordersById.set("bro-manual-1", { id: "bro-manual-1", symbol: "MANUAL", status: "accepted", filled_qty: "0", client_order_id: "human-placed-order" });

  await runStartupReconciliationForTests();

  const healthAfterSweep = await health(port);
  assert.equal(healthAfterSweep.startupReconciliation.tradingReady, true, "reconciliation itself succeeded");
  assert.equal(healthAfterSweep.startupReconciliation.hasUnresolvedOrphans, true);
  assert.equal(healthAfterSweep.startupReconciliation.orphanCount, 1);
  assert.ok(sentTelegramMessages.some((m) => /orphan/i.test(m)), `expected a Telegram orphan alert, got: ${JSON.stringify(sentTelegramMessages)}`);

  const blockedBuy = await placeOrder(port, { symbol: "ORPHTEST", qty: 1, side: "buy", price: 50 });
  assert.equal(blockedBuy.body.trade.status, "RiskRejected", JSON.stringify(blockedBuy.body));
  assert.match(blockedBuy.body.trade.riskDecision.reason, /orphan/i);

  const sell = await placeOrder(port, { symbol: "ORPHTEST", qty: 1, side: "sell", price: 50 });
  assert.notEqual(sell.body.trade.riskDecision?.reason, blockedBuy.body.trade.riskDecision.reason, "the orphan block must never apply to a sell");
  assert.doesNotMatch(String(sell.body.trade.riskDecision?.reason || ""), /orphan/i, "a sell must never be rejected for the orphan reason");

  const clearRes = await fetch(`http://127.0.0.1:${port}/api/reconciliation/orphans/clear`, {
    method: "POST",
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  assert.equal(clearRes.status, 200);
  const clearBody = (await clearRes.json()) as any;
  assert.equal(clearBody.cleared, 1);

  assert.equal((await health(port)).startupReconciliation.hasUnresolvedOrphans, false);
  const unblockedBuy = await placeOrder(port, { symbol: "ORPHTEST2", qty: 1, side: "buy", price: 50 });
  assert.equal(unblockedBuy.body.trade.status, "Accepted", JSON.stringify(unblockedBuy.body));

  // Clean up: this manual order was never resolved at the broker (clearing
  // only unblocks BUYs -- see the route's doc comment -- it never cancels
  // the underlying order), so leaving it in the shared mock broker would make
  // every later test's reconciliation sweep re-flag it as an orphan too. Real
  // life would have the same behavior across a real restart; this delete
  // just keeps this file's later tests isolated from it.
  ordersById.delete("bro-manual-1");
});

test("the orphans/clear admin route requires the admin token", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/reconciliation/orphans/clear`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("reconciliation fetch failure: tradingReady stays false, BUY rejected with an honest pending reason, SELL allowed; a subsequent successful attempt unblocks", async (t) => {
  startupReconciliation.__setStateForTest({ tradingReady: false, orphanOrders: [] });
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setConfig(port);

  failOpenOrdersFetch = true;
  await runStartupReconciliationForTests();

  assert.equal((await health(port)).startupReconciliation.tradingReady, false);

  const blockedBuy = await placeOrder(port, { symbol: "PENDTEST", qty: 1, side: "buy", price: 50 });
  assert.equal(blockedBuy.body.trade.status, "RiskRejected", JSON.stringify(blockedBuy.body));
  assert.match(blockedBuy.body.trade.riskDecision.reason, /pending/i);

  const sell = await placeOrder(port, { symbol: "PENDTEST", qty: 1, side: "sell", price: 50 });
  assert.doesNotMatch(String(sell.body.trade.riskDecision?.reason || ""), /pending/i, "a sell must never be blocked by pending reconciliation");

  // The broker connection recovers; a fresh attempt (standing in for the real
  // 5-minute retry, which is exercised at the unit level in
  // startupReconciliation.test.ts with a fake timer) now succeeds.
  failOpenOrdersFetch = false;
  await runStartupReconciliationForTests();

  assert.equal((await health(port)).startupReconciliation.tradingReady, true);
  const unblockedBuy = await placeOrder(port, { symbol: "PENDTEST2", qty: 1, side: "buy", price: 50 });
  assert.equal(unblockedBuy.body.trade.status, "Accepted", JSON.stringify(unblockedBuy.body));
});
