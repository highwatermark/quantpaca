import { FiniteNumber, parseFiniteNumber } from "./numericSafety";

export type BreakerStatus = "ok" | "block_new_buys" | "close_only";

export interface BreakerLimits {
  maxDailyLossPercent: FiniteNumber;
  maxDrawdownFromPeakPercent: FiniteNumber;
  maxDrawdownFromBaselinePercent: FiniteNumber;
}

export interface BreakerInput {
  equity: unknown; // current account equity (broker truth)
  lastEquity: unknown; // prior-close equity (Alpaca account.last_equity)
  previousPeakEquity: unknown; // high-water mark from the last persisted state; null on first run
  baselineEquity: FiniteNumber | null; // configured account baseline; null = check skipped
  limits: BreakerLimits;
}

export interface BreakerState {
  status: BreakerStatus;
  reasons: string[];
  asOf: string;
  peakEquity: number | null;
  metrics: {
    equity: number | null;
    dailyLossPercent: number | null;
    drawdownFromPeakPercent: number | null;
    drawdownFromBaselinePercent: number | null;
  };
}

export function evaluateBreaker(input: BreakerInput): BreakerState {
  const asOf = new Date().toISOString();
  const equity = parseFiniteNumber(input.equity, "equity");
  const lastEquity = parseFiniteNumber(input.lastEquity, "lastEquity");

  if (!equity.ok || !lastEquity.ok || equity.value <= 0 || lastEquity.value <= 0) {
    return {
      status: "block_new_buys",
      reasons: ["unparseable_or_nonpositive_equity_inputs"],
      asOf,
      peakEquity: null,
      metrics: { equity: null, dailyLossPercent: null, drawdownFromPeakPercent: null, drawdownFromBaselinePercent: null },
    };
  }

  const previousPeak = parseFiniteNumber(input.previousPeakEquity, "previousPeakEquity");
  const peakEquity = Math.max(previousPeak.ok ? previousPeak.value : equity.value, equity.value);

  const reasons: string[] = [];
  let status: BreakerStatus = "ok";

  const dailyLossPercent = ((lastEquity.value - equity.value) / lastEquity.value) * 100;
  if (dailyLossPercent >= input.limits.maxDailyLossPercent) {
    reasons.push(`daily loss ${dailyLossPercent.toFixed(2)}% >= limit ${input.limits.maxDailyLossPercent}%`);
    status = "block_new_buys";
  }

  const drawdownFromPeakPercent = ((peakEquity - equity.value) / peakEquity) * 100;
  if (drawdownFromPeakPercent >= input.limits.maxDrawdownFromPeakPercent) {
    reasons.push(`drawdown from peak ${drawdownFromPeakPercent.toFixed(2)}% >= limit ${input.limits.maxDrawdownFromPeakPercent}%`);
    status = "block_new_buys";
  }

  let drawdownFromBaselinePercent: number | null = null;
  if (input.baselineEquity !== null) {
    drawdownFromBaselinePercent = ((input.baselineEquity - equity.value) / input.baselineEquity) * 100;
    if (drawdownFromBaselinePercent >= input.limits.maxDrawdownFromBaselinePercent) {
      reasons.push(`drawdown from baseline ${drawdownFromBaselinePercent.toFixed(2)}% >= limit ${input.limits.maxDrawdownFromBaselinePercent}%`);
      status = "close_only";
    }
  }

  return {
    status,
    reasons,
    asOf,
    peakEquity,
    metrics: { equity: equity.value, dailyLossPercent, drawdownFromPeakPercent, drawdownFromBaselinePercent },
  };
}
