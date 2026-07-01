import { ExitPlan } from "./tradingSafety";

export function createExitPlan(input: {
  symbol: string;
  side: "buy" | "sell";
  entryPrice: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  maxHoldDays?: number;
}): ExitPlan {
  const stopLossPercent = input.stopLossPercent ?? 5;
  const takeProfitPercent = input.takeProfitPercent ?? 15;
  const maxHoldDays = input.maxHoldDays ?? 14;
  const stopMultiplier = input.side === "buy" ? 1 - stopLossPercent / 100 : 1 + stopLossPercent / 100;
  const profitMultiplier = input.side === "buy" ? 1 + takeProfitPercent / 100 : 1 - takeProfitPercent / 100;

  return {
    initialStopLossPrice: roundMoney(input.entryPrice * stopMultiplier),
    takeProfitPrice: roundMoney(input.entryPrice * profitMultiplier),
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
}) {
  const now = input.now || new Date();
  if (input.thesisInvalidated) return { triggered: true, reason: "thesis_invalidation" };
  if (input.regimePermission === "close_only") return { triggered: true, reason: "regime_change" };
  if (Date.parse(input.exitPlan.timeExitAt) <= now.getTime()) return { triggered: true, reason: "time_exit" };
  if (input.side === "buy" && input.currentPrice <= input.exitPlan.initialStopLossPrice) return { triggered: true, reason: "stop_loss" };
  if (input.side === "sell" && input.currentPrice >= input.exitPlan.initialStopLossPrice) return { triggered: true, reason: "stop_loss" };
  if (input.exitPlan.takeProfitPrice && input.side === "buy" && input.currentPrice >= input.exitPlan.takeProfitPrice) return { triggered: true, reason: "take_profit" };
  if (input.exitPlan.takeProfitPrice && input.side === "sell" && input.currentPrice <= input.exitPlan.takeProfitPrice) return { triggered: true, reason: "take_profit" };
  return { triggered: false, reason: "none" };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}
