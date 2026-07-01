import { AlpacaAccount, AlpacaPosition } from "../types";
import { OpenOrder, PortfolioAssessment } from "./domainTypes";

export function assessPortfolio(input: {
  account: AlpacaAccount;
  positions?: AlpacaPosition[];
  openOrders?: OpenOrder[];
  source?: PortfolioAssessment["source"];
}): PortfolioAssessment {
  const equity = toNumber(input.account.equity || input.account.portfolio_value);
  const longMarketValue = toNumber(input.account.long_market_value);
  const positions = input.positions || [];
  const openOrders = input.openOrders || [];
  const perSymbolConcentration: Record<string, number> = {};

  for (const position of positions) {
    perSymbolConcentration[position.symbol] = roundPercent(toNumber(position.market_value), equity);
  }

  return {
    timestamp: new Date().toISOString(),
    cash: toNumber(input.account.cash),
    buyingPower: toNumber(input.account.buying_power),
    equity,
    longMarketValue,
    totalLongExposurePercent: roundPercent(longMarketValue, equity),
    pendingOrderNotional: openOrders.reduce((sum, order) => sum + orderNotional(order), 0),
    positions,
    openOrders,
    perSymbolConcentration,
    source: input.source || "alpaca",
  };
}

function orderNotional(order: OpenOrder) {
  if (Number.isFinite(Number(order.notional))) return Number(order.notional);
  return 0;
}

function toNumber(value: string | number | undefined) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundPercent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}
