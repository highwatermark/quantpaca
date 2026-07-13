import test from "node:test";
import assert from "node:assert/strict";
import { reviewRisk, PDT_EQUITY_MIN, PDT_MAX_DAY_TRADES } from "../src/server/riskEngine";

// Phase 2 Task 3 (docs/GO_LIVE_PLAN.md Phase 2.1, "PDT guard"): unit coverage
// for the pattern-day-trader rule enforced centrally in reviewRisk. Fixture
// mirrors tests/riskEngineFailClosed.test.ts's baseInput, extended with the
// two new required-for-buy metrics fields this task adds.
const baseInput = () => ({
  intent: {
    id: "sti-1",
    symbol: "PLTR",
    side: "buy" as const,
    qty: 5,
    notional: 100,
    estimatedPrice: 20,
    sizingReason: "test",
    capsApplied: [],
  },
  brokerConfig: {
    configured: true,
    tradingMode: "paper" as const,
    liveTradingEnabled: false,
    baseUrl: "https://paper-api.alpaca.markets/v2",
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
  breaker: { status: "ok" as const },
  metrics: { dailyLoss: 0, dailyTradeCount: 0, openPositionCount: 0, accountEquity: 100000, dayTradeCount: 0 },
  limits: { maxDailyLoss: 500, maxDailyTradeCount: 10, maxOpenPositions: 10, minBuyingPower: 100 },
});

test("named constants match the plan's PDT thresholds", () => {
  assert.equal(PDT_EQUITY_MIN, 25_000);
  assert.equal(PDT_MAX_DAY_TRADES, 3);
});

test("equity 20k + daytrade_count 3 -> BUY rejected with an audited PDT reason", () => {
  const input = baseInput() as any;
  input.metrics.accountEquity = 20000;
  input.metrics.dayTradeCount = 3;
  const decision = reviewRisk(input);
  assert.equal(decision.status, "rejected");
  assert.match(decision.reason, /PDT guard/i);
  assert.match(decision.reason, /3 day trades/i);
  assert.match(decision.reason, /\$25k/);
});

test("equity 20k + daytrade_count 3 -> SELL still approved (never blocked)", () => {
  const input = baseInput() as any;
  input.intent.side = "sell";
  input.metrics.accountEquity = 20000;
  input.metrics.dayTradeCount = 3;
  const decision = reviewRisk(input);
  assert.equal(decision.status, "approved");
});

test("equity 30k + daytrade_count 3 -> BUY approved (equity at/above $25k, rule doesn't apply)", () => {
  const input = baseInput() as any;
  input.metrics.accountEquity = 30000;
  input.metrics.dayTradeCount = 3;
  const decision = reviewRisk(input);
  assert.equal(decision.status, "approved");
});

test("equity 20k + daytrade_count 2 -> BUY approved (under the 3-trade limit)", () => {
  const input = baseInput() as any;
  input.metrics.accountEquity = 20000;
  input.metrics.dayTradeCount = 2;
  const decision = reviewRisk(input);
  assert.equal(decision.status, "approved");
});

test("unparsable daytrade_count -> BUY rejected (fail closed)", () => {
  const input = baseInput() as any;
  input.metrics.accountEquity = 20000;
  input.metrics.dayTradeCount = "garbage";
  const decision = reviewRisk(input);
  assert.equal(decision.status, "rejected");
  assert.match(decision.reason, /metrics\.dayTradeCount/);
});

test("missing daytrade_count field entirely -> BUY rejected (treated as unparsable)", () => {
  const input = baseInput() as any;
  delete input.metrics.dayTradeCount;
  const decision = reviewRisk(input);
  assert.equal(decision.status, "rejected");
  assert.match(decision.reason, /metrics\.dayTradeCount/);
});

test("unparsable daytrade_count does NOT block a SELL (fail-closed is buy-only, matching dailyLoss's asymmetry)", () => {
  const input = baseInput() as any;
  input.intent.side = "sell";
  input.metrics.dayTradeCount = "garbage";
  const decision = reviewRisk(input);
  assert.equal(decision.status, "approved");
});

test("unparsable accountEquity -> BUY rejected (fail closed)", () => {
  const input = baseInput() as any;
  input.metrics.accountEquity = NaN;
  const decision = reviewRisk(input);
  assert.equal(decision.status, "rejected");
  assert.match(decision.reason, /metrics\.accountEquity/);
});
