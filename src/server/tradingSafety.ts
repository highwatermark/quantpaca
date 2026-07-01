import { AppConfig, Trade } from "../types";

export type TradingMode = "paper" | "live";

export type BrokerConfig = {
  configured: boolean;
  tradingMode: TradingMode;
  liveTradingEnabled: boolean;
  baseUrl: string;
  apiKey?: string;
  secretKey?: string;
};

export type TradeState =
  | "PendingApproval"
  | "BrokerSubmitted"
  | "Accepted"
  | "PartiallyFilled"
  | "Filled"
  | "Rejected"
  | "Canceled"
  | "Expired"
  | "BrokerFailed"
  | "RiskRejected"
  | "ApprovalRejected"
  | "UnknownBrokerState";

export type AuditEvent = {
  id: string;
  timestamp: string;
  type: "trade_state" | "risk" | "broker" | "config" | "telegram";
  actor: string;
  entityId?: string;
  fromState?: TradeState;
  toState?: TradeState;
  message: string;
  details?: Record<string, unknown>;
};

export type ExitPlan = {
  initialStopLossPrice: number;
  takeProfitPrice?: number;
  trailingStopPercent?: number;
  timeExitAt: string;
  thesisInvalidation: string;
  regimeChangeAction: "hold" | "reduce" | "close";
  emergencyAction: "market_sell" | "cancel_orders" | "manual_review";
};

export type RiskDecision = {
  status: "approved" | "approved_with_reduced_size" | "rejected" | "requires_human_approval";
  reason: string;
  adjustedQty?: number;
};

export type TradeRequest = {
  source: "manual" | "telegram" | "automation" | "stop_loss" | "emergency";
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  estimatedPrice: number;
  reasoning: string;
  actor?: string;
};

export type PipelineTrade = Trade & {
  status: TradeState;
  source: TradeRequest["source"];
  brokerOrderId?: string;
  brokerStatus?: string;
  exitPlan?: ExitPlan;
  riskDecision?: RiskDecision;
};

type BrokerOrderResponse = {
  id?: string;
  status?: string;
  filled_qty?: string;
};

type SubmitTradeInput = {
  request: TradeRequest;
  brokerConfig: BrokerConfig;
  riskDecision: RiskDecision;
  exitPlan?: ExitPlan;
  brokerSubmit: () => Promise<BrokerOrderResponse>;
  now?: () => Date;
};

const PAPER_ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
const LIVE_ALPACA_BASE_URL = "https://api.alpaca.markets/v2";

export function buildBrokerConfigFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): BrokerConfig {
  const tradingMode: TradingMode = env.TRADING_MODE === "live" ? "live" : "paper";
  const defaultBaseUrl = tradingMode === "live" ? LIVE_ALPACA_BASE_URL : PAPER_ALPACA_BASE_URL;
  const apiKey = env.ALPACA_API_KEY || undefined;
  const secretKey = env.ALPACA_SECRET_KEY || undefined;
  const liveTradingEnabled = env.LIVE_TRADING_ENABLED === "true";

  return {
    configured: Boolean(apiKey && secretKey),
    tradingMode,
    liveTradingEnabled,
    baseUrl: normalizeAlpacaBaseUrl(env.ALPACA_BASE_URL || defaultBaseUrl),
    apiKey,
    secretKey,
  };
}

export function validateSymbol(symbol: string): { valid: boolean; normalized?: string; reason?: string } {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) {
    return { valid: false, reason: "Symbol must be 1-10 uppercase ticker characters, digits, dots, or dashes." };
  }
  return { valid: true, normalized };
}

export function redactConfigForClient(config: Partial<AppConfig> = {}) {
  const broker = buildBrokerConfigFromEnv(process.env);
  return {
    alpaca: {
      apiKeyId: "",
      secretKey: "",
      paper: broker.tradingMode !== "live",
    },
    notion: {
      databaseId: config.notion?.databaseId || "",
    },
    telegram: {
      chatId: config.telegram?.chatId || "",
      enabled: Boolean(config.telegram?.enabled),
    },
    google: {
      spreadsheetId: config.google?.spreadsheetId || "",
      enabled: Boolean(config.google?.enabled),
    },
    system: {
      autoTrading: Boolean(config.system?.autoTrading),
      runIntervalMins: config.system?.runIntervalMins || 15,
      maxPositionSizePercent: config.system?.maxPositionSizePercent || 10,
      stopLossPercent: config.system?.stopLossPercent || 5,
      targetProfitPercent: config.system?.targetProfitPercent || 15,
    },
    broker: {
      configured: broker.configured,
      tradingMode: broker.tradingMode,
      liveTradingEnabled: broker.liveTradingEnabled,
      baseUrl: broker.baseUrl,
    },
  };
}

