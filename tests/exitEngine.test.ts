import test from "node:test";
import assert from "node:assert/strict";
import { createExitPlan, evaluateExitPlan, DEFAULT_TRAILING_STOP_PERCENT } from "../src/server/exitEngine";
import { ExitPlan } from "../src/server/tradingSafety";

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function trailingPlan(overrides: Partial<ExitPlan> = {}): ExitPlan {
  return {
    initialStopLossPrice: 50, // deliberately far below entry so it doesn't confound trailing-specific assertions
    takeProfitPrice: 1000, // deliberately far above entry so it doesn't confound trailing-specific assertions
    trailingStopPercent: 10,
    entryPrice: 100,
    timeExitAt: FUTURE,
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
    ...overrides,
  };
}

test("createExitPlan populates trailingStopPercent with a default of 10 when not supplied", () => {
  const plan = createExitPlan({ symbol: "ACME", side: "buy", entryPrice: 100 });
  assert.equal(plan.trailingStopPercent, 10);
  assert.equal(DEFAULT_TRAILING_STOP_PERCENT, 10);
});

test("createExitPlan honors an explicit trailingStopPercent override", () => {
  const plan = createExitPlan({ symbol: "ACME", side: "buy", entryPrice: 100, trailingStopPercent: 7 });
  assert.equal(plan.trailingStopPercent, 7);
});

test("createExitPlan leaves the initial stop-loss computation unchanged", () => {
  const plan = createExitPlan({ symbol: "ACME", side: "buy", entryPrice: 100, stopLossPercent: 5 });
  assert.equal(plan.initialStopLossPrice, 95);
});

test("trailing stop: acceptance test -- HWM ratcheted to 120, retrace to 107 triggers, retrace to 112 does not", () => {
  const plan = trailingPlan();

  const noTriggerYet = evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 120, highWaterMark: 120 });
  assert.equal(noTriggerYet.triggered, false);

  const retraceButAboveThreshold = evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 112, highWaterMark: 120 });
  assert.equal(retraceButAboveThreshold.triggered, false, "112 is above the trailing threshold of 108 (120 * 0.9)");

  const retraceBelowThreshold = evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 107, highWaterMark: 120 });
  assert.equal(retraceBelowThreshold.triggered, true);
  assert.equal(retraceBelowThreshold.reason, "trailing_stop");
});

test("trailing stop: never fires when the position has not appreciated above entry (HWM == entry)", () => {
  const plan = trailingPlan({ entryPrice: 100 });
  // HWM never exceeded entry -- price only ever dipped, so trailing stays out of it
  // and the initial stop-loss (set far below at 50) is the only relevant dimension.
  const result = evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 90, highWaterMark: 100 });
  assert.equal(result.triggered, false);
  assert.notEqual(result.reason, "trailing_stop");
});

test("trailing stop: an undefined/non-finite highWaterMark skips the trailing dimension but other dimensions still evaluate", () => {
  const plan = trailingPlan({ initialStopLossPrice: 90 });
  const result = evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 85, highWaterMark: undefined });
  assert.equal(result.triggered, true);
  assert.equal(result.reason, "stop_loss", "stop_loss must still fire even though trailing was skipped for lack of a valid HWM");
});

test("trailing stop: NaN highWaterMark is treated the same as missing (fail closed, no crash)", () => {
  const plan = trailingPlan({ initialStopLossPrice: 90 });
  const result = evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 85, highWaterMark: NaN });
  assert.equal(result.triggered, true);
  assert.equal(result.reason, "stop_loss");
});

test("trailing stop: does not apply on the sell side", () => {
  const plan: ExitPlan = {
    initialStopLossPrice: 150,
    takeProfitPrice: 1,
    trailingStopPercent: 10,
    entryPrice: 100,
    timeExitAt: FUTURE,
    thesisInvalidation: "n/a",
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  };
  // For a sell/short, HWM tracking as implemented (ratchets on highs) doesn't
  // apply; only buy-side plans are ever fetched for open-position protection
  // (see exitMonitor.ts's latestBuySideExitPlanForSymbol contract).
  const result = evaluateExitPlan({ exitPlan: plan, side: "sell", currentPrice: 200, highWaterMark: 50 });
  assert.notEqual(result.reason, "trailing_stop");
});

test("existing dimensions are untouched: take-profit, time-exit, thesis-invalidation, regime-change still behave exactly as before", () => {
  const plan = trailingPlan({ takeProfitPrice: 120 });
  assert.equal(evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 125 }).reason, "take_profit");

  const pastTimeExitPlan = trailingPlan({ timeExitAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(evaluateExitPlan({ exitPlan: pastTimeExitPlan, side: "buy", currentPrice: 100 }).reason, "time_exit");

  assert.equal(evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 100, thesisInvalidated: true }).reason, "thesis_invalidation");
  assert.equal(evaluateExitPlan({ exitPlan: plan, side: "buy", currentPrice: 100, regimePermission: "close_only" }).reason, "regime_change");
});
