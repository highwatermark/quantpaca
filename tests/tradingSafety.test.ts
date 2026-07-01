import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrokerConfigFromEnv,
  redactConfigForClient,
  submitTradeThroughPipeline,
  validateSymbol,
} from "../src/server/tradingSafety";

test("broker failure never becomes filled", async () => {
  const result = await submitTradeThroughPipeline({
    request: {
      source: "manual",
      symbol: "PLTR",
      side: "buy",
      qty: 1,
      estimatedPrice: 20,
      reasoning: "test",
    },
    brokerConfig: {
      configured: true,
      tradingMode: "paper",
      liveTradingEnabled: false,
      baseUrl: "https://paper-api.alpaca.markets/v2",
      apiKey: "key",
      secretKey: "secret",
    },
    riskDecision: { status: "approved", reason: "test approval" },
    exitPlan: {
      initialStopLossPrice: 18,
      takeProfitPrice: 24,
      timeExitAt: "2026-06-30T20:00:00.000Z",
      thesisInvalidation: "invalidated",
      regimeChangeAction: "close",
      emergencyAction: "market_sell",
    },
    brokerSubmit: async () => {
      throw new Error("Alpaca rejected order");
    },
  });

  assert.equal(result.trade.status, "BrokerFailed");
  assert.equal(result.trade.brokerOrderId, undefined);
  assert.match(result.auditEvents.at(-1)?.message || "", /Alpaca rejected order/);
});

test("live trading is blocked unless explicitly enabled", () => {
  const config = buildBrokerConfigFromEnv({
    ALPACA_API_KEY: "live-key",
    ALPACA_SECRET_KEY: "live-secret",
    ALPACA_BASE_URL: "https://api.alpaca.markets/v2",
    TRADING_MODE: "live",
  });

  assert.equal(config.tradingMode, "live");
  assert.equal(config.liveTradingEnabled, false);
});

test("invalid symbols are rejected before broker submission", async () => {
  const result = await submitTradeThroughPipeline({
    request: {
      source: "manual",
      symbol: "DROP TABLE",
      side: "buy",
      qty: 1,
      estimatedPrice: 20,
      reasoning: "test",
    },
    brokerConfig: buildBrokerConfigFromEnv({ TRADING_MODE: "paper" }),
    riskDecision: { status: "approved", reason: "test approval" },
    exitPlan: {
      initialStopLossPrice: 18,
      takeProfitPrice: 24,
      timeExitAt: "2026-06-30T20:00:00.000Z",
      thesisInvalidation: "invalidated",
      regimeChangeAction: "close",
      emergencyAction: "market_sell",
    },
    brokerSubmit: async () => {
      throw new Error("broker should not be called");
    },
  });

  assert.equal(validateSymbol("DROP TABLE").valid, false);
  assert.equal(result.trade.status, "RiskRejected");
});

test("orders require risk approval and an exit plan", async () => {
  const missingExitPlan = await submitTradeThroughPipeline({
    request: {
      source: "manual",
      symbol: "PLTR",
      side: "buy",
      qty: 1,
      estimatedPrice: 20,
      reasoning: "test",
    },
    brokerConfig: buildBrokerConfigFromEnv({ TRADING_MODE: "paper" }),
    riskDecision: { status: "approved", reason: "test approval" },
    exitPlan: undefined,
    brokerSubmit: async () => ({ id: "broker-1", status: "accepted" }),
  });

  assert.equal(missingExitPlan.trade.status, "RiskRejected");

  const rejectedRisk = await submitTradeThroughPipeline({
    request: {
      source: "manual",
      symbol: "PLTR",
      side: "buy",
      qty: 1,
      estimatedPrice: 20,
      reasoning: "test",
    },
    brokerConfig: buildBrokerConfigFromEnv({ TRADING_MODE: "paper" }),
    riskDecision: { status: "rejected", reason: "daily loss limit" },
    exitPlan: {
      initialStopLossPrice: 18,
      takeProfitPrice: 24,
      timeExitAt: "2026-06-30T20:00:00.000Z",
      thesisInvalidation: "invalidated",
      regimeChangeAction: "close",
      emergencyAction: "market_sell",
    },
    brokerSubmit: async () => ({ id: "broker-1", status: "accepted" }),
  });

  assert.equal(rejectedRisk.trade.status, "RiskRejected");
});

test("unknown or missing risk status never reaches the broker", async () => {
  for (const status of [undefined, "aproved", "APPROVED", "ok", 42] as any[]) {
    let brokerCalled = false;
    const result = await submitTradeThroughPipeline({
      request: {
        source: "manual",
        symbol: "PLTR",
        side: "buy",
        qty: 1,
        estimatedPrice: 20,
        reasoning: "allowlist test",
      },
      brokerConfig: {
        configured: true,
        tradingMode: "paper",
        liveTradingEnabled: false,
        baseUrl: "https://paper-api.alpaca.markets/v2",
      },
      riskDecision: { status, reason: "synthetic" } as any,
      exitPlan: {
        initialStopLossPrice: 19,
        takeProfitPrice: 23,
        timeExitAt: "2026-06-30T20:00:00.000Z",
        thesisInvalidation: "n/a",
        regimeChangeAction: "close",
        emergencyAction: "market_sell",
      },
      brokerSubmit: async () => {
        brokerCalled = true;
        return { id: "should-never-happen", status: "accepted" };
      },
    });
    assert.equal(brokerCalled, false, `broker was called for status ${String(status)}`);
    assert.equal(result.trade.status, "RiskRejected");
  }
});

test("config responses do not expose broker secrets", () => {
  const redacted = redactConfigForClient({
    alpaca: {
      apiKeyId: "persisted-key",
      secretKey: "persisted-secret",
      paper: true,
    },
    notion: { token: "notion-secret", databaseId: "db" },
    telegram: { botToken: "telegram-secret", chatId: "chat", enabled: true },
    google: { spreadsheetId: "sheet", enabled: true },
    system: {
      autoTrading: false,
      runIntervalMins: 15,
      maxPositionSizePercent: 10,
      stopLossPercent: 5,
      targetProfitPercent: 15,
    },
  });

  assert.equal(redacted.alpaca.apiKeyId, "");
  assert.equal(redacted.alpaca.secretKey, "");
  assert.equal(redacted.broker.tradingMode, "paper");
  assert.equal("token" in redacted.notion, false);
  assert.equal("botToken" in redacted.telegram, false);
});
