import { BrokerConfig, ExitPlan, RiskDecision, validateSymbol } from "./tradingSafety";
import { PortfolioAssessment, SizedTradeIntent } from "./domainTypes";

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
  const symbol = validateSymbol(input.intent.symbol);
  if (!symbol.valid) return { status: "rejected", reason: symbol.reason || "Invalid symbol." };
  if (input.brokerConfig.tradingMode === "live" && !input.brokerConfig.liveTradingEnabled) {
    return { status: "rejected", reason: "Live trading is blocked unless LIVE_TRADING_ENABLED=true." };
  }
  if (!input.exitPlan) return { status: "rejected", reason: "No order may be submitted without an exit plan." };
  if (input.intent.qty <= 0 || input.intent.notional <= 0) return { status: "rejected", reason: "Sized trade intent has no executable quantity." };
  if (input.metrics.dailyLoss <= -Math.abs(input.limits.maxDailyLoss)) return { status: "rejected", reason: "Maximum daily loss reached." };
  if (input.metrics.dailyTradeCount >= input.limits.maxDailyTradeCount) return { status: "rejected", reason: "Maximum daily trade count reached." };
  if (input.metrics.openPositionCount >= input.limits.maxOpenPositions && !hasPosition(input.portfolio, input.intent.symbol)) {
    return { status: "rejected", reason: "Maximum open positions reached." };
  }
  if (input.portfolio.buyingPower - input.intent.notional < input.limits.minBuyingPower) {
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
