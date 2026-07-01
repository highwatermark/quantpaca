import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBreaker } from "../src/server/breakerEngine";

const limits = {
  maxDailyLossPercent: 3,
  maxDrawdownFromPeakPercent: 10,
  maxDrawdownFromBaselinePercent: 15,
} as any;

test("healthy account is ok and tracks the peak", () => {
  const state = evaluateBreaker({
    equity: 105000,
    lastEquity: 104000,
    previousPeakEquity: 104000,
    baselineEquity: 100000 as any,
    limits,
  });
  assert.equal(state.status, "ok");
  assert.equal(state.peakEquity, 105000);
});

test("daily loss beyond the percent limit blocks new buys", () => {
  const state = evaluateBreaker({
    equity: 96000,
    lastEquity: 100000, // -4% on the day vs 3% limit
    previousPeakEquity: 100000,
    baselineEquity: 100000 as any,
    limits,
  });
  assert.equal(state.status, "block_new_buys");
  assert.ok(state.reasons.some((r) => r.includes("daily")));
});

test("drawdown from peak beyond the limit blocks new buys", () => {
  const state = evaluateBreaker({
    equity: 89000,
    lastEquity: 89500, // small daily move, big cumulative drawdown
    previousPeakEquity: 100000, // -11% from peak vs 10% limit
    baselineEquity: null,
    limits,
  });
  assert.equal(state.status, "block_new_buys");
});

test("drawdown from baseline beyond the limit goes close-only", () => {
  const state = evaluateBreaker({
    equity: 84000,
    lastEquity: 84500,
    previousPeakEquity: 85000,
    baselineEquity: 100000 as any, // -16% from baseline vs 15% limit
    limits,
  });
  assert.equal(state.status, "close_only");
});

test("unparseable equity fails closed to block_new_buys", () => {
  for (const bad of [NaN, undefined, null, "", "garbage"]) {
    const state = evaluateBreaker({
      equity: bad,
      lastEquity: 100000,
      previousPeakEquity: 100000,
      baselineEquity: 100000 as any,
      limits,
    });
    assert.equal(state.status, "block_new_buys", `equity=${String(bad)}`);
    assert.ok(state.reasons.some((r) => r.includes("unparseable")));
  }
});

test("null baseline skips only the baseline check", () => {
  const state = evaluateBreaker({
    equity: 99000,
    lastEquity: 100000,
    previousPeakEquity: 100000,
    baselineEquity: null,
    limits,
  });
  assert.equal(state.status, "ok");
});
