import { BrokerConfig, ExitPlan, RiskDecision, validateSymbol } from "./tradingSafety";
import { PortfolioAssessment, SizedTradeIntent } from "./domainTypes";
import { parseFiniteNumber } from "./numericSafety";

type RiskInput = {
  intent: SizedTradeIntent;
  brokerConfig: BrokerConfig;
  portfolio: PortfolioAssessment;
  exitPlan?: ExitPlan;
  metrics: {
    dailyLoss: number;
    dailyTradeCount: number;
    openPositionCount: number;
  };
  limits: {
    maxDailyLoss: number;
    maxDailyTradeCount: number;
    maxOpenPositions: number;
    minBuyingPower: number;
    cooldownSymbols?: string[];
  };
};

export function reviewRisk(input: RiskInput): RiskDecision {
  // Fail-closed numeric boundary: every number used in a comparison below must
  // parse as finite here first. An unparsable value rejects the trade — it never
  // silently disables the guardrail it feeds (see docs/LOOP_ARCHITECTURE.md,
  // "Numeric Fail-Closed Policy").
  const numericFields: Array<[unknown, string]> = [
    [input.intent.qty, "intent.qty"],
    [input.intent.notional, "intent.notional"],
    [input.intent.estimatedPrice, "intent.estimatedPrice"],
    [input.portfolio.buyingPower, "portfolio.buyingPower"],
    [input.metrics.dailyLoss, "metrics.dailyLoss"],
    [input.metrics.dailyTradeCount, "metrics.dailyTradeCount"],
    [input.metrics.openPositionCount, "metrics.openPositionCount"],
    [input.limits.maxDailyLoss, "limits.maxDailyLoss"],
    [input.limits.maxDailyTradeCount, "limits.maxDailyTradeCount"],
    [input.limits.maxOpenPositions, "limits.maxOpenPositions"],
    [input.limits.minBuyingPower, "limits.minBuyingPower"],
  ];
  const parsed = new Map<string, number>();
  for (const [value, fieldName] of numericFields) {
    const result = parseFiniteNumber(value, fieldName);
    if (!result.ok) {
      return { status: "rejected", reason: `Risk input "${fieldName}" is not a finite number; failing closed.` };
    }
    parsed.set(fieldName, result.value);
  }
  const num = (fieldName: string): number => parsed.get(fieldName)!;

  const symbol = validateSymbol(input.intent.symbol);
  if (!symbol.valid) return { status: "rejected", reason: symbol.reason || "Invalid symbol." };
  if (input.brokerConfig.tradingMode === "live" && !input.brokerConfig.liveTradingEnabled) {
    return { status: "rejected", reason: "Live trading is blocked unless LIVE_TRADING_ENABLED=true." };
  }
  if (!input.exitPlan) return { status: "rejected", reason: "No order may be submitted without an exit plan." };
  if (num("intent.qty") <= 0 || num("intent.notional") <= 0) {
    return { status: "rejected", reason: "Sized trade intent has no executable quantity." };
  }
  if (num("metrics.dailyLoss") <= -Math.abs(num("limits.maxDailyLoss"))) {
    return { status: "rejected", reason: "Maximum daily loss reached." };
  }
  if (num("metrics.dailyTradeCount") >= num("limits.maxDailyTradeCount")) {
    return { status: "rejected", reason: "Maximum daily trade count reached." };
  }
  if (num("metrics.openPositionCount") >= num("limits.maxOpenPositions") && !hasPosition(input.portfolio, input.intent.symbol)) {
    return { status: "rejected", reason: "Maximum open positions reached." };
  }
  if (num("portfolio.buyingPower") - num("intent.notional") < num("limits.minBuyingPower")) {
    return { status: "rejected", reason: "Insufficient buying power after required reserve." };
  }
  if (input.portfolio.openOrders.some((order) => order.symbol === input.intent.symbol && order.side === input.intent.side && !isTerminal(order.status))) {
    return { status: "rejected", reason: "Duplicate open order protection triggered." };
  }
  if (input.limits.cooldownSymbols?.includes(input.intent.symbol)) {
    return { status: "requires_human_approval", reason: "Symbol is in cooldown after a rejected or failed trade." };
  }
  return { status: "approved", reason: "Centralized risk checks passed." };
}

function hasPosition(portfolio: PortfolioAssessment, symbol: string) {
  return portfolio.positions.some((position) => position.symbol === symbol && Number(position.qty) > 0);
}

function isTerminal(status: string) {
  return ["filled", "canceled", "cancelled", "expired", "rejected"].includes(status.toLowerCase());
}
