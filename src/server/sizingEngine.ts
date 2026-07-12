import { PortfolioAssessment, RegimeAssessment, ReviewedSignal, SizedTradeIntent } from "./domainTypes";

export type CapLimits = {
  maxSinglePositionPercent: number;
  maxPortfolioExposurePercent: number;
  maxNotionalPerTrade: number;
  minBuyingPowerAfterTrade: number;
};

export type CapRoom = {
  allowedNotional: number;
  capsApplied: string[];
};

type SizingInput = {
  reviewedSignal: ReviewedSignal;
  regime: RegimeAssessment;
  portfolio: PortfolioAssessment;
  side: "buy" | "sell";
  estimatedPrice: number;
  stopLossPrice: number;
  limits: CapLimits;
};

// Shared by both this file's sizeTradeIntent (automation path, which layers
// signal-confidence/stop-distance/regime multipliers on top of this) and the
// manual override path (server.ts POST /api/override/trade, which applies ONLY
// these hard caps -- a human's explicit order is never scaled down for signal
// quality). Do not fork this math: both callers go through this one function so
// a per-position/exposure/buying-power/max-notional cap can never diverge
// between the two paths (docs/GO_LIVE_PLAN.md Phase 1.4).
export function computeCapRoom(input: {
  portfolio: PortfolioAssessment;
  symbol: string;
  limits: CapLimits;
}): CapRoom {
  const capsApplied: string[] = [];
  const equity = input.portfolio.equity;
  const maxPositionNotional = equity * (input.limits.maxSinglePositionPercent / 100);
  const currentSymbolNotional = (input.portfolio.perSymbolConcentration[input.symbol] || 0) / 100 * equity;
  const remainingPositionNotional = Math.max(0, maxPositionNotional - currentSymbolNotional);
  const remainingExposureNotional = Math.max(0, equity * (input.limits.maxPortfolioExposurePercent / 100) - input.portfolio.longMarketValue - input.portfolio.pendingOrderNotional);
  const usableBuyingPower = Math.max(0, input.portfolio.buyingPower - input.limits.minBuyingPowerAfterTrade);

  const allowedNotional = Math.min(
    remainingPositionNotional,
    remainingExposureNotional,
    usableBuyingPower,
    input.limits.maxNotionalPerTrade,
  );
  if (allowedNotional === remainingPositionNotional) capsApplied.push("max_single_position");
  if (allowedNotional === remainingExposureNotional) capsApplied.push("max_portfolio_exposure");
  if (allowedNotional === usableBuyingPower) capsApplied.push("buying_power");
  if (allowedNotional === input.limits.maxNotionalPerTrade) capsApplied.push("max_notional");

  return { allowedNotional, capsApplied: Array.from(new Set(capsApplied)) };
}

// Converts a notional dollar amount into a whole-share quantity at the given
// price, floored and clamped to non-negative -- the same rounding rule
// sizeTradeIntent has always used, now shared with the manual override path.
export function capRoomToQty(allowedNotional: number, estimatedPrice: number): number {
  if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0) return 0;
  return Math.max(0, Math.floor(allowedNotional / estimatedPrice));
}

export function sizeTradeIntent(input: SizingInput): SizedTradeIntent {
  if (input.reviewedSignal.status !== "accepted") {
    return emptyIntent(input, "Reviewed signal was rejected.", ["signal_rejected"]);
  }
  if (input.regime.tradePermission === "close_only" || (input.side === "buy" && input.regime.tradePermission === "block_new_buys")) {
    return emptyIntent(input, "Regime blocks this trade.", ["regime_block"]);
  }
  if (!Number.isFinite(input.estimatedPrice) || input.estimatedPrice <= 0) {
    return emptyIntent(input, "No deterministic estimated price.", ["missing_price"]);
  }

  const capRoom = computeCapRoom({
    portfolio: input.portfolio,
    symbol: input.reviewedSignal.symbol,
    limits: input.limits,
  });
  let allowedNotional = capRoom.allowedNotional;
  const capsApplied: string[] = [...capRoom.capsApplied];

  const confidenceMultiplier = Math.max(0.25, Math.min(1, input.reviewedSignal.confidenceScore / 100));
  allowedNotional *= confidenceMultiplier;
  capsApplied.push("signal_confidence");

  const stopDistance = Math.abs(input.estimatedPrice - input.stopLossPrice) / input.estimatedPrice;
  if (stopDistance > 0.08) {
    allowedNotional *= 0.75;
    capsApplied.push("stop_distance");
  }

  if (input.regime.sizeMultiplier < 1) {
    allowedNotional *= input.regime.sizeMultiplier;
    capsApplied.push("regime_multiplier");
  }

  const qty = capRoomToQty(allowedNotional, input.estimatedPrice);
  return {
    id: `sti-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: input.reviewedSignal.symbol,
    side: input.side,
    qty,
    notional: Math.round(qty * input.estimatedPrice * 100) / 100,
    estimatedPrice: input.estimatedPrice,
    sizingReason: `Sized from equity, exposure, buying power, confidence, stop distance, and regime controls.`,
    capsApplied: Array.from(new Set(capsApplied)),
  };
}

function emptyIntent(input: SizingInput, reason: string, capsApplied: string[]): SizedTradeIntent {
  return {
    id: `sti-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: input.reviewedSignal.symbol,
    side: input.side,
    qty: 0,
    notional: 0,
    estimatedPrice: input.estimatedPrice,
    sizingReason: reason,
    capsApplied,
  };
}
