import test from "node:test";
import assert from "node:assert/strict";
import { reviewRisk } from "../src/server/riskEngine";

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
  breaker: { status: "ok" as const },
  // accountEquity/dayTradeCount (Phase 2 Task 3, PDT guard): required-for-buy
  // like dailyLoss above. Defaults here are safely outside the PDT rule
  // (equity >= $25k) so they don't interfere with the pre-existing checks
  // this file targets.
  metrics: { dailyLoss: 0, dailyTradeCount: 0, openPositionCount: 0, accountEquity: 100000, dayTradeCount: 0 },
  limits: { maxDailyLoss: 500, maxDailyTradeCount: 10, maxOpenPositions: 10, minBuyingPower: 100 },
});

const BAD: unknown[] = [NaN, Infinity, -Infinity, undefined, null, "", "garbage"];

test("invalid metric values reject instead of silently passing", () => {
  for (const bad of BAD) {
    const input = baseInput() as any;
    input.metrics.dailyLoss = bad;
    assert.equal(reviewRisk(input).status, "rejected", `dailyLoss=${String(bad)} must reject`);
  }
});

test("invalid limit values reject instead of disabling the guardrail", () => {
  for (const bad of BAD) {
    const input = baseInput() as any;
    input.limits.maxDailyLoss = bad;
    assert.equal(reviewRisk(input).status, "rejected", `maxDailyLoss=${String(bad)} must reject`);
  }
});

test("NaN qty from a malformed request rejects", () => {
  const input = baseInput() as any;
  input.intent.qty = Number("garbage");
  input.intent.notional = Number("garbage") * 20;
  assert.equal(reviewRisk(input).status, "rejected");
});

test("valid input still approves", () => {
  assert.equal(reviewRisk(baseInput() as any).status, "approved");
});

test("sell intent with unavailable dailyLoss (NaN) still approves — sells reduce risk", () => {
  const input = baseInput() as any;
  input.intent.side = "sell";
  input.intent.qty = 5;
  input.intent.notional = 100;
  input.metrics.dailyLoss = NaN;
  assert.equal(reviewRisk(input).status, "approved");
});

test("buy intent with unavailable dailyLoss (NaN) still rejects — side asymmetry", () => {
  const input = baseInput() as any;
  input.intent.side = "buy";
  input.metrics.dailyLoss = NaN;
  assert.equal(reviewRisk(input).status, "rejected");
});
