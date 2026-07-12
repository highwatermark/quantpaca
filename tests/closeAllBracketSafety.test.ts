import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-closeall-bracket-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Real (mocked) Alpaca broker path -- this file is about live bracket legs
// interacting with the emergency close-all endpoint, which only exists with
// a configured broker (dry-run has no legs to cancel).
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const dbJsonPath = path.join(dataDir, "db.json");
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

let positionsFixture: unknown[] = [];
let postedOrders: Array<{ clientOrderId: string; body: any }>;
let deleteCalls: string[];
let deleteShouldFailFor: Set<string>;
let telegramMessages: string[];
let orderCounter: number;

function resetMockBroker() {
  positionsFixture = [];
  postedOrders = [];
  deleteCalls = [];
  deleteShouldFailFor = new Set();
  telegramMessages = [];
  orderCounter = 0;
}
resetMockBroker();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.telegram.org")) {
    const body = JSON.parse(String(init?.body || "{}"));
    telegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
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

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function closeAll(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/close-all`, {
    method: "POST",
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  return { status: res.status, body: (await res.json()) as any };
}

// Telegram config is persisted through stripPersistedSecrets (which blanks the
// botToken) on the /api/config route, so enable it by editing db.json directly.
function enableTelegramDirectly() {
  const db = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
  db.config.telegram = { botToken: "test-bot-token", chatId: "test-chat", enabled: true };
  fs.writeFileSync(dbJsonPath, JSON.stringify(db, null, 2), "utf8");
}

function positionFixture(symbol: string, qty: number, price: number) {
  return {
    symbol,
    qty: String(qty),
    market_value: String(qty * price),
    cost_basis: String(qty * price),
    unrealized_pl: "0.00",
    unrealized_plpc: "0.0000",
    current_price: String(price),
    avg_entry_price: String(price),
  };
}

test("close-all with a bracket-protected position: legs are canceled before the sell, both positions sold, and the response/alert honestly report 2 sold / 0 failed", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // BRCA gets a bracket (buy via the override path persists its legs); PLNA is
  // a pre-existing position with no local trade record -- no legs.
  const buy = await placeOrder(port, { symbol: "BRCA", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2, "sanity: the BRCA buy was placed as a bracket");

  enableTelegramDirectly();
  positionsFixture = [positionFixture("BRCA", 2, 100), positionFixture("PLNA", 1, 50)];
  postedOrders = [];
  telegramMessages = [];

  const result = await closeAll(port);
  assert.equal(result.status, 200, JSON.stringify(result.body));

  // Both bracket legs canceled...
  for (const legId of legIds) {
    assert.ok(deleteCalls.includes(legId), `expected DELETE /orders/${legId}, got: ${JSON.stringify(deleteCalls)}`);
  }
  // ...and both positions sold with plain market sells.
  const sells = postedOrders.filter((o) => o.body.side === "sell");
  assert.equal(sells.length, 2, `expected two sell POSTs, got: ${JSON.stringify(postedOrders.map((o) => o.body))}`);
  for (const sell of sells) {
    assert.equal(sell.body.order_class, undefined, "liquidation sells must stay plain");
  }

  // Honest reporting: 2 sold, 0 failed, per-symbol results.
  assert.equal(result.body.success, true, JSON.stringify(result.body));
  assert.equal(result.body.soldCount, 2);
  assert.equal(result.body.failedCount, 0);
  assert.equal(result.body.results.length, 2);
  assert.ok(result.body.results.every((r: any) => r.sold === true), JSON.stringify(result.body.results));

  // The Telegram alert names the real counts -- never the old unconditional
  // "All open paper positions have been sold" claim.
  const alert = telegramMessages.find((m) => /EMERGENCY CLOSE/i.test(m));
  assert.ok(alert, `expected an emergency-close Telegram alert, got: ${JSON.stringify(telegramMessages)}`);
  assert.match(alert!, /2/, "the alert must state how many positions were sold");
  assert.doesNotMatch(alert!, /All open paper positions have been sold/i);
});

test("close-all where a leg cancel fails: that symbol's sell is skipped and counted failed (audited), the other position still sells, and the response/alert say 1 sold / 1 failed", async (t) => {
  resetMockBroker();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const buy = await placeOrder(port, { symbol: "BRCB", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2);
  deleteShouldFailFor.add(legIds[0]);

  enableTelegramDirectly();
  positionsFixture = [positionFixture("BRCB", 1, 100), positionFixture("PLNB", 3, 40)];
  postedOrders = [];
  telegramMessages = [];

  const result = await closeAll(port);
  assert.equal(result.status, 200, JSON.stringify(result.body));

  // BRCB: cancel failed -> NO sell must reach the broker (fail closed; the
  // live bracket legs remain that position's protection).
  const brcbSell = postedOrders.find((o) => o.body.symbol === "BRCB" && o.body.side === "sell");
  assert.equal(brcbSell, undefined, "the bracket-protected symbol's sell must be skipped when its leg cancel fails");
  // PLNB: unaffected, sold.
  const plnbSell = postedOrders.find((o) => o.body.symbol === "PLNB" && o.body.side === "sell");
  assert.ok(plnbSell, "the other position must still be sold");

  // Honest reporting: 1 sold, 1 failed.
  assert.equal(result.body.success, false, JSON.stringify(result.body));
  assert.equal(result.body.soldCount, 1);
  assert.equal(result.body.failedCount, 1);
  const brcbResult = result.body.results.find((r: any) => r.symbol === "BRCB");
  assert.equal(brcbResult.sold, false);
  assert.match(String(brcbResult.reason || ""), /(cancel|leg)/i);

  // The failure is audited.
  const rawStore = createProductionStore(sqlitePath);
  const auditEvents = rawStore.listAuditEvents(500);
  rawStore.close();
  assert.ok(
    auditEvents.some((e) => /BRCB/.test(e.message) && /(cancel|leg)/i.test(e.message)),
    `expected an audited event about the failed leg cancel, got: ${JSON.stringify(auditEvents.map((e) => e.message))}`,
  );

  // The Telegram alert is honest about the partial outcome.
  const alert = telegramMessages.find((m) => /EMERGENCY CLOSE/i.test(m));
  assert.ok(alert, `expected an emergency-close Telegram alert, got: ${JSON.stringify(telegramMessages)}`);
  assert.match(alert!, /1 .*(fail|skip)/i, `the alert must state the failure count, got: ${alert}`);
  assert.doesNotMatch(alert!, /All open paper positions have been sold/i);
});
