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

// --- Trailing stop: high-water-mark tracking/supply (Task 7) ---

function trailingBasePlan(overrides: Partial<ExitPlan> = {}): ExitPlan {
  return basePlan({
    initialStopLossPrice: 50, // far below entry so it never confounds trailing-specific assertions
    takeProfitPrice: 1000, // far above entry so it never confounds trailing-specific assertions
    trailingStopPercent: 10,
    entryPrice: 100,
    ...overrides,
  });
}

test("trailing stop: price rising above the stored HWM ratchets it up via the callback, but doesn't trigger while still above the threshold", () => {
  const ratchets: Array<{ tradeId: string; symbol: string; highWaterMark: number }> = [];
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL", qty: 1, currentPrice: 130, unrealizedPlPercent: 30 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      TRL: { side: "buy", exitPlan: trailingBasePlan(), tradeId: "tr-1", highWaterMark: 120 },
    }),
    onHighWaterMarkRatchet: (tradeId, symbol, highWaterMark) => ratchets.push({ tradeId, symbol, highWaterMark }),
  });
  assert.equal(result.planExits.length, 0, "130 is above the 117 trailing threshold computed off the freshly-ratcheted 130 HWM");
  assert.deepEqual(ratchets, [{ tradeId: "tr-1", symbol: "TRL", highWaterMark: 130 }]);
});

test("trailing stop: acceptance test -- HWM ratchets to 120 then a retrace to 107 triggers a trailing exit with HWM/threshold/current-price reasoning", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL2", qty: 4, currentPrice: 107, unrealizedPlPercent: 7 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      TRL2: { side: "buy", exitPlan: trailingBasePlan(), tradeId: "tr-2", highWaterMark: 120 },
    }),
  });
  assert.equal(result.planExits.length, 1);
  assert.equal(result.planExits[0].reason, "trailing_stop");
  assert.equal(result.planExits[0].qty, 4);
  assert.match(result.planExits[0].reasoning, /trailing_stop hit: HWM 120\.00, threshold 108\.00.*current 107\.00/);
});

test("trailing stop: a retrace to only 112 (above the 108 threshold) does not trigger", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL3", qty: 1, currentPrice: 112, unrealizedPlPercent: 12 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      TRL3: { side: "buy", exitPlan: trailingBasePlan(), tradeId: "tr-3", highWaterMark: 120 },
    }),
  });
  assert.equal(result.planExits.length, 0);
});

test("trailing stop: the HWM never ratchets down -- a dip below the stored HWM leaves it untouched and does not persist a lower value", () => {
  const ratchets: unknown[] = [];
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL4", qty: 1, currentPrice: 110, unrealizedPlPercent: 10 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      TRL4: { side: "buy", exitPlan: trailingBasePlan(), tradeId: "tr-4", highWaterMark: 120 },
    }),
    onHighWaterMarkRatchet: (tradeId, symbol, highWaterMark) => ratchets.push({ tradeId, symbol, highWaterMark }),
  });
  // 110 is between the threshold (108) and the HWM (120): no trigger, and since
  // 110 < 120 the HWM must not move (nor should the ratchet callback fire).
  assert.equal(result.planExits.length, 0);
  assert.equal(ratchets.length, 0, "the HWM must never ratchet down or be re-persisted on a mere dip");
});

test("trailing stop: a position that has never appreciated above entry never fires trailing (initial stop-loss territory)", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL5", qty: 1, currentPrice: 90, unrealizedPlPercent: -10 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      // HWM == entryPrice: the position has only ever dipped since entry.
      TRL5: { side: "buy", exitPlan: trailingBasePlan(), tradeId: "tr-5", highWaterMark: 100 },
    }),
  });
  assert.equal(result.planExits.length, 0);
});

test("trailing stop: fail-closed -- a corrupt persisted HWM skips the HWM update and the trailing trigger, but other dimensions of the same plan still evaluate", () => {
  const ratchets: unknown[] = [];
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL6", qty: 1, currentPrice: 85, unrealizedPlPercent: -15 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      TRL6: {
        side: "buy",
        // initialStopLossPrice is 90 here (above the 85 current price) so the plan's
        // OWN stop-loss dimension -- unrelated to trailing -- should still fire.
        exitPlan: trailingBasePlan({ initialStopLossPrice: 90 }),
        tradeId: "tr-6",
        highWaterMark: "not-a-number" as unknown as number, // simulated DB corruption
      },
    }),
    onHighWaterMarkRatchet: (tradeId, symbol, highWaterMark) => ratchets.push({ tradeId, symbol, highWaterMark }),
  });
  assert.equal(result.planExits.length, 1);
  assert.equal(result.planExits[0].reason, "stop_loss", "the plan's own stop-loss must still evaluate despite the corrupt HWM");
  assert.equal(ratchets.length, 0, "a corrupt HWM must never be ratcheted/persisted");
});

