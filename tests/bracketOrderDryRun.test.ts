import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-bracket-dryrun-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
// Force the simulated/unconfigured broker path (pattern: exitPlanMonitoring.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";

const ADMIN_TOKEN = "test-admin-token-0123456789";

const { app } = await import("../server");

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("dry-run (unconfigured broker): a BUY with a valid exit plan fabricates a bracket-shaped response, including a legs array, for test fidelity", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const buy = await placeOrder(port, { symbol: "DRYBRK", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body));
  assert.ok(Array.isArray(buy.body.trade.brokerLegOrderIds), "expected the dry-run response's fabricated legs to be persisted on the trade");
  assert.equal(buy.body.trade.brokerLegOrderIds.length, 2);
});

test("dry-run (unconfigured broker): a SELL never fabricates bracket legs", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const buy = await placeOrder(port, { symbol: "DRYSELL", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted");

  const sell = await placeOrder(port, { symbol: "DRYSELL", qty: 1, side: "sell", price: 110 });
  assert.equal(sell.body.trade.status, "Accepted", JSON.stringify(sell.body));
  assert.equal(sell.body.trade.brokerLegOrderIds, undefined, "a SELL must never carry fabricated bracket legs");
});
