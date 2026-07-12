import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-manual-override-sizing-test-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
// Force the simulated/unconfigured broker path deterministically (same reasoning as
// symbolCooldown.test.ts / portfolioExposureCap.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// A low exposure cap (20%) that stays well above the default per-position cap
// (10% of the $100,000 simulated equity = $10,000) so tests 1-2 below are bound
// by the per-position cap, not this one; test 3 raises the per-position cap so
// this exposure cap becomes the binding constraint instead.
process.env.QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT = "20";

const { app } = await import("../server");

const ADMIN_TOKEN = "test-admin-token-0123456789";

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function setMaxPositionSizePercent(port: number, percent: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: {
        autoTrading: false,
        runIntervalMins: 15,
        maxPositionSizePercent: percent,
        stopLossPercent: 5,
        targetProfitPercent: 15,
      },
    }),
  });
  assert.equal(res.status, 200);
}

test("Task 12: manual override BUY requesting more than the per-position cap is clamped to the cap, and the clamp is noted in the response", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Default maxPositionSizePercent is 10% of the $100,000 simulated equity =
  // $10,000 -> at $100/share, exactly 100 shares of executable room. Requesting
  // 500 shares (a $50,000 order, 5x the cap) must be clamped to exactly 100.
  const result = await placeOrder(port, { symbol: "CAPBUY", qty: 500, side: "buy", price: 100 });

  assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.trade.status, "Accepted", JSON.stringify(result.body));
  assert.equal(result.body.trade.qty, 100, "expected the trade to be clamped to exactly 100 shares");

  assert.ok(result.body.clamp, "expected an additive `clamp` field noting the clamp");
  assert.equal(result.body.clamp.requestedQty, 500);
  assert.equal(result.body.clamp.approvedQty, 100);
  assert.ok(
    result.body.clamp.capsApplied.includes("max_single_position"),
    `expected capsApplied to name max_single_position, got: ${JSON.stringify(result.body.clamp.capsApplied)}`,
  );
});

test("Task 12: manual override BUY that would leave zero room under caps is rejected, naming the cap -- no trade is created", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Consume the entire per-position cap first (100 shares @ $100 = $10,000 = 10%
  // of the $100,000 simulated equity, exactly the default cap).
  const seed = await placeOrder(port, { symbol: "ZEROROOM", qty: 100, side: "buy", price: 100 });
  assert.equal(seed.body.trade.status, "Accepted", JSON.stringify(seed.body));

  // A second buy of the same symbol now has exactly 0 remaining per-position room.
  const second = await placeOrder(port, { symbol: "ZEROROOM", qty: 1, side: "buy", price: 100 });

  assert.equal(second.status, 422, `expected 422, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.ok(second.body.error, "expected an error message");
  assert.match(
    JSON.stringify(second.body),
    /max_single_position/,
    `expected the rejection to name the max_single_position cap, got: ${JSON.stringify(second.body)}`,
  );
  assert.equal(second.body.trade, undefined, "no trade should be created when 0 qty is allowed");
});

test("Task 12: manual override SELL is unaffected by position/exposure caps -- qty passes through unclamped", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // A sell notional of $40,000 vastly exceeds the $10,000 per-position cap that
  // would apply to a BUY -- if caps were mistakenly applied to sells too, this
  // would be clamped to 100 shares. It must pass through unclamped instead.
  const result = await placeOrder(port, { symbol: "SELLCAP", qty: 400, side: "sell", price: 100 });

  assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.trade.status, "Accepted", JSON.stringify(result.body));
  assert.equal(result.body.trade.qty, 400, "sell qty must not be clamped by position/exposure caps");
  assert.equal(result.body.clamp, undefined, "no clamp should be recorded for a sell");
});

test("Task 12: manual override BUY on a portfolio near the exposure cap is clamped by exposure room, not per-position room", async (t) => {
  // Fresh data dir + fresh server module instance: the tests above already
  // consumed $20,000 of long_market_value on the shared `app`'s simulated
  // portfolio (CAPBUY + ZEROROOM), which would exhaust this file's 20%
  // exposure cap before this test even starts. Isolate this scenario the same
  // way symbolCooldown.test.ts's disabled-cooldown case does.
  const freshDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-manual-override-sizing-exposure-"));
  const prevDataDir = process.env.QUANTPACA_DATA_DIR;
  process.env.QUANTPACA_DATA_DIR = freshDataDir;
  const mod = await import(`../server?manual-override-exposure-${Date.now()}`);
  process.env.QUANTPACA_DATA_DIR = prevDataDir;

  const listener = mod.app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Raise the per-position cap so it cannot be the binding constraint; only the
  // env-loaded 20% portfolio exposure cap ($20,000) should be able to bind.
  await setMaxPositionSizePercent(port, 90);

  // Seed a $18,000 position (18% of equity) on a DIFFERENT symbol, leaving only
  // $2,000 of aggregate exposure room before the 20% cap is hit.
  const seed = await placeOrder(port, { symbol: "EXPA", qty: 180, side: "buy", price: 100 });
  assert.equal(seed.body.trade.status, "Accepted", JSON.stringify(seed.body));

  // Request a $10,000 buy (well within the now-90%-of-equity per-position cap,
  // and 0% pre-existing concentration on this new symbol) -- only the $2,000 of
  // remaining exposure room should bind, clamping this to exactly 20 shares.
  const result = await placeOrder(port, { symbol: "EXPB", qty: 100, side: "buy", price: 100 });

  assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.trade.qty, 20, "expected the trade to be clamped to exactly 20 shares by exposure room");
  assert.ok(result.body.clamp, "expected an additive `clamp` field noting the clamp");
  assert.equal(result.body.clamp.approvedQty, 20);
  assert.ok(
    result.body.clamp.capsApplied.includes("max_portfolio_exposure"),
    `expected capsApplied to name max_portfolio_exposure, got: ${JSON.stringify(result.body.clamp.capsApplied)}`,
  );
  assert.ok(
    !result.body.clamp.capsApplied.includes("max_single_position"),
    "the per-position cap must not be the reason this was clamped",
  );
});