export function stripPersistedSecrets(config: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    ...config,
    alpaca: {
      apiKeyId: "",
      secretKey: "",
      paper: buildBrokerConfigFromEnv(process.env).tradingMode !== "live",
    },
    notion: {
      token: "",
      databaseId: config.notion?.databaseId || "",
    },
    telegram: {
      botToken: "",
      chatId: config.telegram?.chatId || "",
      enabled: Boolean(config.telegram?.enabled),
    },
  };
}


export async function submitTradeThroughPipeline(input: SubmitTradeInput): Promise<{
  trade: PipelineTrade;
  auditEvents: AuditEvent[];
}> {
  const now = input.now || (() => new Date());
  const timestamp = now().toISOString();
  const auditEvents: AuditEvent[] = [];
  const normalizedSymbol = validateSymbol(input.request.symbol);
  const qty = input.riskDecision.adjustedQty || input.request.qty;

  const baseTrade: PipelineTrade = {
    id: `tr-${Math.random().toString(36).slice(2, 10)}`,
    symbol: normalizedSymbol.normalized || input.request.symbol,
    qty,
    price: input.request.estimatedPrice,
    side: input.request.side,
    status: "PendingApproval",
    source: input.request.source,
    timestamp,
    reasoning: input.request.reasoning,
    notifiedTelegram: false,
    exportedSheets: false,
    loggedNotion: false,
    riskDecision: input.riskDecision,
    exitPlan: input.exitPlan,
  };

  const audit = (toState: TradeState, message: string, fromState?: TradeState, details?: Record<string, unknown>) => {
    auditEvents.push({
      id: `ae-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: now().toISOString(),
      type: toState === "RiskRejected" ? "risk" : "trade_state",
      actor: input.request.actor || input.request.source,
      entityId: baseTrade.id,
      fromState,
      toState,
      message,
      details,
    });
    baseTrade.status = toState;
  };

  if (!normalizedSymbol.valid) {
    audit("RiskRejected", normalizedSymbol.reason || "Invalid symbol.", "PendingApproval");
    return { trade: baseTrade, auditEvents };
  }
  if (!input.exitPlan) {
    audit("RiskRejected", "Order blocked because no exit plan is attached.", "PendingApproval");
    return { trade: baseTrade, auditEvents };
  }
  if (input.riskDecision.status === "rejected" || input.riskDecision.status === "requires_human_approval") {
    audit("RiskRejected", input.riskDecision.reason, "PendingApproval");
    return { trade: baseTrade, auditEvents };
  }
  if (input.brokerConfig.tradingMode === "live" && !input.brokerConfig.liveTradingEnabled) {
    audit("RiskRejected", "Live trading is blocked unless LIVE_TRADING_ENABLED=true.", "PendingApproval");
    return { trade: baseTrade, auditEvents };
  }

  audit("BrokerSubmitted", "Broker submission started.", "PendingApproval");

  try {
    const brokerOrder = await input.brokerSubmit();
    baseTrade.brokerOrderId = brokerOrder.id;
    baseTrade.brokerStatus = brokerOrder.status;
    const mappedState = mapBrokerStatusToTradeState(brokerOrder.status);
    audit(mappedState, `Broker returned status ${brokerOrder.status || "unknown"}.`, "BrokerSubmitted", {
      brokerOrderId: brokerOrder.id,
      brokerStatus: brokerOrder.status,
    });
    return { trade: baseTrade, auditEvents };
  } catch (error: any) {
    audit("BrokerFailed", error?.message || "Broker submission failed.", "BrokerSubmitted");
    return { trade: baseTrade, auditEvents };
  }
}

export function mapBrokerStatusToTradeState(status?: string): TradeState {
  switch ((status || "").toLowerCase()) {
    case "accepted":
    case "new":
    case "pending_new":
      return "Accepted";
    case "partially_filled":
      return "PartiallyFilled";
    case "filled":
      return "Filled";
    case "rejected":
      return "Rejected";
    case "canceled":
    case "cancelled":
      return "Canceled";
    case "expired":
      return "Expired";
    default:
      return "UnknownBrokerState";
  }
}

function normalizeAlpacaBaseUrl(url: string) {
  const trimmed = url.replace(/\/$/, "");
  return trimmed.endsWith("/v2") ? trimmed : `${trimmed}/v2`;
}

