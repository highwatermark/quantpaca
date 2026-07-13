// Phase 2 Task 4 (docs/GO_LIVE_PLAN.md Phase 2.2): broker-native bracket
// orders. Pure price/validation logic lives here (no fetch/I-O) so the tick
// rounding and degenerate-plan detection are unit-testable without a mock
// broker -- server.ts (placeAlpacaOrder) is the only caller and owns the
// actual POST body construction + broker call.
import { parseFiniteNumber } from "./numericSafety";

// Alpaca requires a bracket's entry order and BOTH child legs (take_profit,
// stop_loss) to share a single time_in_force. The plain (non-bracket) order
// path unchanged by this task keeps using "day" (current behavior); a
// bracket instead uses "gtc" for the WHOLE order -- entry included -- so the
// legs survive overnight and protect the position even while the market is
// closed. This is the one disclosed behavior change from the pre-Task-4
// plain "day" market order (see docs/GO_LIVE_PLAN.md Phase 2.2 / the Task 4
// brief): a bracket-protected BUY no longer expires at the end of the day it
// was placed the way a plain day order would.
export const BRACKET_TIME_IN_FORCE = "gtc";
export const PLAIN_TIME_IN_FORCE = "day";

// Alpaca's minimum price increment: $0.01 at/above $1.00, $0.0001 below it.
const CENT_TICK = 0.01;
const SUB_DOLLAR_TICK = 0.0001;
const TICK_BOUNDARY = 1;

/**
 * Rounds a price DOWN to the nearest valid Alpaca tick increment. Always
 * rounds down (never to nearest, never up) per the Task 4 brief: for a stop
 * price, down triggers slightly earlier (more conservative); for a
 * take-profit limit, down fills slightly easier (more conservative). Both
 * directions err protective, never optimistic.
 *
 * Floating-point note: scales into tick units before flooring (not raw
 * decimal arithmetic) and nudges with a tiny epsilon so a value that is
 * exactly ON a tick boundary but represented with float imprecision (e.g.
 * entry*1.15 landing on 114.99999999999999 instead of 115) still floors to
 * itself instead of the tick below -- the "exact-tick passthrough" case the
 * brief calls out. The epsilon (1e-6 tick-units) is many orders of magnitude
 * smaller than a real tick (1 unit), so it can never round a genuinely
 * sub-tick value up to the next tick.
 */
export function roundDownToTick(price: number): number {
  if (!Number.isFinite(price)) return Number.NaN;
  const belowDollar = price < TICK_BOUNDARY;
  const tick = belowDollar ? SUB_DOLLAR_TICK : CENT_TICK;
  const decimals = belowDollar ? 4 : 2;
  const scaled = price / tick;
  const flooredTicks = Math.floor(scaled + 1e-6);
  return Number((flooredTicks * tick).toFixed(decimals));
}

export type BracketLegs = {
  takeProfitLimitPrice: number;
  stopLossStopPrice: number;
};

// Flat (non-discriminated-union) return shape deliberately: this project's
// tsconfig does not enable `strict`, and TypeScript's control-flow narrowing
// of a boolean-literal-discriminated union (`ok: true` vs `ok: false`) across
// an if/else branch access is unreliable without strictNullChecks -- same
// pitfall exitMonitor.ts's PlanValidation type documents (and sidesteps the
// same way). `legs` is always present but only meaningful when `ok` is true;
// `reason` is always present (empty string on success) for the same reason.
export type BracketLegsResult = {
  ok: boolean;
  legs: BracketLegs;
  reason: string;
};

/**
 * Validates and rounds an exit plan's stop-loss/take-profit into bracket-leg
 * prices for a BUY entry. Never fabricates prices: any missing/non-finite
 * input, a non-buy side, or a degenerate (inverted/collapsed) relationship
 * between entry/stop/take-profit -- even one only exposed AFTER tick
 * rounding -- fails closed with `ok: false` and a reason. The caller
 * (server.ts placeAlpacaOrder) is expected to fall back to a plain market
 * order + audit "software-only protection" on any `ok: false` result; this
 * function itself performs no I/O and never throws.
 */
// Placeholder legs for a failed (`ok: false`) result -- never meant to be
// read (callers are expected to branch on `ok` first), but the flat return
// shape above requires `legs` to always be present.
const NO_LEGS: BracketLegs = { takeProfitLimitPrice: Number.NaN, stopLossStopPrice: Number.NaN };

export function buildBracketLegs(input: {
  side: "buy" | "sell";
  entryEstimate: unknown;
  stopLossPrice: unknown;
  takeProfitPrice: unknown;
}): BracketLegsResult {
  if (input.side !== "buy") {
    return { ok: false, legs: NO_LEGS, reason: "brackets only wrap BUY entries; this order is not a buy." };
  }

  const entryResult = parseFiniteNumber(input.entryEstimate, "entryEstimate");
  if (!entryResult.ok || entryResult.value <= 0) {
    return { ok: false, legs: NO_LEGS, reason: "entry estimate is not a positive finite number." };
  }
  const stopResult = parseFiniteNumber(input.stopLossPrice, "stopLossPrice");
  if (!stopResult.ok) {
    return { ok: false, legs: NO_LEGS, reason: "stop-loss price is not a finite number." };
  }
  const takeProfitResult = parseFiniteNumber(input.takeProfitPrice, "takeProfitPrice");
  if (!takeProfitResult.ok) {
    return { ok: false, legs: NO_LEGS, reason: "take-profit price is not a finite number." };
  }

  const entryEstimate = entryResult.value;
  const stopLossStopPrice = roundDownToTick(stopResult.value);
  const takeProfitLimitPrice = roundDownToTick(takeProfitResult.value);

  // Alpaca constraint: for a buy bracket, take_profit.limit_price must be >
  // the entry estimate and stop_loss.stop_price must be < it -- and,
  // transitively, stop must be < take-profit. Checked AFTER tick rounding:
  // rounding down can itself collapse an otherwise-valid plan into a
  // degenerate one at the boundary (e.g. stop and take-profit rounding into
  // the same tick), and that must still be rejected, not silently allowed
  // through with post-rounding prices that violate the ordering the
  // pre-rounding prices satisfied.
  if (!(takeProfitLimitPrice > entryEstimate) || !(stopLossStopPrice < entryEstimate) || !(stopLossStopPrice < takeProfitLimitPrice)) {
    return {
      ok: false,
      legs: NO_LEGS,
      reason: `degenerate exit plan prices after tick rounding (stop=${stopLossStopPrice}, takeProfit=${takeProfitLimitPrice}, entry=${entryEstimate}); refusing to fabricate a valid bracket.`,
    };
  }

  return { ok: true, legs: { takeProfitLimitPrice, stopLossStopPrice }, reason: "" };
}
