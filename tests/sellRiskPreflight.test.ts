// Phase 2 final review, finding C2: an automated sell path (the software
// exit monitor, the automation SELL decision, emergency close-all) used to
// cancel a position's live bracket legs FIRST, then call executeTradeIntent
// -> reviewRisk, which could still reject the sell (daily loss / daily trade
// count / buying-power reserve are not side-gated -- a SELL can be rejected
// by them just like a BUY). That left a naked, unprotected position: the
// legs were already gone, and no new sell replaced them.
//
// This file exercises the fix (server.ts's sellRiskPreflight, wired in ahead
// of cancelBracketLegsBeforeSell in MODULE 2 -- the exit monitor):
//   1. When the pre-flight itself would reject the sell (daily trade count
//      cap reached), the leg cancel must never even be attempted -- no
//      DELETE, no sell, an honest skip log + audit.
//   2. A normal, non-rejected exit still cancels legs and sells, with an
//      alert that actually says "liquidated".
//   3. A sell that gets past the pre-flight (a gate OUTSIDE its narrow
//      daily-loss/trade-count/buying-power subset -- duplicate open order
//      protection here) but is still rejected by reviewRisk itself must
//      produce an honest FAILURE alert, never claim "liquidated" (this is
//      the C2 part-b status-aware-alert fix, exercised independently of the
//      pre-flight).
//
// Tests in this file share ONE sqlite db and run in DEFINITION ORDER
// (node:test's default within a file) -- the daily trade count accumulates
// across them deliberately (same convention as
// tests/orderStatusPolling.test.ts's 26-pending-orders test comment), so
// each test documents exactly what count it expects on entry.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-sell-preflight-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";
// Small, deliberate cap: BUY(1) + SELL(2) for the first (successful) test,
// BUY(3) for the second (duplicate-order-rejected) test -- its rejected SELL
// attempt still counts as trade #4 (appStore.appendTrade runs unconditionally
// in MODULE 2, regardless of the trade's final status) -- then BUY(5) for the
// third test brings the count to exactly the cap, so ITS triggered exit's
// pre-flight sees dailyTradeCount(5) >= cap(5) and skips before ever
// canceling a leg.
process.env.QUANTPACA_MAX_DAILY_TRADES = "5";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

let positionsFixture: unknown[] = [];
let openOrdersFixture: unknown[] = [];
let postedOrders: Array<{ clientOrderId: string; body: any }>;
let deleteCalls: string[];
let telegramMessages: string[];
let orderCounter: number;

