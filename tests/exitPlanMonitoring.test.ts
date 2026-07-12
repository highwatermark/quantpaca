import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-exitplan-test-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
// Force the simulated/unconfigured broker path deterministically, regardless of any
// real Alpaca credentials in a local .env file (same reasoning as symbolCooldown.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
// This file's tests share one simulated portfolio/day across many buy+sell
// pairs; raise the (pre-existing, already-configurable) daily trade cap so a
// later test in the file isn't spuriously RiskRejected by an earlier test's
// trade volume. Not a new env var -- see src/server/riskLimits.ts.
process.env.QUANTPACA_MAX_DAILY_TRADES = "100";

// This test drives /api/sync end-to-end (pattern: syncFallbackRemoval.test.ts /
// whipsawGateIntegration.test.ts), not a pure function in isolation. Two
// downstream legs of /api/sync (Gmail ingestion, Claude web search) would
// otherwise make live network calls; intercept them to fail closed so this
// test stays hermetic and focused purely on MODULE 2 (the portfolio risk
// controller), which runs before either of those legs.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    throw new Error("Simulated Claude API failure (test isolation: no live network calls).");
  }
  if (typeof url === "string" && url.includes("gmail.googleapis.com")) {
    return new Response("Simulated Gmail outage (test isolation: no live network calls).", { status: 500 });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");

const ADMIN_TOKEN = "test-admin-token-0123456789";
const dbJsonPath = path.join(dataDir, "db.json");
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function setAutoTrading(port: number, enabled: boolean) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: {
        autoTrading: enabled,
        runIntervalMins: 15,
        maxPositionSizePercent: 10,
        stopLossPercent: 5,
        targetProfitPercent: 15,
      },
    }),
  });
  assert.equal(res.status, 200);
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

function readDbJson() {
  return JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
}

function writeDbJson(db: any) {
  fs.writeFileSync(dbJsonPath, JSON.stringify(db, null, 2), "utf8");
}

// Directly mutates the simulated position's current_price/unrealized_plpc between
// the buy and the sync -- simulates the market having moved without needing a
// second broker round trip (there is no live broker in these tests; the local
// simulated portfolio is the "market" this monitoring loop reads from).
function setSimulatedMarketState(symbol: string, currentPrice: number, unrealizedPlPercent: number) {
  const db = readDbJson();
  const pos = (db.simulatedPortfolio.positions || []).find((p: any) => p.symbol === symbol);
  assert.ok(pos, `expected a simulated position for ${symbol}`);
  pos.current_price = String(currentPrice);
  pos.unrealized_plpc = String(unrealizedPlPercent / 100);
  writeDbJson(db);
}

// Injects a position directly into the simulated portfolio, bypassing the trade
// pipeline entirely -- simulates a manual buy or pre-existing position that was
// never routed through executeTradeIntent, so it has no persisted exit plan.
function injectUnplannedPosition(symbol: string, qty: number, currentPrice: number, unrealizedPlPercent: number) {
  const db = readDbJson();
  db.simulatedPortfolio.positions = db.simulatedPortfolio.positions || [];
  db.simulatedPortfolio.positions.push({
    symbol,
    qty: String(qty),
    market_value: String(qty * currentPrice),
    cost_basis: String(qty * currentPrice),
    unrealized_pl: "0.00",
    unrealized_plpc: String(unrealizedPlPercent / 100),
    current_price: String(currentPrice),
    avg_entry_price: String(currentPrice),
  });
  writeDbJson(db);
}

