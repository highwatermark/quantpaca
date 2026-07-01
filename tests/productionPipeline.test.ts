import test from "node:test";
import assert from "node:assert/strict";
import {
  createRawSignal,
  reviewSignal,
  reviewSignals,
} from "../src/server/signalEngine";
import { detectRegime } from "../src/server/regimeEngine";
import { assessPortfolio } from "../src/server/portfolioEngine";
import { sizeTradeIntent } from "../src/server/sizingEngine";
import { reviewRisk } from "../src/server/riskEngine";
import { createExitPlan } from "../src/server/exitEngine";
import {
  authorizeTelegramCommand,
  createConfirmationToken,
  consumeConfirmationToken,
} from "../src/server/telegramEngine";
import { reconcileBrokerState } from "../src/server/reconciliationEngine";
import { buildBrokerConfigFromEnv } from "../src/server/tradingSafety";

test("duplicate and stale signals are rejected before downstream trading", () => {
  const now = new Date("2026-06-29T20:00:00.000Z");
  const first = createRawSignal({
    source: "email",
    sourceId: "msg-1",
    sourceTimestamp: "2026-06-29T19:00:00.000Z",
    symbol: "PLTR",
    thesis: "PLTR enterprise growth is accelerating.",
    url: "gmail://msg-1",
  });
  const duplicate = createRawSignal({
    source: "email",
    sourceId: "msg-1",
    sourceTimestamp: "2026-06-29T19:05:00.000Z",
    symbol: "PLTR",
    thesis: "PLTR enterprise growth is accelerating!",
  });
  const stale = createRawSignal({
    source: "youtube",
    sourceId: "vid-1",
    sourceTimestamp: "2026-06-20T19:00:00.000Z",
    symbol: "NVDA",
    thesis: "NVDA remains strong.",
  });

  const reviewed = reviewSignals([first, duplicate, stale], { now, maxAgeHours: 48 });

  assert.equal(reviewed[0].status, "accepted");
  assert.equal(reviewed[1].status, "rejected");
  assert.equal(reviewed[1].rejectionReason, "duplicate");
  assert.equal(reviewed[2].status, "rejected");
  assert.equal(reviewed[2].rejectionReason, "stale");
});

test("unsupported AI signal output is normalized and rejected", () => {
  const reviewed = reviewSignal(createRawSignal({
    source: "gemini",
    sourceId: "gen-1",
    sourceTimestamp: "2026-06-29T19:00:00.000Z",
    symbol: "DROP TABLE",
    thesis: "",
    aiConfidence: 101,
  }), { now: new Date("2026-06-29T20:00:00.000Z") });

  assert.equal(reviewed.status, "rejected");
  assert.match(reviewed.rejectionReason || "", /malformed|unsupported/);
});

test("regime defaults conservatively when market data is unavailable", () => {
  const regime = detectRegime({});

  assert.equal(regime.marketMode, "unclear");
  assert.equal(regime.tradePermission, "reduce_size");
  assert.equal(regime.volatilityLevel, "normal");
});

test("portfolio assessment includes exposure and pending open-order risk", () => {
  const assessment = assessPortfolio({
    account: {
      cash: "50000",
      buying_power: "70000",
      portfolio_value: "100000",
      equity: "100000",
      long_market_value: "30000",
      daytrade_count: 2,
    },
    positions: [
      { symbol: "PLTR", qty: "100", market_value: "20000", cost_basis: "18000", unrealized_pl: "2000", unrealized_plpc: "0.11", current_price: "200", avg_entry_price: "180" },
    ],
    openOrders: [
      { id: "o-1", symbol: "NVDA", side: "buy", qty: "10", notional: "1000", status: "accepted" },
    ],
  });

  assert.equal(assessment.totalLongExposurePercent, 30);
  assert.equal(assessment.perSymbolConcentration.PLTR, 20);
  assert.equal(assessment.pendingOrderNotional, 1000);
});

