import { createHash } from "node:crypto";
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
  // "sync" (Phase 2 Task 2, docs/GO_LIVE_PLAN.md Phase 2.1): a sync cycle's
  // trigger-source marker and other scheduler-lifecycle events (auto-pause,
  // per-cycle BUY cap skips reuse "risk"/"config" like their existing
  // manual-override analogues -- "sync" is only for events that don't fit
  // any of the pre-existing categories).
  // "backup" (Phase 2 Task 13, docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backup
  // failures (backupEngine.ts) -- backups never crash a cycle, so this is the
  // only trace of a failed backup attempt besides the log line.
  type: "trade_state" | "risk" | "broker" | "config" | "telegram" | "breaker" | "sync" | "backup";
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
  // Entry price the plan was created against. Needed to determine whether a
  // position has ever appreciated (highWaterMark > entryPrice) -- the signal
  // that decides whether the trailing stop or the initial stop-loss governs
  // a retrace. Optional so plans persisted before this field existed (or
  // constructed directly in tests without it) simply never engage trailing.
  entryPrice?: number;
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
  // "broker_leg_fill" (Task 5 / bracket-orders review finding C1): the ONE
  // synthetic source used exclusively for the SELL-side ledger entry
  // orderStatusPoller.ts's applyLegPollResult synthesizes when it discovers a
  // bracket leg (take-profit/stop-loss) filled BROKER-side. No TradeRequest is
  // ever actually built with this source (no order is submitted) -- it exists
  // purely so the synthetic PipelineTrade record it produces is honestly
  // labeled in the ledger/audit trail as "the system recorded this, the
  // broker did the actual selling" rather than being misattributed to
  // "automation" or "stop_loss" (both of which imply this process placed a
  // real sell order).
  source: "manual" | "telegram" | "automation" | "stop_loss" | "emergency" | "broker_leg_fill";
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  estimatedPrice: number;
  reasoning: string;
  actor?: string;
  // Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, cross-source
  // confirmation): set true only by the sync decision loop (server.ts), only
  // for a BUY whose stance conflicted with a bearish signal from another
  // source within the confirmation window (crossSourceConfirmation.ts).
  // executeTradeIntent threads this into reviewRisk's additive
  // crossSourceConflictSymbols input -- see riskEngine.ts. Every other call
  // site (manual override, Telegram, stop-loss, emergency close) omits it,
  // so those paths are unaffected.
  crossSourceConflict?: boolean;
};