test("trailing stop: a plan lacking trailingStopPercent/entryPrice (pre-existing plan shape) is unaffected -- no trailing dimension engages", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "TRL7", qty: 1, currentPrice: 200, unrealizedPlPercent: 100 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    lookupPlan: planLookup({
      TRL7: { side: "buy", exitPlan: basePlan({ initialStopLossPrice: 10, takeProfitPrice: 1000 }), tradeId: "tr-7", highWaterMark: 190 },
    }),
  });
  assert.equal(result.planExits.length, 0);
});

// --- Regime-change exit hook (Task 9) ---
//
// evaluateOpenPositionExits gates evaluateExitPlan's regime dimension on the
// PLAN's own regimeChangeAction: the caller's regimePermission is only ever
// forwarded to evaluateExitPlan when the plan says "close" is its
// regime-change response. This is what makes "close_only but the plan doesn't
// opt in" fail to trigger even though exitEngine.ts's own check is a bare
// `regimePermission === "close_only"` with no awareness of the plan shape.
//
// Prices/thresholds below are engineered to be safely inside every other
// dimension's "no trigger" zone (mid-range price, far stop-loss/take-profit,
// future timeExitAt, no HWM) so only the regime dimension is under test.

test("regime-change: close_only permission + a plan with regimeChangeAction \"close\" triggers a regime_change exit", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "RGM1", qty: 5, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    regimePermission: "close_only",
    regimeMode: "risk_off",
    lookupPlan: planLookup({ RGM1: { side: "buy", exitPlan: basePlan({ regimeChangeAction: "close" }) } }),
  });
  assert.equal(result.planExits.length, 1);
  assert.equal(result.planExits[0].reason, "regime_change");
  assert.equal(result.legacyExits.length, 0);
});

test("regime-change: reasoning records the regime mode and permission that triggered the exit", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "RGM2", qty: 1, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    regimePermission: "close_only",
    regimeMode: "risk_off",
    lookupPlan: planLookup({ RGM2: { side: "buy", exitPlan: basePlan({ regimeChangeAction: "close" }) } }),
  });
  assert.equal(result.planExits.length, 1);
  assert.match(result.planExits[0].reasoning, /risk_off/);
  assert.match(result.planExits[0].reasoning, /close_only/);
});

test("regime-change: permission reduce_size does not trigger a regime exit even with regimeChangeAction \"close\"", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "RGM3", qty: 1, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    regimePermission: "reduce_size",
    regimeMode: "volatile",
    lookupPlan: planLookup({ RGM3: { side: "buy", exitPlan: basePlan({ regimeChangeAction: "close" }) } }),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.legacyExits.length, 0);
});

test("regime-change: permission allow does not trigger a regime exit even with regimeChangeAction \"close\"", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "RGM4", qty: 1, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    regimePermission: "allow",
    regimeMode: "trend_up",
    lookupPlan: planLookup({ RGM4: { side: "buy", exitPlan: basePlan({ regimeChangeAction: "close" }) } }),
  });
  assert.equal(result.planExits.length, 0);
});

test("regime-change: close_only but the plan's regimeChangeAction is not \"close\" does not trigger a regime exit", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "RGM5", qty: 1, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    regimePermission: "close_only",
    regimeMode: "risk_off",
    lookupPlan: planLookup({ RGM5: { side: "buy", exitPlan: basePlan({ regimeChangeAction: "hold" }) } }),
  });
  assert.equal(result.planExits.length, 0);
  assert.equal(result.legacyExits.length, 0);
});

test("regime-change: missing/undefined regimePermission does not trigger a regime exit even with regimeChangeAction \"close\"", () => {
  const result = evaluateOpenPositionExits({
    positions: [{ symbol: "RGM6", qty: 1, currentPrice: 100, unrealizedPlPercent: 0 }],
    now: new Date(),
    legacyStopLossPercent: 5,
    // regimePermission intentionally omitted -- simulates the absence of any
    // regime assessment for this cycle (fail-closed: absence must never
    // liquidate a position).
    lookupPlan: planLookup({ RGM6: { side: "buy", exitPlan: basePlan({ regimeChangeAction: "close" }) } }),
  });
  assert.equal(result.planExits.length, 0);
});
