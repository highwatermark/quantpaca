import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-breaker-latch-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Real (mocked) Alpaca broker path -- needed so equity/last_equity come from a
// controllable /account response rather than the simulated portfolio, which never
// recomputes "equity" from trades and so can't manufacture a drawdown.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
// Peak established at 100000; a 15%+ drawdown from this baseline also lands in
// close_only territory once maxDrawdownFromBaselinePercent (15, default) is breached.
process.env.QUANTPACA_BASELINE_EQUITY = "100000";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

// Mutable account snapshot the mocked /account endpoint serves -- each phase of a
// test mutates `equity` to drive the breaker through evaluateBreaker's real
// threshold math (unchanged by this task; only the latch wrapping is new).
let account = {
  cash: "500000",
  buying_power: "500000",
  portfolio_value: "100000",
  equity: "100000",
  last_equity: "100000", // prior close held constant so only drawdown-from-peak/baseline moves
  long_market_value: "0",
  daytrade_count: 0,
};
let positionsFixture: unknown[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/account")) {
      return new Response(JSON.stringify(account), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/positions")) {
      return new Response(JSON.stringify(positionsFixture), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "bro-1", status: "accepted", filled_qty: "0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/assets/")) {
      // Phase 2 Task 3 tradability guard: always tradable/active here -- not
      // under test in this file.
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

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function resetBreaker(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/breaker/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
  });
  return { status: res.status, body: await res.json() as any };
}

test("breaker latch: trip -> escalate -> recovery does not unlatch -> reset clears when clear -> reset re-latches when still breached, sells always allowed", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Phase A: healthy account, establishes the peak at 100000.
  account.equity = "100000";
  positionsFixture = [];
  const buyA = await placeOrder(port, { symbol: "LATCHA", qty: 3, side: "buy", price: 100 });
  assert.equal(buyA.body.trade.status, "Accepted", JSON.stringify(buyA.body.trade.riskDecision));

  // Phase B: equity dips 12% off peak (>10% limit) -- trips block_new_buys.
  account.equity = "88000";
  const buyB = await placeOrder(port, { symbol: "LATCHB", qty: 1, side: "buy", price: 100 });
  assert.equal(buyB.body.trade.status, "RiskRejected");
  assert.match(buyB.body.trade.riskDecision.reason, /block_new_buys/);

  const auditAfterTrip = await (await fetch(`http://127.0.0.1:${port}/api/audit`)).json() as any[];
  const tripEvent = auditAfterTrip.find((e) => e.type === "breaker" && /tripped|latch/i.test(e.message));
  assert.ok(tripEvent, `expected a breaker trip audit event, got: ${JSON.stringify(auditAfterTrip.slice(0, 5))}`);
  assert.ok(tripEvent.details?.equity !== undefined, "trip audit event should carry equity numbers");

  // Phase C: equity worsens into baseline-drawdown close_only territory -- while
  // already latched at block_new_buys, this must ESCALATE (close_only wins), never
  // create a fresh independent latch.
  account.equity = "80000";
  const buyC = await placeOrder(port, { symbol: "LATCHC", qty: 1, side: "buy", price: 100 });
  assert.equal(buyC.body.trade.status, "RiskRejected");
  assert.match(buyC.body.trade.riskDecision.reason, /close_only/);

  const auditAfterEscalate = await (await fetch(`http://127.0.0.1:${port}/api/audit`)).json() as any[];
  const escalateEvent = auditAfterEscalate.find((e) => e.type === "breaker" && /escalat/i.test(e.message));
  assert.ok(escalateEvent, `expected a breaker escalation audit event, got: ${JSON.stringify(auditAfterEscalate.slice(0, 5))}`);

  // Phase D: equity recovers all the way back above every threshold. A fresh
  // evaluation right now would say "ok" -- the acceptance test for this task: buys
  // must remain blocked (and still at the escalated close_only severity) until an
  // explicit reset, regardless of equity recovery.
  account.equity = "100000";
  const buyD = await placeOrder(port, { symbol: "LATCHD", qty: 1, side: "buy", price: 100 });
  assert.equal(buyD.body.trade.status, "RiskRejected", "recovery must not silently re-enable buys");
  assert.match(buyD.body.trade.riskDecision.reason, /close_only/, "must still be latched at the escalated severity");

  // Sells are never gated by the breaker, latched or not.
  const sell = await placeOrder(port, { symbol: "LATCHA", qty: 1, side: "sell", price: 100 });
  assert.equal(sell.body.trade.status, "Accepted", JSON.stringify(sell.body.trade.riskDecision));

  // Reset while genuinely clear (equity still 100000, unbreached) -- latch clears
  // and a subsequent buy proceeds.
  const resetClear = await resetBreaker(port);
  assert.equal(resetClear.status, 200);
  assert.equal(resetClear.body.status, "ok");
  assert.equal(resetClear.body.reTripped, false);

  const buyE = await placeOrder(port, { symbol: "LATCHE", qty: 1, side: "buy", price: 100 });
  assert.equal(buyE.body.trade.status, "Accepted", JSON.stringify(buyE.body.trade.riskDecision));

  const auditAfterReset = await (await fetch(`http://127.0.0.1:${port}/api/audit`)).json() as any[];
  const resetEvent = auditAfterReset.find((e) => e.type === "breaker" && /reset/i.test(e.message) && e.actor === "admin_api");
  assert.ok(resetEvent, `expected a breaker reset audit event, got: ${JSON.stringify(auditAfterReset.slice(0, 5))}`);

  // Reset is not an override of reality: dip again, then reset while still
  // breached -- it must re-trip (and re-latch) immediately.
  account.equity = "80000";
  const resetStillBreached = await resetBreaker(port);
  assert.equal(resetStillBreached.status, 200);
  assert.notEqual(resetStillBreached.body.status, "ok");
  assert.equal(resetStillBreached.body.reTripped, true);

  const buyF = await placeOrder(port, { symbol: "LATCHF", qty: 1, side: "buy", price: 100 });
  assert.equal(buyF.body.trade.status, "RiskRejected", "reset while still breached must re-latch, not clear");
});