export type PipelineTrade = Trade & {
  status: TradeState;
  source: TradeRequest["source"];
  brokerOrderId?: string;
  brokerStatus?: string;
  exitPlan?: ExitPlan;
  riskDecision?: RiskDecision;
  // Task 13 (idempotent orders): the deterministic id sent to Alpaca as
  // client_order_id on every broker submission for this trade (see
  // deriveClientOrderId below). Recorded here -- not just handed to the broker
  // and forgotten -- so Phase 2 reconciliation can join this local trade back
  // to the broker order it produced.
  clientOrderId?: string;
  // Task 4 (broker-native bracket orders, docs/GO_LIVE_PLAN.md Phase 2.2): the
  // broker order ids of a bracket's take_profit/stop_loss child legs, when
  // this trade was submitted as a bracket. Additive field on the existing
  // trade_intents JSON payload -- no schema migration needed (see
  // persistence.ts saveTradeIntent, which already stores the full trade as
  // JSON). Undefined for plain (non-bracket) orders: SELLs, fallback plain
  // orders after a degenerate-plan or bracket-rejection fail-open, and any
  // trade that never reached the broker.
  brokerLegOrderIds?: string[];
  // Task 5 (order-status polling, docs/GO_LIVE_PLAN.md Phase 2.2): the last
  // known TradeState for each entry in brokerLegOrderIds, keyed by leg order
  // id -- see src/server/orderStatusPoller.ts. Lets cancelBracketLegsBeforeSell
  // (server.ts) skip a leg that a prior poll already found terminal
  // (filled/canceled/expired/rejected) instead of issuing a DELETE against an
  // order the broker will reject as "not cancelable" (closes bracket-orders
  // review finding 2). Additive JSON field, same no-migration story as
  // brokerLegOrderIds above. Undefined/missing entries are treated as "not yet
  // known terminal" -- fail open to polling/canceling that leg, never assumed
  // terminal by absence.
  brokerLegStates?: Record<string, TradeState>;
  // Task 5: the broker-reported filled_qty and (requested qty - filledQty) the
  // last time this trade's own order was polled. Only meaningful once the
  // trade has reached PartiallyFilled or Filled -- undefined beforehand (never
  // defaulted to 0, so "never polled" stays distinguishable from "confirmed
  // zero filled").
  filledQty?: number;
  remainingQty?: number;
  // Task 5: set whenever the most recent poll of this trade's OWN order (not
  // its legs) failed to reach the broker or returned a non-OK response.
  // Cleared (set back to undefined) the next time a poll succeeds. The order's
  // `status` is deliberately left untouched when this is set -- "never invent
  // a fill": a poll failure must never advance or regress the locally known
  // state, only flag that the state is now unconfirmed as of this cycle.
  lastPollError?: string;
  // Task 5: set on the ENTRY trade when a poll of one of its bracket legs
  // discovers that leg filled -- i.e. the position was closed BROKER-side
  // (take-profit or stop-loss executed), not by this system's own software
  // exit path. Informational/audit bookkeeping: the position no longer shows
  // up in Alpaca's live /positions once this happens, so MODULE 2's exit
  // evaluation already stops considering it naturally; this field just makes
  // that fact visible on the trade record and in the audit trail instead of
  // silently disappearing.
  exitClosedBrokerSide?: { legId: string; legType: string; price?: number; at: string };
  // Set alongside exitClosedBrokerSide, same moment: this entry's exit plan
  // is done -- the position it protected was closed BROKER-side, not by a
  // software sell this system placed. Closes the Task-5 deferred "exit-plan
  // completion audit-only" item (bracket-orders review finding C1, same
  // root as exitClosedBrokerSide/the missing SELL-side ledger entry): before
  // this field existed, exitClosedBrokerSide was purely informational --
  // nothing recorded, on the trade record itself, that the plan it belongs to
  // had actually run its course. Never set false; simply absent until a leg
  // fill sets it true.
  exitPlanComplete?: boolean;
};

// Task 5 (order-status polling): trade states that mean an order actually
// reached the broker and was accepted in some live/filled form -- the set
// latestBuySideExitPlanForSymbol (persistence.ts) and cancelBracketLegsBeforeSell
// (server.ts) key "is this trade still the live entry for this symbol's open
// lot" on. Moved here (was a server.ts-local const) so persistence.ts can
// reuse the exact same set instead of forking its own copy -- see the C1 fix
// this task closes (docs/GO_LIVE_PLAN.md Phase 2.2, bracket-orders review
// finding 1) for why persistence.ts now needs it too.
export const BROKER_SUCCESS_TRADE_STATUSES: ReadonlySet<TradeState> = new Set([
  "Accepted",
  "PartiallyFilled",
  "Filled",
]);

type BrokerOrderResponse = {
  id?: string;
  status?: string;
  filled_qty?: string;
  // Alpaca's bracket-order response includes the take_profit/stop_loss child
  // orders it created alongside the entry. Only present on a bracket order.
  legs?: Array<{ id?: string }>;
};

type SubmitTradeInput = {
  request: TradeRequest;
  brokerConfig: BrokerConfig;
  riskDecision: RiskDecision;
  exitPlan?: ExitPlan;
  // Receives the deterministic client_order_id derived for this intent (see
  // deriveClientOrderId) so every broker order carries it -- Task 13.
  brokerSubmit: (clientOrderId: string) => Promise<BrokerOrderResponse>;
  now?: () => Date;
};

