import test from "node:test";
import assert from "node:assert/strict";
import { parseFiniteNumber } from "../src/server/numericSafety";
import { reviewRisk } from "../src/server/riskEngine";
import { evaluateBreaker } from "../src/server/breakerEngine";
import { sizeTradeIntent } from "../src/server/sizingEngine";

const BAD_VALUES: unknown[] = [NaN, Infinity, -Infinity, undefined, null, "", "garbage"];

// --- reviewRisk: every numeric field, every bad value ---
// Fixture mirrors the real RiskInput shape consumed by src/server/riskEngine.ts
// and the fixtures already proven correct in tests/riskEngineFailClosed.test.ts.
const riskBase = () => ({
  intent: {
    id: "sti-1",
    symbol: "PLTR",
    side: "buy" as const,
    qty: 5,
    notional: 100,
    estimatedPrice: 20,
    sizingReason: "t",
    capsApplied: [],
  },
  brokerConfig: {
    configured: true,
    tradingMode: "paper" as const,
    liveTradingEnabled: false,
    baseUrl: "https://paper-api.alpaca.markets",
  },
  portfolio: {
    timestamp: "",
    cash: 50000,
    equity: 100000,
    buyingPower: 50000,
    longMarketValue: 0,
    pendingOrderNotional: 0,
    totalLongExposurePercent: 0,
    perSymbolConcentration: {},
    positions: [],
    openOrders: [],
    source: "alpaca" as const,
  },
  exitPlan: {
    initialStopLossPrice: 19,
    takeProfitPrice: 23,
    timeExitAt: new Date().toISOString(),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close" as const,
    emergencyAction: "market_sell" as const,
  },
  metrics: { dailyLoss: 0, dailyTradeCount: 0, openPositionCount: 0 },
  limits: { maxDailyLoss: 500, maxDailyTradeCount: 10, maxOpenPositions: 10, minBuyingPower: 100 },
  // Added in Task 12: reviewRisk fails closed on a non-"ok" breaker for buys.
  breaker: { status: "ok" as const },
});

const RISK_NUMERIC_PATHS: Array<[string, (input: any, v: unknown) => void]> = [
  ["intent.qty", (i, v) => (i.intent.qty = v)],
  ["intent.notional", (i, v) => (i.intent.notional = v)],
  ["intent.estimatedPrice", (i, v) => (i.intent.estimatedPrice = v)],
  ["portfolio.buyingPower", (i, v) => (i.portfolio.buyingPower = v)],
  // riskBase() defaults intent.side to "buy", so metrics.dailyLoss is
  // REQUIRED here per the Task 12 policy amendment (optional only for sells).
  ["metrics.dailyLoss", (i, v) => (i.metrics.dailyLoss = v)],
  ["metrics.dailyTradeCount", (i, v) => (i.metrics.dailyTradeCount = v)],
  ["metrics.openPositionCount", (i, v) => (i.metrics.openPositionCount = v)],
  ["limits.maxDailyLoss", (i, v) => (i.limits.maxDailyLoss = v)],
  ["limits.maxDailyTradeCount", (i, v) => (i.limits.maxDailyTradeCount = v)],
  ["limits.maxOpenPositions", (i, v) => (i.limits.maxOpenPositions = v)],
  ["limits.minBuyingPower", (i, v) => (i.limits.minBuyingPower = v)],
];

test("property: reviewRisk rejects every invalid value at every numeric boundary", () => {
  for (const [name, inject] of RISK_NUMERIC_PATHS) {
    for (const bad of BAD_VALUES) {
      const input = riskBase() as any;
      inject(input, bad);
      const decision = reviewRisk(input);
      assert.equal(decision.status, "rejected", `${name}=${String(bad)} must reject, got ${decision.status}`);
    }
  }
});

test("property: breaker trips block_new_buys on every invalid equity input", () => {
  // FiniteNumber is a branded type; the limits fixture needs an `as any` cast
  // here, matching the pattern already used in tests/breakerEngine.test.ts.
  const limits = { maxDailyLossPercent: 3, maxDrawdownFromPeakPercent: 10, maxDrawdownFromBaselinePercent: 15 } as any;
  for (const bad of BAD_VALUES) {
    for (const field of ["equity", "lastEquity"] as const) {
      const input: any = { equity: 100000, lastEquity: 100000, previousPeakEquity: 100000, baselineEquity: null, limits };
      input[field] = bad;
      const state = evaluateBreaker(input);
      assert.notEqual(state.status, "ok", `${field}=${String(bad)} must not be ok`);
    }
  }
});

test("property: sizing yields qty 0 for every invalid price", () => {
  for (const bad of BAD_VALUES) {
    const sized = sizeTradeIntent({
      reviewedSignal: {
        id: "rs-1",
        rawSignalId: "raw-1",
        symbol: "PLTR",
        source: "email",
        sourceTimestamp: new Date().toISOString(),
        freshnessStatus: "fresh",
        confidenceScore: 80,
        classification: "bullish",
        thesisSummary: "t",
        invalidationConditions: [],
        evidence: [],
        status: "accepted",
      },
      regime: {
        id: "rg-1",
        timestamp: new Date().toISOString(),
        marketMode: "unclear",
        volatilityLevel: "normal",
        tradePermission: "reduce_size",
        sizeMultiplier: 0.5,
        reason: "",
      },
      portfolio: {
        timestamp: "",
        cash: 50000,
        equity: 100000,
        buyingPower: 50000,
        longMarketValue: 0,
        pendingOrderNotional: 0,
        totalLongExposurePercent: 0,
        perSymbolConcentration: {},
        positions: [],
        openOrders: [],
        source: "alpaca",
      },
      side: "buy",
      estimatedPrice: bad as number,
      stopLossPrice: 19,
      limits: { maxSinglePositionPercent: 10, maxPortfolioExposurePercent: 100, maxNotionalPerTrade: 10000, minBuyingPowerAfterTrade: 0 },
    });
    assert.equal(sized.qty, 0, `estimatedPrice=${String(bad)} must size to 0`);
  }
});

test("property: parseFiniteNumber is the single source of truth for validity", () => {
  for (const bad of BAD_VALUES) {
    assert.equal(parseFiniteNumber(bad, "x").ok, false);
  }
});
