import { ExitPlan } from "./tradingSafety";

// Default trailing-stop distance (percent below the high-water mark) applied
// when a caller doesn't specify one. Not an env var -- see docs/GO_LIVE_PLAN.md
// Phase 1.2 ("Populate ... trailingStopPercent ... default 10").
export const DEFAULT_TRAILING_STOP_PERCENT = 10;

export function createExitPlan(input: {
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  maxHoldDays?: number;
  trailingStopPercent?: number;
}): ExitPlan {
  const stopLossPercent = input.stopLossPercent ?? 5;
  const takeProfitPercent = input.takeProfitPercent ?? 15;
  const maxHoldDays = input.maxHoldDays ?? 14;
  const trailingStopPercent = input.trailingStopPercent ?? DEFAULT_TRAILING_STOP_PERCENT;
  const stopMultiplier = input.side === "buy" ? 1 - stopLossPercent / 100 : 1 + stopLossPercent / 100;
  const profitMultiplier = input.side === "buy" ? 1 + takeProfitPercent / 100 : 1 - takeProfitPercent / 100;

  return {
    initialStopLossPrice: roundMoney(input.entryPrice * stopMultiplier),
    takeProfitPrice: roundMoney(input.entryPrice * profitMultiplier),
    trailingStopPercent,
    entryPrice: roundMoney(input.entryPrice),
    timeExitAt: new Date(Date.now() + maxHoldDays * 24 * 60 * 60 * 1000).toISOString(),
    thesisInvalidation: `${input.symbol} thesis invalidated by source evidence, price stop, or risk regime.`,
    regimeChangeAction: "close",
    emergencyAction: "market_sell",
  };
}

export function evaluateExitPlan(input: {
  exitPlan: ExitPlan;
  side: "buy" | "sell";
  currentPrice: number;
  now?: Date;
  thesisInvalidated?: boolean;
  regimePermission?: "allow" | "reduce_size" | "block_new_buys" | "close_only";
  // High-water mark supplied by the caller (src/server/exitMonitor.ts owns
  // tracking/persistence). Undefined or non-finite (e.g. the monitor failed to
  // parse a price this cycle) fails closed: the trailing dimension is simply
  // skipped -- it never trips on garbage, and every other dimension below is
  // evaluated exactly as it always was.
  highWaterMark?: number;
}) {
  const now = input.now || new Date();
  if (input.thesisInvalidated) return { triggered: true, reason: "thesis_invalidation" };
  if (input.regimePermission === "close_only") return { triggered: true, reason: "regime_change" };
  if (Date.parse(input.exitPlan.timeExitAt) <= now.getTime()) return { triggered: true, reason: "time_exit" };
  if (input.side === "buy" && input.currentPrice <= input.exitPlan.initialStopLossPrice) return { triggered: true, reason: "stop_loss" };
  if (input.side === "sell" && input.currentPrice >= input.exitPlan.initialStopLossPrice) return { triggered: true, reason: "stop_loss" };
  if (input.exitPlan.takeProfitPrice && input.side === "buy" && input.currentPrice >= input.exitPlan.takeProfitPrice) return { triggered: true, reason: "take_profit" };
  if (input.exitPlan.takeProfitPrice && input.side === "sell" && input.currentPrice <= input.exitPlan.takeProfitPrice) return { triggered: true, reason: "take_profit" };
  // Trailing stop: buy-side only (the only plans ever fetched to protect an
  // open position -- see exitMonitor.ts's latestBuySideExitPlanForSymbol
  // contract). Requires the position to have appreciated above its entry
  // price at some point (highWaterMark > entryPrice); a position that never
  // appreciated is the initial stop-loss's territory, handled above.
  if (
    input.side === "buy" &&
    input.exitPlan.trailingStopPercent !== undefined &&
    Number.isFinite(input.highWaterMark) &&
    Number.isFinite(input.exitPlan.entryPrice) &&
    (input.highWaterMark as number) > (input.exitPlan.entryPrice as number)
  ) {
    const trailingStopPrice = (input.highWaterMark as number) * (1 - input.exitPlan.trailingStopPercent / 100);
    if (input.currentPrice <= trailingStopPrice) return { triggered: true, reason: "trailing_stop" };
  }
  return { triggered: false, reason: "none" };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}