function futureIso(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso() {
  return new Date(Date.now() - 60_000).toISOString();
}

test("take-profit: a plan with takeProfitPrice below the current price closes the position", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  const buy = await placeOrder(port, { symbol: "TPRO", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted");

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveExitPlan(buy.body.trade.id, {
    initialStopLossPrice: 50,
    takeProfitPrice: 90,
    timeExitAt: futureIso(30),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.close();

  const sync = await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "TPRO" && tr.side === "sell");
  assert.ok(exitTrade, `expected a sell trade closing TPRO, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);
  assert.match(exitTrade.reasoning, /take_profit/);
});

test("time exit: a plan with timeExitAt in the past closes the position", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  const buy = await placeOrder(port, { symbol: "TIMEX", qty: 1, side: "buy", price: 50 });
  assert.equal(buy.body.trade.status, "Accepted");

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveExitPlan(buy.body.trade.id, {
    initialStopLossPrice: 10,
    takeProfitPrice: 500,
    timeExitAt: pastIso(),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.close();

  await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "TIMEX" && tr.side === "sell");
  assert.ok(exitTrade, "expected a sell trade closing TIMEX on a past timeExitAt");
  assert.match(exitTrade.reasoning, /time_exit/);
});

test("plan stop-loss: a plan stop above the current price closes the position without needing the legacy 5% check", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  const buy = await placeOrder(port, { symbol: "PSTOP", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted");
  // Position stays at 0% unrealized P/L -- well above the legacy -5% threshold.

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveExitPlan(buy.body.trade.id, {
    initialStopLossPrice: 110, // above the current price of 100
    takeProfitPrice: 500,
    timeExitAt: futureIso(30),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.close();

  await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "PSTOP" && tr.side === "sell");
  assert.ok(exitTrade, "expected a sell trade closing PSTOP on the plan's own stop-loss");
  assert.match(exitTrade.reasoning, /stop_loss/);
});

test("no-plan fallback: a position with no persisted plan still closes via the legacy 5% check", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  injectUnplannedPosition("NOPLAN", 1, 94, -6);

  await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "NOPLAN" && tr.side === "sell");
  assert.ok(exitTrade, "expected the legacy stop-loss to close a planless position past -5%");
  assert.match(exitTrade.reasoning, /stop-loss/i);
});

test("not-triggered: a plan with all thresholds unmet does not close the position", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  const buy = await placeOrder(port, { symbol: "HOLDIT", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted");

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveExitPlan(buy.body.trade.id, {
    initialStopLossPrice: 10,
    takeProfitPrice: 500,
    timeExitAt: futureIso(30),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.close();
  // Also well outside the legacy -5% window, to prove neither path fires.
  setSimulatedMarketState("HOLDIT", 100, -1);

  await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "HOLDIT" && tr.side === "sell");
  assert.equal(exitTrade, undefined, "no exit should fire when no plan dimension is triggered");
});

test("per-position fail-closed: a corrupt plan is skipped and covered by the legacy check, while a valid plan next to it still exits", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);

  const corruptBuy = await placeOrder(port, { symbol: "CORRUPT", qty: 1, side: "buy", price: 100 });
  assert.equal(corruptBuy.body.trade.status, "Accepted");
  const validBuy = await placeOrder(port, { symbol: "VALID", qty: 1, side: "buy", price: 100 });
  assert.equal(validBuy.body.trade.status, "Accepted");

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveExitPlan(corruptBuy.body.trade.id, {
    initialStopLossPrice: 90,
    takeProfitPrice: "not-a-number", // corrupt: non-numeric
    timeExitAt: futureIso(30),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.saveExitPlan(validBuy.body.trade.id, {
    initialStopLossPrice: 10,
    takeProfitPrice: 110, // below the current price of 130 below -- triggers take_profit
    timeExitAt: futureIso(30),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.close();

  // CORRUPT: also breaches the legacy -5% threshold, so the fallback should fire.
  setSimulatedMarketState("CORRUPT", 94, -6);
  // VALID: moves above its takeProfitPrice.
  setSimulatedMarketState("VALID", 130, 30);

  const sync = await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];

  const corruptExit = trades.find((tr) => tr.symbol === "CORRUPT" && tr.side === "sell");
  assert.ok(corruptExit, "corrupt-plan symbol should still exit via the legacy fallback");
  assert.match(corruptExit.reasoning, /stop-loss/i);

  const validExit = trades.find((tr) => tr.symbol === "VALID" && tr.side === "sell");
  assert.ok(validExit, "valid-plan symbol next to the corrupt one should still exit on its own trigger");
  assert.match(validExit.reasoning, /take_profit/);

  const logLines: string[] = sync.logs.map((l: any) => `${l.message} ${l.details || ""}`);
  assert.ok(
    logLines.some((line) => /CORRUPT/.test(line) && /invalid/i.test(line)),
    `expected a log entry about the corrupt plan being skipped, got: ${JSON.stringify(logLines)}`,
  );
});

test("C1: a rejected trade's exit plan must not replace the live position's persisted plan", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);

  // First BUY reaches the broker (Accepted) and gets its own exit plan persisted
  // by executeTradeIntent -- entryPrice 100, so stop 95 / take-profit 115 (5%/15%
  // config set by setAutoTrading above).
  const buy1 = await placeOrder(port, { symbol: "GUARDX", qty: 1, side: "buy", price: 100 });
  assert.equal(buy1.body.trade.status, "Accepted");

  const storeAfterBuy1 = createProductionStore(sqlitePath);
  const planAfterBuy1 = storeAfterBuy1.latestBuySideExitPlanForSymbol("GUARDX");
  storeAfterBuy1.close();
  assert.equal(planAfterBuy1?.exitPlan.entryPrice, 100, "sanity: first plan was seeded from the first buy's price");
  assert.equal(planAfterBuy1?.exitPlan.takeProfitPrice, 115);

  // Second BUY for the same symbol is blocked by the (default 24h) per-symbol
  // cooldown -- RiskRejected, never reaches the broker. submitTradeThroughPipeline
  // still attaches a freshly-built exit plan to this rejected trade (entryPrice
  // 200 -- stop 190 / take-profit 230) even though the order was never placed.
  const buy2 = await placeOrder(port, { symbol: "GUARDX", qty: 1, side: "buy", price: 200 });
  assert.equal(buy2.body.trade.status, "RiskRejected");
  assert.match(buy2.body.trade.riskDecision.reason, /cooldown/i);

  // The persisted plan for GUARDX must still be the ORIGINAL (entryPrice 100)
  // plan -- the rejected trade's bogus plan must never have been saved.
  const storeAfterBuy2 = createProductionStore(sqlitePath);
  const planAfterBuy2 = storeAfterBuy2.latestBuySideExitPlanForSymbol("GUARDX");
  storeAfterBuy2.close();
  assert.equal(planAfterBuy2?.exitPlan.entryPrice, 100, "the rejected trade's plan must not overwrite the live position's plan");
  assert.equal(planAfterBuy2?.exitPlan.takeProfitPrice, 115);

  // Behavioral confirmation: a price of 116 is above the ORIGINAL plan's
  // take-profit (115) but below the bogus rejected-trade plan's take-profit
  // (230). If the bogus plan had leaked in, no exit would fire here.
  setSimulatedMarketState("GUARDX", 116, 16);
  const sync = await runSync(port);
  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = trades.find((tr) => tr.symbol === "GUARDX" && tr.side === "sell");
  assert.ok(exitTrade, `expected the ORIGINAL plan's take-profit to fire at 116, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);
  assert.match(exitTrade.reasoning, /take_profit/);
});

test("trailing stop: price rises then retraces across two sync cycles -- the HWM persists between cycles and the second cycle's sell carries trailing reasoning", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port, true);
  const buy = await placeOrder(port, { symbol: "TRAIL", qty: 2, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "Accepted", JSON.stringify(buy.body.trade.riskDecision));

  const rawStore = createProductionStore(sqlitePath);
  rawStore.saveExitPlan(buy.body.trade.id, {
    initialStopLossPrice: 50, // far below, so it never confounds the trailing-specific assertions below
    takeProfitPrice: 1000, // far above, ditto
    trailingStopPercent: 10,
    entryPrice: 100,
    timeExitAt: futureIso(30),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  });
  rawStore.close();

  // Cycle 1: price rises to 120 -- ratchets the HWM to 120 but doesn't trigger
  // (120 is above the trailing threshold of 120 * 0.9 = 108).
  setSimulatedMarketState("TRAIL", 120, 20);
  await runSync(port);
  const afterCycle1 = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  assert.equal(
    afterCycle1.find((tr) => tr.symbol === "TRAIL" && tr.side === "sell"),
    undefined,
    "no exit should fire on cycle 1 -- price is still above the trailing threshold",
  );

  // The HWM ratcheted during cycle 1 must be durably persisted (not just held
  // in server memory) -- verified via a freshly-opened store handle.
  const midCycleStore = createProductionStore(sqlitePath);
  const persistedRecord = midCycleStore.latestBuySideExitPlanForSymbol("TRAIL");
  midCycleStore.close();
  assert.equal(persistedRecord?.highWaterMark, 120, "the ratcheted HWM must be visible via a new store handle between cycles");

  // Cycle 2: price retraces to 107 -- below 120 * 0.9 = 108 -- the trailing exit fires.
  setSimulatedMarketState("TRAIL", 107, 7);
  const sync = await runSync(port);
  const afterCycle2 = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const exitTrade = afterCycle2.find((tr) => tr.symbol === "TRAIL" && tr.side === "sell");
  assert.ok(exitTrade, `expected a trailing-stop sell closing TRAIL on cycle 2, logs: ${JSON.stringify(sync.logs?.map((l: any) => l.message))}`);
  assert.match(exitTrade.reasoning, /trailing_stop hit: HWM 120\.00, threshold 108\.00.*current 107\.00/);
});
