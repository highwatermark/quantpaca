import { RegimeAssessment } from "./domainTypes";

type RegimeInput = {
  spyTrendPercent?: number;
  qqqTrendPercent?: number;
  broadMarketDrawdownPercent?: number;
  volatilityProxyPercent?: number;
  btcTrendPercent?: number;
  symbol?: string;
};

export function detectRegime(input: RegimeInput): RegimeAssessment {
  const timestamp = new Date().toISOString();
  if (!hasMarketData(input)) {
    return {
      id: `reg-${Date.now()}`,
      timestamp,
      marketMode: "unclear",
      volatilityLevel: "normal",
      tradePermission: "reduce_size",
      sizeMultiplier: 0.5,
      reason: "Market regime inputs unavailable; defaulting to conservative reduced-size mode.",
    };
  }

  const drawdown = input.broadMarketDrawdownPercent || 0;
  const vol = input.volatilityProxyPercent || 0;
  const trend = average([input.spyTrendPercent, input.qqqTrendPercent]);
  const volatilityLevel: RegimeAssessment["volatilityLevel"] =
    vol >= 45 ? "extreme" : vol >= 30 ? "high" : vol <= 12 ? "low" : "normal";

  if (volatilityLevel === "extreme" || drawdown <= -12) {
    return assessment("risk_off", volatilityLevel, "close_only", 0, "Extreme volatility or drawdown blocks new risk.");
  }
  if (drawdown <= -7 || trend < -3) {
    return assessment("trend_down", volatilityLevel, "block_new_buys", 0, "Market trend is down or drawdown is elevated.");
  }
  if (volatilityLevel === "high") {
    return assessment("volatile", volatilityLevel, "reduce_size", 0.5, "Volatility is high; reduce position size.");
  }
  if (trend > 3) {
    return assessment("trend_up", volatilityLevel, "allow", 1, "Broad market trend is constructive.");
  }
  return assessment("risk_on", volatilityLevel, "allow", 0.8, "Market data is constructive but not strongly trending.");

  function assessment(
    marketMode: RegimeAssessment["marketMode"],
    volLevel: RegimeAssessment["volatilityLevel"],
    tradePermission: RegimeAssessment["tradePermission"],
    sizeMultiplier: number,
    reason: string,
  ): RegimeAssessment {
    const cryptoLinked = input.symbol && ["MARA", "RIOT", "COIN", "MSTR"].includes(input.symbol.toUpperCase());
    return {
      id: `reg-${Date.now()}`,
      timestamp,
      marketMode,
      volatilityLevel: volLevel,
      tradePermission,
      sizeMultiplier,
      reason: cryptoLinked && Number.isFinite(input.btcTrendPercent)
        ? `${reason} BTC proxy trend ${input.btcTrendPercent}%.`
        : reason,
      sectorRelevance: cryptoLinked ? "crypto_linked_equity" : undefined,
    };
  }
}

function hasMarketData(input: RegimeInput) {
  return [input.spyTrendPercent, input.qqqTrendPercent, input.broadMarketDrawdownPercent, input.volatilityProxyPercent]
    .some((value) => Number.isFinite(value));
}

function average(values: Array<number | undefined>) {
  const nums = values.filter((value): value is number => Number.isFinite(value));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}