const PAPER_ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
const LIVE_ALPACA_BASE_URL = "https://api.alpaca.markets/v2";

// Alpaca's client_order_id is capped at 128 chars. "qp-" (greppable prefix) + a
// 64-char sha256 hex digest = 67 chars, comfortably inside that limit.
const CLIENT_ORDER_ID_PREFIX = "qp-";

/**
 * Deterministic client_order_id for every Alpaca order (Task 13: idempotent
 * orders). Alpaca deduplicates orders sharing a client_order_id -- without one,
 * any retry/race/double-submit of the same intent creates a second real order.
 *
 * This is derived from the intent's stable CONTENT, not a stable intent id,
 * because none exists on any call path: submitTradeThroughPipeline mints a
 * fresh `tr-${Math.random()...}` trade id on every call (see baseTrade.id
 * below), and executeTradeIntent's (server.ts) risk-review `intent.id` is
 * `intent-${Date.now()}` -- both regenerate on every attempt, including a
 * resubmission of the exact same logical order, so neither can serve as a
 * hash input for a *stable* client_order_id. Per the Task 13 brief, the
 * documented fallback is content-based: symbol|side|qty|source|date.
 *
 * Tradeoff (intentional, documented): two genuinely different orders that
 * happen to share symbol+side+qty+source within the same UTC day will collide
 * and be treated by Alpaca as the same order -- the second one will NOT create
 * a second position. This hash is a same-day RETRY/idempotency key, not a
 * global uniqueness key across distinct trading decisions. If the system gains
 * a stable per-signal/per-decision id later (Phase 2+), prefer hashing that
 * instead and drop the content-based fallback.
 */
export function deriveClientOrderId(input: {
  symbol: string;
  side: string;
  qty: number;
  source: string;
  date: string;
}): string {
  const material = `${input.symbol}|${input.side}|${input.qty}|${input.source}|${input.date}`;
  const digest = createHash("sha256").update(material).digest("hex");
  return `${CLIENT_ORDER_ID_PREFIX}${digest}`;
}

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
  // Derived unconditionally, on every path (including ones that never reach the
  // broker, e.g. RiskRejected) so the trade record always carries it -- Task
  // 13's requirement that the mapping is recorded "for consistency" regardless
  // of outcome.
  const clientOrderId = deriveClientOrderId({
    symbol: normalizedSymbol.normalized || input.request.symbol,
    side: input.request.side,
    qty,
    source: input.request.source,
    date: timestamp.slice(0, 10),
  });

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
    clientOrderId,
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
  const APPROVED_RISK_STATUSES: ReadonlyArray<RiskDecision["status"]> = [
    "approved",
    "approved_with_reduced_size",
  ];
  if (!APPROVED_RISK_STATUSES.includes(input.riskDecision.status)) {
    audit(
      "RiskRejected",
      input.riskDecision.reason ||
        `Risk status "${String(input.riskDecision.status)}" is not an approved status.`,
      "PendingApproval",
    );
    return { trade: baseTrade, auditEvents };
  }
  if (input.brokerConfig.tradingMode === "live" && !input.brokerConfig.liveTradingEnabled) {
    audit("RiskRejected", "Live trading is blocked unless LIVE_TRADING_ENABLED=true.", "PendingApproval");
    return { trade: baseTrade, auditEvents };
  }

  audit("BrokerSubmitted", "Broker submission started.", "PendingApproval");

  try {
    const brokerOrder = await input.brokerSubmit(clientOrderId);
    baseTrade.brokerOrderId = brokerOrder.id;
    baseTrade.brokerStatus = brokerOrder.status;
    // Task 4: record the bracket's child-leg order ids, if any, so the next
    // task (order-status polling) and reconciliation can track them. Filters
    // out any leg missing a usable string id rather than trusting the broker
    // response blindly.
    if (Array.isArray(brokerOrder.legs)) {
      const legIds = brokerOrder.legs
        .map((leg) => leg?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (legIds.length > 0) baseTrade.brokerLegOrderIds = legIds;
    }
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