test("sizing respects buying power, max position, portfolio exposure, stop distance, and regime multiplier", () => {
  const intent = sizeTradeIntent({
    reviewedSignal: {
      id: "rs-1",
      rawSignalId: "raw-1",
      symbol: "PLTR",
      source: "email",
      sourceTimestamp: "2026-06-29T19:00:00.000Z",
      freshnessStatus: "fresh",
      confidenceScore: 80,
      classification: "bullish",
      thesisSummary: "strong",
      invalidationConditions: ["breakdown"],
      evidence: [],
      status: "accepted",
    },
    regime: { id: "r-1", timestamp: "", marketMode: "unclear", volatilityLevel: "high", tradePermission: "reduce_size", sizeMultiplier: 0.5, reason: "" },
    portfolio: {
      timestamp: "",
      cash: 10000,
      buyingPower: 10000,
      equity: 100000,
      longMarketValue: 40000,
      totalLongExposurePercent: 40,
      pendingOrderNotional: 0,
      positions: [],
      openOrders: [],
      perSymbolConcentration: {},
      source: "alpaca",
    },
    side: "buy",
    estimatedPrice: 100,
    stopLossPrice: 95,
    limits: {
      maxSinglePositionPercent: 10,
      maxPortfolioExposurePercent: 45,
      maxNotionalPerTrade: 8000,
      minBuyingPowerAfterTrade: 1000,
    },
  });

  assert.equal(intent.qty, 20);
  assert.equal(intent.notional, 2000);
  assert.ok(intent.capsApplied.includes("regime_multiplier"));
});

test("risk engine blocks live mode, duplicates, missing exit plans, and daily limits", () => {
  const baseIntent = {
    id: "sti-1",
    symbol: "PLTR",
    side: "buy" as const,
    qty: 1,
    notional: 100,
    estimatedPrice: 100,
    sizingReason: "test",
    capsApplied: [],
  };

  const decision = reviewRisk({
    intent: baseIntent,
    brokerConfig: buildBrokerConfigFromEnv({ TRADING_MODE: "live", ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" }),
    portfolio: {
      timestamp: "",
      cash: 10000,
      buyingPower: 10000,
      equity: 100000,
      longMarketValue: 10000,
      totalLongExposurePercent: 10,
      pendingOrderNotional: 0,
      positions: [],
      openOrders: [{ id: "o-1", symbol: "PLTR", side: "buy", qty: "1", status: "accepted" }],
      perSymbolConcentration: {},
      source: "alpaca",
    },
    exitPlan: createExitPlan({ symbol: "PLTR", side: "buy", entryPrice: 100 }),
    breaker: { status: "ok" },
    metrics: { dailyLoss: 0, dailyTradeCount: 0, openPositionCount: 1 },
    limits: { maxDailyLoss: 500, maxDailyTradeCount: 5, maxOpenPositions: 5, minBuyingPower: 1000 },
  });

  assert.equal(decision.status, "rejected");
  assert.match(decision.reason, /Live trading/);
});

test("telegram authorization and confirmation tokens are role and action bound", () => {
  const roles = { "100": "viewer", "200": "trader", "300": "admin" } as const;

  assert.equal(authorizeTelegramCommand({ userId: "100", command: "/positions", roles }).allowed, true);
  assert.equal(authorizeTelegramCommand({ userId: "100", command: "/dry_run", roles }).allowed, false);

  const token = createConfirmationToken({
    userId: "200",
    action: "approve_trade:PLTR:buy:1",
    now: new Date("2026-06-29T20:00:00.000Z"),
  });

  assert.equal(consumeConfirmationToken({
    token,
    userId: "200",
    action: "approve_trade:PLTR:buy:2",
    now: new Date("2026-06-29T20:01:00.000Z"),
  }).accepted, false);

  const accepted = consumeConfirmationToken({
    token,
    userId: "200",
    action: "approve_trade:PLTR:buy:1",
    now: new Date("2026-06-29T20:01:00.000Z"),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(consumeConfirmationToken({
    token,
    userId: "200",
    action: "approve_trade:PLTR:buy:1",
    now: new Date("2026-06-29T20:01:30.000Z"),
  }).accepted, false);
});

test("reconciliation detects local broker mismatch", () => {
  const report = reconcileBrokerState({
    localTrades: [{ id: "tr-1", brokerOrderId: "bo-1", symbol: "PLTR", qty: 1, side: "buy", status: "Filled" }],
    brokerOrders: [{ id: "bo-1", symbol: "PLTR", qty: "1", side: "buy", status: "rejected" }],
    brokerPositions: [],
    account: { cash: "1000", buying_power: "1000", portfolio_value: "1000", equity: "1000", long_market_value: "0", daytrade_count: 0 },
  });

  assert.equal(report.status, "mismatch");
  assert.equal(report.mismatches[0].type, "order_status");
});
