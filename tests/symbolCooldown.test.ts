import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-cooldown-test-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "24";
// Force the simulated/unconfigured broker path deterministically, regardless of any
// real Alpaca credentials present in a local .env file. dotenv.config() (called at
// server.ts import time) never overrides a key that already exists in process.env,
// even if the existing value is an empty string, so setting these here wins.
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";

const { app } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");

const ADMIN_TOKEN = "test-admin-token-0123456789";

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

test("second BUY for the same symbol within the cooldown window requires human approval", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const first = await placeOrder(port, { symbol: "COOL", qty: 1, side: "buy", price: 100 });
  assert.equal(first.body.trade.status, "Accepted");

  const second = await placeOrder(port, { symbol: "COOL", qty: 1, side: "buy", price: 100 });
  assert.equal(second.body.trade.status, "RiskRejected");
  assert.match(second.body.trade.riskDecision.reason, /cooldown/i);
});

test("a SELL for a symbol in cooldown is not blocked by cooldown", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const buy = await placeOrder(port, { symbol: "SELLOK", qty: 1, side: "buy", price: 50 });
  assert.equal(buy.body.trade.status, "Accepted"); // now in cooldown

  const sell = await placeOrder(port, { symbol: "SELLOK", qty: 1, side: "sell", price: 50 });
  assert.equal(sell.body.trade.status, "Accepted");
  assert.notEqual(sell.body.trade.riskDecision?.status, "requires_human_approval");
});

test("an expired cooldown entry does not block a new BUY", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Insert an already-expired cooldown directly via a second handle onto the same
  // sqlite file the running server uses, simulating a stale entry left over from a
  // prior window instead of waiting out a real 24h clock.
  const dbPath = path.join(dataDir, "quantpaca.sqlite");
  const rawStore = createProductionStore(dbPath);
  rawStore.saveCooldown({
    symbol: "STALE",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    reason: "test: pre-expired entry",
  });
  rawStore.close();

  const buy = await placeOrder(port, { symbol: "STALE", qty: 1, side: "buy", price: 20 });
  assert.equal(buy.body.trade.status, "Accepted");
});

test("a cooldown store read failure fails closed and rejects the BUY (not silently approved)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Break the store's cooldown query out from under the already-open server connection
  // (same WAL-mode sqlite file, a second handle) to simulate a read failure, then assert
  // the buy is rejected rather than proceeding as if no cooldowns exist. This is the last
  // test using this shared dataDir/app: dropping the table is a one-way break for the
  // remainder of this file's use of `app`, which is fine given test ordering.
  const dbPath = path.join(dataDir, "quantpaca.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.exec("DROP TABLE symbol_cooldowns");
  raw.close();

  const buy = await placeOrder(port, { symbol: "FAILCLOSED", qty: 1, side: "buy", price: 15 });
  assert.equal(buy.body.trade.status, "RiskRejected");
  assert.match(buy.body.trade.riskDecision.reason, /cooldown/i);
});

test("QUANTPACA_SYMBOL_COOLDOWN_HOURS=0 disables cooldown end to end", async (t) => {
  const disabledDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-cooldown-disabled-"));
  const prevDataDir = process.env.QUANTPACA_DATA_DIR;
  const prevHours = process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS;
  process.env.QUANTPACA_DATA_DIR = disabledDataDir;
  process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";
  // server.ts reads env once at module load, so exercise a fresh module instance.
  const mod = await import(`../server?disabled-cooldown-${Date.now()}`);
  process.env.QUANTPACA_DATA_DIR = prevDataDir;
  process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = prevHours;

  const listener = mod.app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const first = await placeOrder(port, { symbol: "NOCOOL", qty: 1, side: "buy", price: 10 });
  assert.equal(first.body.trade.status, "Accepted");

  const second = await placeOrder(port, { symbol: "NOCOOL", qty: 1, side: "buy", price: 10 });
  assert.equal(second.body.trade.status, "Accepted");
});