test("breaker latch: corrupt persisted latch state fails closed to block_new_buys even when fresh equity is healthy", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  account.equity = "100000"; // fresh evaluation right now would say "ok"
  positionsFixture = [];

  // This file's tests share one dataDir/sqlite (pattern: regimeChangeExit.test.ts),
  // and the previous test intentionally leaves the breaker latched at close_only.
  // Clear it (equity is healthy right now, so this reset genuinely clears) before
  // seeding the row this test's sabotage targets.
  const clear = await resetBreaker(port);
  assert.equal(clear.body.status, "ok", `expected a clean slate before the corrupt-state test, got: ${JSON.stringify(clear.body)}`);

  // Seed a breaker_states row via a normal healthy evaluation first.
  const seed = await placeOrder(port, { symbol: "CORPTSEED", qty: 1, side: "buy", price: 100 });
  assert.equal(seed.body.trade.status, "Accepted", JSON.stringify(seed.body.trade.riskDecision));

  // Sabotage the persisted latch shape via a second raw handle onto the same sqlite
  // file the running server uses (pattern: tests/symbolCooldown.test.ts /
  // tests/regimeChangeExit.test.ts). This is valid JSON with an internally
  // nonsensical `latch` value -- not a whole-row/table corruption -- to specifically
  // exercise applyBreakerLatch's structural fail-closed gate.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(sqlitePath);
  const row = raw.prepare("SELECT id, payload_json FROM breaker_states ORDER BY timestamp DESC LIMIT 1").get() as { id: string; payload_json: string };
  const payload = JSON.parse(row.payload_json);
  payload.latch = { latched: "yes-but-this-is-a-string-not-a-boolean" };
  raw.prepare("UPDATE breaker_states SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
  raw.close();

  const buy = await placeOrder(port, { symbol: "CORPTGUARD", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "RiskRejected", "corrupt latch state must fail closed, never silently approve");
  assert.match(buy.body.trade.riskDecision.reason, /block_new_buys/);

  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`)).json() as any[];
  const corruptEvent = audit.find((e) => e.type === "breaker" && /corrupt/i.test(JSON.stringify(e)));
  assert.ok(corruptEvent, `expected a logged corrupt-latch-state event, got: ${JSON.stringify(audit.slice(0, 5))}`);
});
