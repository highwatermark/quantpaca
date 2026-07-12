import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOpenPositionExits, ExitPlanRecord } from "../src/server/exitMonitor";
import { ExitPlan } from "../src/server/tradingSafety";

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function basePlan(overrides: Partial<ExitPlan> = {}): ExitPlan {
  return {
    initialStopLossPrice: 90,
    takeProfitPrice: 120,
    timeExitAt: FUTURE,
    thesisInvalidation: "ACME thesis invalidated.",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
    ...overrides,
  };
}

function planLookup(map: Record<string, ExitPlanRecord | undefined>) {
  return (symbol: string) => map[symbol];
}

test("take-profit: current price at/above takeProfitPrice triggers a plan exit with take_profit reasoning", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "AAA", qty: 10, currentPrice: 125, unrealizedPlPercent: 25 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({ AAA: { side: "buy", exitPlan: basePlan() } }),
  });
  assert.equal(result.planExits.length, 1);
  assert.equal(result.legacyExits.length, 0);
  assert.equal(result.planExits[0].reason, "take_profit");
  assert.match(result.planExits[0].reasoning, /take_profit hit: target 120\.00, current 125\.00/);
  assert.equal(result.planExits[0].qty, 10);
});

test("time exit: timeExitAt in the past triggers regardless of price", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "BBB", qty: 5, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({ BBB: { side: "buy", exitPlan: basePlan({ timeExitAt: PAST }) } }),
  });
  assert.equal(result.planExits.length, 1);
  assert.equal(result.planExits[0].reason, "time_exit");
  assert.equal(result.legacyExits.length, 0);
});

test("plan stop-loss: current price at/below the plan's stop triggers stop_loss and skips the legacy check", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "CCC", qty: 3, currentPrice: 89, unrealizedPlPercent: -1 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({ CCC: { side: "buy", exitPlan: basePlan({ initialStopLossPrice: 90 }) } }),
  });
  assert.equal(result.planExits.length, 1);
  assert.equal(result.planExits[0].reason, "stop_loss");
  assert.equal(result.legacyExits.length, 0);
});

test("no plan: falls back to the legacy percent check and fires when breached", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "DDD", qty: 4, currentPrice: 94, unrealizedPlPercent: -6 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({}),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.legacyExits.length, 1);
  assert.equal(result.legacyExits[0].kind, "legacy_stop_loss");
  assert.match(result.legacyExits[0].reasoning, /-6\.00%/);
});

test("no plan and legacy threshold not breached: no exit at all", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "EEE", qty: 4, currentPrice: 99, unrealizedPlPercent: -1 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({}),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.legacyExits.length, 0);
});

test("plan present but nothing triggered: no exit, and the legacy check is NOT consulted even if it would have fired", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "FFF", qty: 2, currentPrice: 100, unrealizedPlPercent: -9 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({ FFF: { side: "buy", exitPlan: basePlan({ initialStopLossPrice: 50, takeProfitPrice: 200 }) } }),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.legacyExits.length, 0, "legacy check must be skipped entirely when a valid plan is present");
});

test("fail-closed: a plan with a non-numeric takeProfitPrice is skipped, logged, and falls back to the legacy check", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "GGG", qty: 1, currentPrice: 100, unrealizedPlPercent: -7 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      GGG: { side: "buy", exitPlan: basePlan({ takeProfitPrice: "not-a-number" as unknown as number }) },
    }),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.skippedPlans.length, 1);
  assert.match(result.skippedPlans[0].message, /takeProfitPrice/);
  assert.equal(result.legacyExits.length, 1, "legacy fallback must still run for the symbol with a corrupt plan");
});

test("fail-closed: a plan lookup that throws is caught per-symbol and does not abort other symbols", () => {
  const result = evaluateOpenPositionExits({
    positions: [
      { symbol: "HHH", qty: 1, currentPrice: 100, unrealizedPlPercent: -9 },
      { symbol: "III", qty: 1, currentPrice: 130, unrealizedPlPercent: 30 },
    ],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: (symbol: string) => {
      if (symbol === "HHH") throw new Error("store unavailable");
      return { side: "buy", exitPlan: basePlan({ takeProfitPrice: 120 }) };
    },
  });
  assert.equal(result.skippedPlans.length, 1);
  assert.equal(result.legacyExits.length, 1);
  assert.equal(result.legacyExits[0].symbol, "HHH");
  assert.equal(result.planExits.length, 1);
  assert.equal(result.planExits[0].symbol, "III");
});

test("positions with non-finite/zero/negative qty are ignored entirely", () => {
  const result = evaluateOpenPositionExits({
    positions: [
      { symbol: "ZZZ", qty: 0, currentPrice: 10, unrealizedPlPercent: -50 },
      { symbol: "YYY", qty: "not-a-number", currentPrice: 10, unrealizedPlPercent: -50 },
    ],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({}),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.legacyExits.length, 0);
  assert.equal(result.skippedPlans.length, 0);
});