function resetMockBroker() {
  positionsFixture = [];
  openOrdersFixture = [];
  postedOrders = [];
  deleteCalls = [];
  telegramMessages = [];
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

  if (url.includes("api.telegram.org")) {
    const body = JSON.parse(String(init?.body || "{}"));
    telegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
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
      const orderId = url.split("/orders/")[1]?.split("?")[0];
      deleteCalls.push(String(orderId));
      return new Response(null, { status: 204 });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify(openOrdersFixture), { status: 200, headers: { "content-type": "application/json" } });
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
const { withAppStore } = await import("./helpers/appStoreFixture");

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

function enableTelegramDirectly() {
  withAppStore(dataDir, (store) => {
    const config = store.getConfig();
    store.setConfig({ ...config, telegram: { botToken: "test-bot-token", chatId: "test-chat", enabled: true } });
  });
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

async function auditMessages(port: number): Promise<string[]> {
  const rawStore = createProductionStore(sqlitePath);
  const events = rawStore.listAuditEvents(500);
  rawStore.close();
  return events.map((e) => e.message);
}

let server: { close: () => void };
let port: number;

test.before(async () => {
  const l = app.listen(0);
  server = l;
  port = (l.address() as { port: number }).port;
  await setAutoTrading(port);
  // Telegram config is persisted through stripPersistedSecrets (which blanks
  // botToken) on the /api/config route -- must run AFTER setAutoTrading's own
  // POST /api/config call, or that later call's merge-then-strip would blank
  // the botToken this direct write just seeded.
  enableTelegramDirectly();
  await resetBreakerIfLatched(port);
});

test.after(() => {
  server.close();
});

test("1) successful software exit (well under the daily trade cap): legs canceled, sell submitted, alert says liquidated", async () => {
  resetMockBroker();

  const buy = await placeOrder(port, { symbol: "PFOK", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2, "sanity: bracket buy with two legs");

  // Drop the price well below the plan's stop-loss (95) to trigger MODULE 2.
  positionsFixture = [positionFixture("PFOK", 2, 80)];
  telegramMessages = [];
  deleteCalls = [];

  const sync = await runSync(port);

  for (const legId of legIds) {
    assert.ok(deleteCalls.includes(legId), `expected DELETE /orders/${legId}, got: ${JSON.stringify(deleteCalls)}`);
  }
  const sellPost = postedOrders.find((o) => o.body.symbol === "PFOK" && o.body.side === "sell");
  assert.ok(sellPost, `expected the liquidation sell to reach the broker, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);

  const alert = telegramMessages.find((m) => /PFOK/.test(m));
  assert.ok(alert, `expected a Telegram alert for PFOK, got: ${JSON.stringify(telegramMessages)}`);
  assert.match(alert!, /Automatically liquidated/i, `expected the success alert text, got: ${alert}`);
  assert.doesNotMatch(alert!, /SELL FAILED/i);
});

test("2) sell rejected by a gate OUTSIDE the pre-flight subset (duplicate open order): legs are still canceled (pre-flight did not fire), but the alert is an honest FAILURE, never 'liquidated'", async () => {
  resetMockBroker();

  const buy = await placeOrder(port, { symbol: "PFDUP", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2);

  positionsFixture = [positionFixture("PFDUP", 1, 80)];
  // A duplicate-open-order gate is OUTSIDE evaluateSellFatalRiskGates' subset
  // (daily loss / daily trade count / buying power) -- the pre-flight will
  // NOT catch this, so the cancel proceeds and the legs are gone before
  // reviewRisk's own duplicate-order check rejects the sell. This is exactly
  // the naked-position scenario the part-b alert-honesty fix protects
  // against: the alert must never claim "liquidated" here.
  openOrdersFixture = [{ id: "existing-open-sell", symbol: "PFDUP", side: "sell", qty: "1", status: "accepted" }];
  telegramMessages = [];
  deleteCalls = [];

  const sync = await runSync(port);

  for (const legId of legIds) {
    assert.ok(deleteCalls.includes(legId), `expected the legs to still be canceled (outside the pre-flight subset), got: ${JSON.stringify(deleteCalls)}`);
  }
  const sellPost = postedOrders.find((o) => o.body.symbol === "PFDUP" && o.body.side === "sell");
  assert.equal(sellPost, undefined, "the sell itself must have been rejected by reviewRisk before ever reaching the broker");

  const alert = telegramMessages.find((m) => /PFDUP/.test(m));
  assert.ok(alert, `expected a Telegram alert for PFDUP, got: ${JSON.stringify(telegramMessages)}`);
  assert.doesNotMatch(alert!, /Automatically liquidated/i, `must never claim liquidation for a rejected sell, got: ${alert}`);
  assert.match(alert!, /(FAILED|did NOT reach the broker)/i, `expected an honest failure alert, got: ${alert}`);

  const logLines: string[] = (sync.logs || []).map((l: any) => l.message);
  assert.ok(
    logLines.some((m) => /PFDUP/.test(m) && /FAILED/i.test(m)),
    `expected an honest failure log line, got: ${JSON.stringify(logLines)}`,
  );

  openOrdersFixture = [];
});

test("3) daily trade cap reached: the triggered exit's pre-flight fires BEFORE any leg cancel -- no DELETE, no sell, an honest skip log + audit", async () => {
  resetMockBroker();

  // Bring the day's trade count up to exactly the cap (5): after test 1
  // (BUY+SELL=2) and test 2 (BUY+rejected-SELL-attempt=2), the count is 4.
  // One more BUY brings it to 5 -- AT BUY TIME the count is still 4 (<5), so
  // this buy itself is approved normally.
  const buy = await placeOrder(port, { symbol: "PFCAP", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  const legIds: string[] = buy.body.trade.brokerLegOrderIds;
  assert.equal(legIds.length, 2);

  positionsFixture = [positionFixture("PFCAP", 1, 80)];
  telegramMessages = [];
  deleteCalls = [];
  postedOrders = [];

  const sync = await runSync(port);

  // The pre-flight must have fired BEFORE cancelBracketLegsBeforeSell was
  // ever called -- neither leg receives a DELETE.
  for (const legId of legIds) {
    assert.equal(deleteCalls.includes(legId), false, `expected NO DELETE for leg ${legId} (pre-flight should skip before any cancel), got: ${JSON.stringify(deleteCalls)}`);
  }
  const sellPost = postedOrders.find((o) => o.body.symbol === "PFCAP" && o.body.side === "sell");
  assert.equal(sellPost, undefined, "no sell may reach the broker when the pre-flight rejects it");

  const logLines: string[] = (sync.logs || []).map((l: any) => l.message);
  assert.ok(
    logLines.some((m) => /PFCAP/.test(m) && /risk gate/i.test(m) && /daily trade count/i.test(m)),
    `expected an honest pre-flight-skip log line naming the gate, got: ${JSON.stringify(logLines)}`,
  );

  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /PFCAP/.test(m) && /risk gate/i.test(m)),
    `expected an audited pre-flight-skip event, got: ${JSON.stringify(messages)}`,
  );
});

test("4) manual override SELL at the daily trade cap: the pre-flight fires BEFORE any leg cancel -- no DELETE, honest non-success response naming the gate, audited", async () => {
  // Depends on the accumulated state of tests 1-3 (documented in the module
  // comment): the daily trade count is at the cap (5), and PFCAP's bracket
  // legs from test 3 are STILL live (its pre-flight skipped the cancel). A
  // manual override sell of that same bracketed position must be stopped by
  // the same pre-flight -- the original C2 finding explicitly listed the
  // manual override sell among the affected paths.
  deleteCalls = [];
  postedOrders = [];

  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ symbol: "PFCAP", qty: 1, side: "sell", price: 80 }),
  });
  const body = (await res.json()) as any;

  // No leg DELETE may ever be issued when the sell would be rejected anyway.
  assert.equal(deleteCalls.length, 0, `expected NO DELETE calls (pre-flight must skip before any cancel), got: ${JSON.stringify(deleteCalls)}`);
  const sellPost = postedOrders.find((o) => o.body.symbol === "PFCAP" && o.body.side === "sell");
  assert.equal(sellPost, undefined, "no sell may reach the broker when the pre-flight rejects it");

  // Honest non-success response naming the gate.
  assert.equal(res.status, 422, `expected an honest non-2xx response, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.success, false);
  assert.match(String(body.details || ""), /risk gate/i);
  assert.match(String(body.reason || body.details || ""), /daily trade count/i, `expected the gate to be named, got: ${JSON.stringify(body)}`);
  assert.match(String(body.details || ""), /NOT canceled/i, "the response must state the legs were left in place");

  // Audited.
  const messages = await auditMessages(port);
  assert.ok(
    messages.some((m) => /Manual override SELL for PFCAP/i.test(m) && /risk gate/i.test(m)),
    `expected an audited manual-sell pre-flight-skip event, got: ${JSON.stringify(messages)}`,
  );
});
