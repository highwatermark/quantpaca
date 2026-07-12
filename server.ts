import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { AppConfig, StockAnalysis, Trade, SyncLog } from "./src/types";
import {
  AuditEvent,
  BrokerConfig,
  buildBrokerConfigFromEnv,
  redactConfigForClient,
  RiskDecision,
  stripPersistedSecrets,
  submitTradeThroughPipeline,
  TradeRequest,
} from "./src/server/tradingSafety";
import { createProductionStore } from "./src/server/persistence";
import { createRawSignal } from "./src/server/signalEngine";
import { applyWhipsawGate, normalizeWhipsawVerdict } from "./src/server/whipsawGate";
import { reviewAndPersistSignal } from "./src/server/signalReviewStep";
import { extractEmailScanTarget, EmailScanTarget } from "./src/server/emailIngestion";
import { assembleScanTargets, YoutubeSentimentResult } from "./src/server/scanTargetAssembly";
import { detectRegime } from "./src/server/regimeEngine";
import { assessPortfolio } from "./src/server/portfolioEngine";
import { reconcileBrokerState } from "./src/server/reconciliationEngine";
import { authorizeTelegramCommand, ConfirmationToken, consumeConfirmationToken, createConfirmationToken, parseTelegramAdminRoles } from "./src/server/telegramEngine";
import { createExitPlan } from "./src/server/exitEngine";
import { evaluateOpenPositionExits } from "./src/server/exitMonitor";
import { reviewRisk } from "./src/server/riskEngine";
import { evaluateBreaker, BreakerState } from "./src/server/breakerEngine";
import { applyBreakerLatch, LatchEvent } from "./src/server/breakerLatch";
import { validateStartupEnv } from "./src/server/startupChecks";
import { installProcessGuards } from "./src/server/processGuards";
import { loadRiskLimits, RiskLimits } from "./src/server/riskLimits";
import { loadCooldownConfig } from "./src/server/cooldownConfig";
import { sizeTradeIntent, computeCapRoom, capRoomToQty } from "./src/server/sizingEngine";
import { fetchMarketRegimeInputs, REGIME_STALENESS_MS } from "./src/server/marketDataFetcher";
import { RegimeAssessment } from "./src/server/domainTypes";
import { parseFiniteNumber } from "./src/server/numericSafety";
import { EMPTY_SYNC_ALERT_STATE_KEY, shouldSendThrottledAlert } from "./src/server/alertThrottle";
import { createScheduler, MAX_BUYS_PER_CYCLE, MAX_CONSECUTIVE_FAILURES } from "./src/server/scheduler";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

const DATA_DIR = process.env.QUANTPACA_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const productionStore = createProductionStore(path.join(DATA_DIR, "quantpaca.sqlite"));

// Simple queue-based lock to serialize all operations that read or write to DB
class DBConcurrencyMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          next?.();
        } else {
          this.locked = false;
        }
      };

      if (!this.locked) {
        this.locked = true;
        resolve(release);
      } else {
        this.queue.push(() => {
          resolve(release);
        });
      }
    });
  }
}

const dbMutex = new DBConcurrencyMutex();

// Risk limits load ONCE at module scope (not inside run()) so that test imports of
// server.ts also get valid limits. See docs/LOOP_ARCHITECTURE.md "Structural
// Immutability of Risk Thresholds" — limits are fatal at startup if unparsable and are
// never re-read at runtime.
let riskLimits: RiskLimits;
{
  const loaded = loadRiskLimits(process.env);
  if (loaded.ok === false) {
    for (const error of loaded.errors) console.error(`[startup:fatal] ${error}`);
    console.error("[startup] Invalid risk limit configuration. Refusing to start.");
    process.exit(1);
  }
  riskLimits = loaded.limits;
}

// Same startup pattern as risk limits above: parsed once, fatal on unparsable input,
// immutable for the process lifetime. 0 is an explicit, documented escape hatch that
// disables the per-symbol cooldown (see docs/GO_LIVE_PLAN.md Phase 1.1).
let symbolCooldownHours: number;
{
  const loaded = loadCooldownConfig(process.env);
  if (loaded.ok === false) {
    for (const error of loaded.errors) console.error(`[startup:fatal] ${error}`);
    console.error("[startup] Invalid symbol cooldown configuration. Refusing to start.");
    process.exit(1);
  }
  symbolCooldownHours = loaded.config.symbolCooldownHours;
}

// Trade states that mean the order actually reached the broker — either it was
// submitted/accepted/filled, or the broker itself rejected it or the submission call
// failed/returned an unrecognized status. These are the outcomes that put a symbol in
// cooldown. RiskRejected (blocked before ever reaching the broker, e.g. insufficient
// buying power or an already-active cooldown) intentionally does NOT extend or restart
// a cooldown — those rejections are cheap and often transient.
const BROKER_REACHED_TRADE_STATUSES = new Set([
  "Accepted",
  "PartiallyFilled",
  "Filled",
  "Rejected",
  "Canceled",
  "Expired",
  "BrokerFailed",
  "UnknownBrokerState",
]);

// Trade states that mean the order was actually SUCCESSFULLY placed with the broker --
// the strict subset of BROKER_REACHED_TRADE_STATUSES above that excludes broker-side
// failures/rejections. submitTradeThroughPipeline attaches an exitPlan to the trade on
// every return path -- including RiskRejected and BrokerFailed, which never produced a
// live position -- so exit-plan persistence must be gated on this set, not merely on
// "trade.exitPlan is present". Otherwise a rejected retry/duplicate signal's freshly
// built (and never-executed) plan can overwrite latestBuySideExitPlanForSymbol's answer
// for a real, still-open position, silently changing its stop-loss/take-profit/HWM.
const BROKER_SUCCESS_TRADE_STATUSES = new Set([
  "Accepted",
  "PartiallyFilled",
  "Filled",
]);

const getBrokerConfig = () => buildBrokerConfigFromEnv(process.env);

function appendAuditEvents(db: any, events: AuditEvent[]) {
  db.auditEvents = db.auditEvents || [];
  db.auditEvents.push(...events);
  productionStore.appendAuditEvents(events);
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdminCommand(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expectedToken = process.env.ADMIN_API_TOKEN;
  if (!expectedToken) {
    res.status(503).json({
      error: "Admin command routes are disabled until ADMIN_API_TOKEN is configured.",
    });
    return;
  }
  const providedToken = req.header("x-admin-token") || "";
  if (!tokensMatch(providedToken, expectedToken)) {
    res.status(401).json({ error: "Unauthorized command request." });
    return;
  }
  next();
}

// Task 10 ("Latch the breaker", docs/GO_LIVE_PLAN.md Phase 1.4): evaluateBreaker's
// threshold math is untouched -- this only computes the same fresh evaluation the
// pre-latch code always did. Split out so both the normal trade-intent path and the
// admin reset path (which must force a fresh evaluation independent of the current
// latch) share one definition of "what does the broker say right now".
type PreviousBreakerRecord = { peakEquity: number | null; latch?: unknown };

function evaluateFreshBreaker(portfolio: any, brokerConfig: BrokerConfig, previousPeakEquity: number | null): BreakerState {
  return evaluateBreaker({
    equity: portfolio.equity,
    // Simulated portfolios have no prior-close equity; treating equity as last_equity
    // zeroes the daily-loss check offline. A REAL broker account must supply last_equity —
    // no fallback when brokerConfig.configured is true.
    lastEquity: brokerConfig.configured ? portfolio.last_equity : (portfolio.last_equity ?? portfolio.equity),
    previousPeakEquity,
    baselineEquity: riskLimits.baselineEquity,
    limits: {
      maxDailyLossPercent: riskLimits.maxDailyLossPercent,
      maxDrawdownFromPeakPercent: riskLimits.maxDrawdownFromPeakPercent,
      maxDrawdownFromBaselinePercent: riskLimits.maxDrawdownFromBaselinePercent,
    },
  });
}

function breakerLatchAuditEvent(input: {
  event: Exclude<LatchEvent, "none">;
  corrupt: boolean;
  latchedStatus: BreakerState["status"];
  fresh: BreakerState;
  actor: string;
}): AuditEvent {
  const label = input.event === "trip" ? "tripped" : "escalated";
  return {
    id: `ae-breaker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: "breaker",
    actor: input.actor,
    message: input.corrupt
      ? `Breaker latch state was corrupt/unparsable; failing closed to block_new_buys.`
      : `Breaker ${label} to ${input.latchedStatus}.`,
    details: {
      status: input.latchedStatus,
      corrupt: input.corrupt,
      equity: input.fresh.metrics.equity,
      dailyLossPercent: input.fresh.metrics.dailyLossPercent,
      drawdownFromPeakPercent: input.fresh.metrics.drawdownFromPeakPercent,
      drawdownFromBaselinePercent: input.fresh.metrics.drawdownFromBaselinePercent,
      reasons: input.fresh.reasons,
    },
  };
}

async function executeTradeIntent(input: {
  db: any;
  config: AppConfig;
  request: TradeRequest;
  maxNotional?: number;
  // Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): the order chokepoint for
  // the market-hours gate. Set true only by a SCHEDULED cycle that found the
  // clock closed (or unreachable -- fail closed); manual syncs never set
  // this (human's call). When true, the order is rejected below with an
  // honest reason before any broker call is made -- same RiskRejected path
  // every other rejection already uses, so it is audited automatically.
  marketKnownClosed?: boolean;
}) {
  const brokerConfig = getBrokerConfig();
  const portfolio = await getAlpacaPortfolio(brokerConfig);
  const portfolioAssessment = assessPortfolio({
    account: portfolio,
    positions: portfolio.positions || [],
    openOrders: await getAlpacaOpenOrders(brokerConfig),
    source: brokerConfig.configured ? "alpaca" : "local_simulated_snapshot",
  });
  const previousBreaker = productionStore.latestBreakerState<PreviousBreakerRecord>();
  const freshBreaker = evaluateFreshBreaker(portfolio, brokerConfig, previousBreaker?.peakEquity ?? null);
  // Latch wraps the fresh evaluation (breakerEngine.ts's threshold semantics are
  // never touched here): once tripped, block_new_buys/close_only persists across
  // subsequent evaluations -- even ones a fresh computation would call "ok" -- until
  // an explicit admin reset (POST /api/breaker/reset or the Telegram /breaker_reset
  // command, both below).
  const latchResult = applyBreakerLatch(freshBreaker, previousBreaker?.latch);
  const breakerState = latchResult.effective;
  const toPersist = { ...breakerState, latch: latchResult.latchState };
  productionStore.saveBreakerState(toPersist);
  if (latchResult.event !== "none") {
    appendAuditEvents(input.db, [
      breakerLatchAuditEvent({
        event: latchResult.event,
        corrupt: latchResult.corrupt,
        latchedStatus: latchResult.latchState.latchedStatus,
        fresh: freshBreaker,
        actor: "breaker_engine",
      }),
    ]);
  }
  const exitPlan = createExitPlan({
    symbol: input.request.symbol,
    side: input.request.side,
    entryPrice: input.request.estimatedPrice,
    stopLossPercent: input.config.system?.stopLossPercent,
    takeProfitPercent: input.config.system?.targetProfitPercent,
  });
  // Per-symbol cooldown only ever blocks BUYs — de-risking (a SELL) must always stay
  // available, so the cooldown set is only ever populated for buy-side intents here;
  // reviewRisk's cooldown check is never given anything to match against for a sell.
  // On a store read failure we fail closed: a buy whose cooldown state is unknown is
  // rejected outright instead of proceeding as if no cooldowns exist.
  let cooldownSymbols: string[] = [];
  let cooldownLoadFailed = false;
  if (input.request.side === "buy" && symbolCooldownHours > 0) {
    try {
      cooldownSymbols = productionStore.listActiveCooldownSymbols(new Date().toISOString());
    } catch (err) {
      console.error("[cooldown] Failed to load active cooldown symbols; failing closed on buy order.", err);
      cooldownLoadFailed = true;
    }
  }
  const riskDecision: RiskDecision = input.marketKnownClosed
    ? { status: "rejected", reason: "Market is closed; order blocked at the per-cycle market-hours chokepoint." }
    : cooldownLoadFailed
    ? { status: "rejected", reason: "Failed to load symbol cooldown state; failing closed on this buy order." }
    : reviewRisk({
        intent: {
          id: `intent-${Date.now()}`,
          symbol: input.request.symbol,
          side: input.request.side,
          qty: input.request.qty,
          notional: input.request.qty * input.request.estimatedPrice,
          estimatedPrice: input.request.estimatedPrice,
          sizingReason: "Server order path intent.",
          capsApplied: input.maxNotional ? ["max_notional_route_limit"] : [],
        },
        brokerConfig,
        portfolio: portfolioAssessment,
        exitPlan,
        breaker: { status: breakerState.status },
        metrics: {
          dailyLoss: (() => {
            // Same fallback rule as the breaker input above: a REAL broker must supply
            // last_equity (missing -> NaN -> reviewRisk fails closed); the simulated
            // portfolio treats equity as prior close (daily loss 0).
            const lastEquityForDaily = brokerConfig.configured
              ? Number(portfolio.last_equity)
              : Number(portfolio.last_equity ?? portfolio.equity);
            return breakerState.metrics.equity !== null
              ? breakerState.metrics.equity - lastEquityForDaily
              : Number.NaN;
          })(),
          dailyTradeCount: (input.db.trades || []).filter((trade: any) => String(trade.timestamp || "").startsWith(new Date().toISOString().slice(0, 10))).length,
          openPositionCount: portfolioAssessment.positions.length,
        },
        limits: {
          maxDailyLoss: riskLimits.maxDailyLoss,
          maxDailyTradeCount: riskLimits.maxDailyTradeCount,
          maxOpenPositions: riskLimits.maxOpenPositions,
          minBuyingPower: riskLimits.minBuyingPower,
          cooldownSymbols,
        },
      });
  const result = await submitTradeThroughPipeline({
    request: input.request,
    brokerConfig,
    riskDecision,
    exitPlan,
    brokerSubmit: (clientOrderId) =>
      placeAlpacaOrder(brokerConfig, input.request.symbol, riskDecision.adjustedQty || input.request.qty, input.request.side, clientOrderId),
  });

  // Task 13 (idempotent orders): if this exact intent (by client_order_id) was
  // already recorded locally -- e.g. a retry/double-submit that Alpaca's own
  // client_order_id dedup collapsed into the SAME broker order -- reuse that
  // earlier local trade's id so saveTradeIntent below overwrites it in place
  // instead of inserting a second local record for one broker order.
  if (result.trade.clientOrderId) {
    try {
      const existing = productionStore.findTradeIntentByClientOrderId(result.trade.clientOrderId);
      if (existing && existing.id !== result.trade.id) {
        // The pipeline already built this attempt's audit events against the
        // fresh (about-to-be-discarded) trade id -- re-point them at the
        // deduped id BEFORE appendAuditEvents persists them, or every
        // resubmission would leave orphaned audit_events rows whose entity_id
        // joins to no trade_intents row.
        const staleId = result.trade.id;
        result.trade.id = existing.id;
        for (const event of result.auditEvents) {
          if (event.entityId === staleId) event.entityId = existing.id;
        }
      }
    } catch (err) {
      console.error("[client_order_id] Failed to look up an existing trade intent for dedup; recording this as a new local trade.", err);
    }
  }

  appendAuditEvents(input.db, result.auditEvents);
  productionStore.saveTradeIntent(result.trade);
  if (result.trade.riskDecision) productionStore.saveRiskDecision(result.trade.id, result.trade.riskDecision);
  // Only persist the exit plan when the order actually reached the broker
  // successfully (see BROKER_SUCCESS_TRADE_STATUSES above) -- a RiskRejected or
  // BrokerFailed trade's exitPlan describes an order that was never placed and
  // must never become the plan latestBuySideExitPlanForSymbol hands back for a
  // real open position (Finding C1).
  if (result.trade.exitPlan && BROKER_SUCCESS_TRADE_STATUSES.has(result.trade.status)) {
    productionStore.saveExitPlan(result.trade.id, result.trade.exitPlan);
  }
  // Cooldown is recorded once the order reaches the broker in any capacity — a clean
  // accept/fill, or a broker-side rejection/failure — but NOT for a RiskRejected trade
  // that never left this process (e.g. insufficient buying power, an already-active
  // cooldown, missing exit plan). Those are cheap, often-transient rejections and
  // re-triggering them must not re-arm or extend an existing cooldown window.
  if (symbolCooldownHours > 0 && BROKER_REACHED_TRADE_STATUSES.has(result.trade.status)) {
    try {
      productionStore.saveCooldown({
        symbol: result.trade.symbol,
        expiresAt: new Date(Date.now() + symbolCooldownHours * 60 * 60 * 1000).toISOString(),
        reason: `Trade ${result.trade.id} for ${result.trade.symbol} reached the broker with status ${result.trade.status}.`,
      });
    } catch (err) {
      console.error("[cooldown] Failed to persist cooldown entry.", err);
    }
  }
  return result.trade;
}

// The two admin-gated reset paths required by Task 10 (POST /api/breaker/reset and
// the Telegram /breaker_reset command, both below) share this: clear the latch
// unconditionally, then re-evaluate fresh. Reset is not an override of reality --
// applyBreakerLatch(fresh, null) starts from "no latch" exactly like a first-ever
// evaluation, so if thresholds are STILL breached right now, it re-trips (and
// re-latches) immediately. Caller supplies `actor` for the audit trail (e.g.
// "admin_api" or "telegram:<userId>") and is responsible for NOT holding dbMutex
// already -- this acquires it itself (broker calls must not happen while already
// holding the lock; see handleTelegramCommand's read-only-reply comment below).
async function performBreakerReset(actor: string): Promise<{ status: BreakerState["status"]; reTripped: boolean }> {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const brokerConfig = getBrokerConfig();
    const portfolio = await getAlpacaPortfolio(brokerConfig);
    const previousBreaker = productionStore.latestBreakerState<PreviousBreakerRecord>();
    const freshBreaker = evaluateFreshBreaker(portfolio, brokerConfig, previousBreaker?.peakEquity ?? null);
    const latchResult = applyBreakerLatch(freshBreaker, null);
    const toPersist = { ...latchResult.effective, latch: latchResult.latchState };
    productionStore.saveBreakerState(toPersist);

    const reTripped = latchResult.latchState.latched;
    const auditEvent: AuditEvent = {
      id: `ae-breaker-reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type: "breaker",
      actor,
      message: reTripped
        ? `Breaker reset by ${actor}; thresholds still breached, re-latched to ${latchResult.latchState.latchedStatus}.`
        : `Breaker reset by ${actor}; latch cleared, status ok.`,
      details: {
        status: latchResult.effective.status,
        reTripped,
        equity: freshBreaker.metrics.equity,
        dailyLossPercent: freshBreaker.metrics.dailyLossPercent,
        drawdownFromPeakPercent: freshBreaker.metrics.drawdownFromPeakPercent,
        drawdownFromBaselinePercent: freshBreaker.metrics.drawdownFromBaselinePercent,
        reasons: freshBreaker.reasons,
      },
    };
    appendAuditEvents(db, [auditEvent]);
    writeDB(db);
    return { status: latchResult.effective.status, reTripped };
  } finally {
    release();
  }
}

function defaultDB() {
  return {
    config: {
      alpaca: { apiKeyId: "", secretKey: "", paper: true },
      notion: { token: "", databaseId: "" },
      telegram: { botToken: "", chatId: "", enabled: false },
      google: { spreadsheetId: "", enabled: false },
      system: {
        autoTrading: false,
        runIntervalMins: 15,
        maxPositionSizePercent: 10,
        stopLossPercent: 5,
        targetProfitPercent: 15,
      },
    },
    analyses: [],
    trades: [],
    syncLogs: [],
    auditEvents: [],
    simulatedPortfolio: {
      cash: "100000.00",
      buying_power: "100000.00",
      portfolio_value: "100000.00",
      equity: "100000.00",
      long_market_value: "0.00",
      daytrade_count: 0,
      positions: [],
    },
  };
}

// Cache values or helper functions to read and write db
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      return defaultDB();
    }
    const data = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(data);
    return { ...defaultDB(), ...parsed, config: { ...defaultDB().config, ...(parsed.config || {}) } };
  } catch (error) {
    console.error("Error reading database:", error);
    return defaultDB();
  }
}

function writeDB(data: any) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // Atomic Write Sequence: write to temporary file first then rename atomically
    const tempPath = DB_PATH + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, DB_PATH);
  } catch (error) {
    console.error("Critical: Error writing database atomically:", error);
    // Safe fallback to direct write to prevent data loss
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (fallbackError) {
      console.error("Emergency fallback write database failed:", fallbackError);
    }
  }
}

// Global Claude client. Both call sites in /api/sync run inside try/catch
// blocks; a missing ANTHROPIC_API_KEY or a failed call is treated as a hard
// failure of that source -- it contributes zero scan-targets/signals rather
// than falling back to simulated analysis (see scanTargetAssembly.ts).
const getClaudeClient = () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("No ANTHROPIC_API_KEY environment variable found. Claude calls will fail.");
  }
  return new Anthropic({ apiKey });
};

const claudeText = (response: Anthropic.Message): string =>
  response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

/* ==========================================================
   INTEGRATIONS IMPLEMENTATION
   ========================================================== */

// 1. Alpaca Integration Helper
async function getAlpacaPortfolio(brokerConfig: BrokerConfig = getBrokerConfig()) {
  if (!brokerConfig.configured) {
    // If not configured, retrieve our realistic simulated portfolio
    const db = readDB();
    return db.simulatedPortfolio || { cash: "100000.00", portfolio_value: "100000.00", positions: [] };
  }

  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };

  try {
    const acctRes = await fetch(`${brokerConfig.baseUrl}/account`, { headers });
    if (!acctRes.ok) throw new Error(`Alpaca Accounts API responded with ${acctRes.status}`);
    const account = await acctRes.json();

    const posRes = await fetch(`${brokerConfig.baseUrl}/positions`, { headers });
    const positions = posRes.ok ? await posRes.json() : [];

    return {
      cash: account.cash,
      buying_power: account.buying_power,
      portfolio_value: account.portfolio_value,
      equity: account.equity,
      last_equity: account.last_equity,
      long_market_value: account.long_market_value,
      daytrade_count: account.daytrade_count,
      positions: positions.map((p: any) => ({
        symbol: p.symbol,
        qty: p.qty,
        market_value: p.market_value,
        cost_basis: p.cost_basis,
        unrealized_pl: p.unrealized_pl,
        unrealized_plpc: (parseFloat(p.unrealized_pl) / parseFloat(p.cost_basis)).toFixed(4),
        current_price: p.current_price,
        avg_entry_price: p.avg_entry_price,
      })),
    };
  } catch (err: any) {
    console.error("Alpaca connection error:", err.message);
    throw err;
  }
}

async function getAlpacaOpenOrders(brokerConfig: BrokerConfig = getBrokerConfig()) {
  if (!brokerConfig.configured) return [];
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };
  const res = await fetch(`${brokerConfig.baseUrl}/orders?status=open`, { headers });
  if (!res.ok) return [];
  const orders = await res.json();
  return (Array.isArray(orders) ? orders : []).map((order: any) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    notional: order.notional,
    status: order.status,
  }));
}

// Task 13: does an Alpaca error response indicate the order was rejected
// specifically because client_order_id already exists (a duplicate/retry),
// as opposed to some other rejection (insufficient buying power, bad symbol,
// market closed, etc.)? Alpaca's documented duplicate response is a 422 (or
// 409) whose body names client_order_id and says it must be unique/already
// exists. Matched narrowly on both the status AND the wording so we don't
// misclassify an unrelated 422 as "safe to resolve via the existing order."
function isDuplicateClientOrderIdError(status: number, bodyText: string): boolean {
  if (status !== 422 && status !== 409) return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("client_order_id") &&
    (lower.includes("unique") || lower.includes("already") || lower.includes("duplicate") || lower.includes("exists"))
  );
}

// Task 13: resolve a duplicate client_order_id rejection to the order Alpaca
// already created for it, via Alpaca's GET /orders:by_client_order_id. Returns
// null (never throws) on any failure -- the caller falls back to failing the
// submission closed (BrokerFailed) rather than fabricating a mapping.
async function fetchExistingAlpacaOrderByClientOrderId(brokerConfig: BrokerConfig, clientOrderId: string) {
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };
  try {
    const res = await fetch(`${brokerConfig.baseUrl}/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[client_order_id] Failed to fetch the existing order after a duplicate client_order_id rejection.", err);
    return null;
  }
}

async function placeAlpacaOrder(brokerConfig: BrokerConfig, symbol: string, qty: number, side: "buy" | "sell", clientOrderId: string) {
  if (!brokerConfig.configured) {
    // Task 13: the dry-run path also carries the id, for consistency with the
    // live path's response shape (and so tests/callers can assert on it
    // uniformly regardless of whether a broker is configured).
    return { id: "dry-run-" + Date.now(), qty: String(qty), status: "accepted", client_order_id: clientOrderId };
  }

  if (brokerConfig.tradingMode === "live" && !brokerConfig.liveTradingEnabled) {
    throw new Error("Live trading is blocked unless LIVE_TRADING_ENABLED=true.");
  }

  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };

  const orderRes = await fetch(`${brokerConfig.baseUrl}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
      client_order_id: clientOrderId,
    }),
  });
  if (!orderRes.ok) {
    const errTxt = await orderRes.text();
    // Task 13: Alpaca's behavior on a duplicate client_order_id is to return
    // the EXISTING order, or a 422/409 depending on state. On the error path,
    // resolve it to that existing order instead of surfacing a spurious
    // BrokerFailed for an order that actually exists -- without this, an
    // operator/automation seeing "failed" could retry with a fresh id and
    // create a real second order, exactly what client_order_id exists to prevent.
    if (isDuplicateClientOrderIdError(orderRes.status, errTxt)) {
      const existing = await fetchExistingAlpacaOrderByClientOrderId(brokerConfig, clientOrderId);
      if (existing) return existing;
    }
    throw new Error(`Alpaca order rejected: ${errTxt}`);
  }
  return await orderRes.json();
}

// Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): market-hours gate. Only a
// SCHEDULED cycle calls this (manual syncs are the human's call and are never
// gated -- see runSyncCycle below). With no broker configured, there is no
// real Alpaca clock to ask and the entire order path already dry-runs
// (placeAlpacaOrder's !brokerConfig.configured branch); treating that as
// "open" avoids gating local/offline development against a market that, for
// this deployment, doesn't exist. With a broker configured, a failed or
// malformed clock fetch fails closed to "closed" -- an unknown market state
// must never be treated as tradable.
async function checkMarketOpenForScheduledCycle(brokerConfig: BrokerConfig): Promise<{ isOpen: boolean; log: string }> {
  if (!brokerConfig.configured) {
    return { isOpen: true, log: "Market-hours clock check skipped: no broker configured (simulated/dry-run mode); treating the market as open." };
  }
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
  };
  try {
    const res = await fetch(`${brokerConfig.baseUrl}/clock`, { headers });
    if (!res.ok) {
      return { isOpen: false, log: `Market-hours clock check failed (HTTP ${res.status}); failing closed (treating the market as closed).` };
    }
    const body = await res.json();
    if (typeof body?.is_open !== "boolean") {
      return { isOpen: false, log: "Market-hours clock check returned an unexpected response (missing is_open); failing closed (treating the market as closed)." };
    }
    return { isOpen: body.is_open, log: `Market-hours clock check: is_open=${body.is_open}.` };
  } catch (err: any) {
    return {
      isOpen: false,
      log: `Market-hours clock check threw (${err?.message || String(err)}); failing closed (treating the market as closed).`,
    };
  }
}

// 2. Telegram Notification Helper
async function sendTelegramAlert(config: AppConfig["telegram"], message: string) {
  if (!config || !config.enabled || !config.botToken || !config.chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Telegram alert failed:", err);
    return false;
  }
}

const pendingTelegramConfirmations = new Map<string, ConfirmationToken>();

async function sendTelegramBotMessage(chatId: string, message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    return res.ok;
  } catch (err) {
    console.error("Telegram bot message failed:", err);
    return false;
  }
}

async function handleTelegramCommand(update: any) {
  const message = update.message;
  const text = String(message?.text || "").trim();
  const chatId = String(message?.chat?.id || "");
  const userId = String(message?.from?.id || "");
  if (!text || !chatId || !userId) return;

  const command = text.split(/\s+/)[0];
  const roles = parseTelegramAdminRoles(process.env.TELEGRAM_ADMIN_ROLES);
  const auth = authorizeTelegramCommand({ userId, command, roles });

  const outbound: string[] = [];
  let needsReadOnlyReply = false;
  // Set when /confirm just consumed a valid "breaker_reset" token -- the actual
  // reset (performBreakerReset) calls the broker, so it must run after the db lock
  // below is released, same reason /positions defers its broker read (see
  // needsReadOnlyReply below). Unlike /close_all's confirm reply (a placeholder
  // pointing at the admin API), /breaker_reset's Telegram confirmation is the
  // second of the task's two required reset paths and must actually execute.
  let confirmedBreakerReset = false;

  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const auditEvent: AuditEvent = {
      id: `tg-${update.update_id || Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "telegram",
      actor: userId,
      message: `Telegram command ${command} ${auth.allowed ? "accepted" : "rejected"}`,
      details: { command, chatId, auth },
    };
    appendAuditEvents(db, [auditEvent]);

    if (!auth.allowed) {
      outbound.push(`Rejected: ${auth.reason || "unauthorized"}.`);
    } else if (command === "/confirm") {
      const tokenValue = text.split(/\s+/)[1];
      const token = pendingTelegramConfirmations.get(tokenValue);
      if (!token) {
        outbound.push("Confirmation rejected: unknown token.");
      } else {
        const consumed = consumeConfirmationToken({ token, userId, action: token.action });
        if (!consumed.accepted) {
          outbound.push(`Confirmation rejected: ${consumed.reason}.`);
        } else {
          pendingTelegramConfirmations.delete(tokenValue);
          if (token.action === "breaker_reset") {
            confirmedBreakerReset = true;
          } else {
            outbound.push(`Confirmed action: ${token.action}. Submit through the admin API to execute.`);
          }
        }
      }
    } else if (command === "/close_all") {
      const token = createConfirmationToken({ userId, action: "close_all" });
      pendingTelegramConfirmations.set(token.token, token);
      outbound.push(`Close-all requires confirmation. Reply: /confirm ${token.token}`);
    } else if (command === "/breaker_reset") {
      // Strictest existing confirmation flow (mirrors /close_all exactly): admin
      // role required (telegramEngine.ts commandRoles) plus a second /confirm step.
      const token = createConfirmationToken({ userId, action: "breaker_reset" });
      pendingTelegramConfirmations.set(token.token, token);
      outbound.push(`Breaker reset requires confirmation. Reply: /confirm ${token.token}`);
    } else if (command === "/pause" || command === "/block_buys") {
      db.config.system.autoTrading = false;
      outbound.push("Auto trading paused. New buys are blocked.");
    } else if (command === "/resume") {
      db.config.system.autoTrading = true;
      outbound.push("Auto trading resumed subject to risk checks.");
    } else {
      needsReadOnlyReply = true;
    }

    writeDB(db);
  } finally {
    release();
  }

  if (confirmedBreakerReset) {
    // Admin reset path 2 of 2 (Task 10). Runs after the lock above is released;
    // performBreakerReset re-acquires dbMutex itself around the actual state change.
    const result = await performBreakerReset(`telegram:${userId}`);
    outbound.push(`Breaker reset executed. Status: ${result.status}${result.reTripped ? " (still breached — re-latched)" : ""}.`);
  }

  if (needsReadOnlyReply) {
    // Read-only replies may hit the broker; never do this while holding the db lock.
    const portfolio = command === "/positions" ? await getAlpacaPortfolio().catch(() => null) : null;
    const reply = {
      "/status": "Quantpaca online. Broker writes require pipeline approval.",
      "/health": `Broker configured: ${getBrokerConfig().configured}; mode: ${getBrokerConfig().tradingMode}; live enabled: ${getBrokerConfig().liveTradingEnabled}.`,
      "/positions": portfolio ? JSON.stringify(portfolio.positions || []).slice(0, 3500) : "Positions unavailable.",
      "/orders": JSON.stringify(await getAlpacaOpenOrders().catch(() => [])).slice(0, 3500),
      "/trades": JSON.stringify(productionStore.listTradeIntents(10)).slice(0, 3500),
      "/sync": "Sync command accepted. Use admin API with ADMIN_API_TOKEN for execution.",
      "/dry_run": "Dry-run path available through reviewed signals, sizing, risk, and audit endpoints.",
      "/risk": JSON.stringify(productionStore.listRiskDecisions(10)).slice(0, 3500),
      "/regime": JSON.stringify(productionStore.latestRegimeAssessment() || detectRegime({})).slice(0, 3500),
    }[command] || "Command recognized.";
    outbound.push(reply);
  }

  for (const reply of outbound) {
    await sendTelegramBotMessage(chatId, reply);
  }
}

function startTelegramRuntime() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  let offset = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=10&offset=${offset}`);
      if (!res.ok) return;
      const data = await res.json();
      for (const update of data.result || []) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        await handleTelegramCommand(update);
      }
    } catch (err) {
      console.error("Telegram polling failed:", err);
    }
  }, 5000);
}

// 3. Google Sheets Export Helper
async function appendTradeToSheets(config: AppConfig["google"], authHeader: string | null, trade: Trade) {
  if (!config || !config.enabled || !config.spreadsheetId || !authHeader) return false;
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/A1:I1:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: [[
            trade.timestamp,
            trade.id,
            trade.symbol,
            trade.side.toUpperCase(),
            trade.qty,
            trade.price || "MARKET",
            trade.qty * trade.price || "N/A",
            trade.status.toUpperCase(),
            trade.reasoning
          ]],
        }),
      }
    );
    return res.ok;
  } catch (err) {
    console.error("Google Sheets save error:", err);
    return false;
  }
}

// 4. Notion Document Logger
async function saveToNotionDatabase(config: AppConfig["notion"], analysis: StockAnalysis) {
  if (!config || !config.token || !config.databaseId) return false;
  try {
    const res = await fetch(`https://api.notion.com/v1/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: config.databaseId },
        properties: {
          Ticker: { title: [{ text: { content: analysis.symbol } }] },
          Source: { select: { name: analysis.source.toUpperCase() } },
          Title: { rich_text: [{ text: { content: analysis.sourceTitle } }] },
          GrowthScore: { number: analysis.growthScore },
          SentimentScore: { number: analysis.sentimentScore },
          RiskProfile: { select: { name: analysis.riskProfile } },
          Decision: { select: { name: analysis.decision } },
          WhipsawAssessment: { rich_text: [{ text: { content: analysis.whipsawCheck } }] },
          Reasoning: { rich_text: [{ text: { content: analysis.reasoning } }] },
          Date: { date: { start: analysis.timestamp } },
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Notion save error:", err);
    return false;
  }
}


/* ==========================================================
   REST API API ENDPOINTS
   ========================================================== */

// Config Endpoints
app.get("/api/config", (req, res) => {
  const db = readDB();
  res.json(redactConfigForClient(db.config));
});

app.post("/api/config", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    db.config = stripPersistedSecrets({ ...db.config, ...req.body });
    writeDB(db);
    res.json({ success: true, config: redactConfigForClient(db.config) });
  } catch (error) {
    console.error("Config update failed:", error);
    res.status(500).json({ error: "Failed to update configuration." });
  } finally {
    release();
  }
});

// Logs, Trades, Analyses
app.get("/api/analyses", (req, res) => {
  const db = readDB();
  res.json(db.analyses || []);
});

app.get("/api/trades", (req, res) => {
  const db = readDB();
  res.json(db.trades || []);
});

app.get("/api/logs", (req, res) => {
  const db = readDB();
  res.json(db.syncLogs || []);
});

app.get("/api/audit", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listAuditEvents();
  res.json(persisted.length ? persisted : (db.auditEvents || []));
});

app.get("/api/regime/latest", (req, res) => {
  const latest = productionStore.latestRegimeAssessment();
  if (latest) {
    res.json(latest);
    return;
  }
  const conservative = detectRegime({});
  productionStore.saveRegimeAssessment(conservative);
  res.json(conservative);
});

app.get("/api/breaker/latest", (req, res) => {
  res.json(productionStore.latestBreakerState() || { status: "ok", reasons: ["no_evaluation_yet"], asOf: null });
});

// Admin reset path 1 of 2 (Task 10, docs/GO_LIVE_PLAN.md Phase 1.4). See
// performBreakerReset above: clears the latch, then re-evaluates fresh -- if still
// breached, it re-trips immediately rather than overriding reality.
app.post("/api/breaker/reset", requireAdminCommand, async (req, res) => {
  try {
    const result = await performBreakerReset("admin_api");
    res.json({ success: true, status: result.status, reTripped: result.reTripped });
  } catch (err: any) {
    console.error("Critical error in /api/breaker/reset:", err);
    res.status(500).json({ error: "Breaker reset failed", details: err.message });
  }
});

app.get("/api/portfolio/assessment", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    const assessment = assessPortfolio({
      account: portfolio,
      positions: portfolio.positions || [],
      openOrders: await getAlpacaOpenOrders(),
      source: getBrokerConfig().configured ? "alpaca" : "local_simulated_snapshot",
    });
    res.json(assessment);
  } catch (err: any) {
    res.status(502).json({ error: "Portfolio assessment failed", details: err.message });
  }
});

app.get("/api/signals/reviewed", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listReviewedSignals();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.analyses || []).map((analysis: StockAnalysis) => ({
    id: analysis.id,
    symbol: analysis.symbol,
    source: analysis.source,
    sourceTimestamp: analysis.timestamp,
    freshnessStatus: "unknown",
    confidenceScore: Math.max(0, Math.min(100, Math.round((analysis.growthScore + Math.max(analysis.sentimentScore, 0)) / 2))),
    classification: analysis.decision === "BUY" ? "bullish" : analysis.decision === "SELL" ? "bearish" : "neutral",
    thesisSummary: analysis.reasoning,
    invalidationConditions: analysis.whipsawCheck,
    evidence: analysis.sourceTitle,
  })));
});

app.get("/api/trade-intents", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listTradeIntents();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.trades || []).map((trade: any) => ({
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    qty: trade.qty,
    notional: Number(trade.qty) * Number(trade.price),
    estimatedPrice: trade.price,
    status: trade.status,
    source: trade.source || "legacy",
    reasoning: trade.reasoning,
    timestamp: trade.timestamp,
  })));
});

app.get("/api/risk-decisions", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listRiskDecisions();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.trades || []).filter((trade: any) => trade.riskDecision).map((trade: any) => ({
    tradeId: trade.id,
    symbol: trade.symbol,
    ...trade.riskDecision,
  })));
});

app.get("/api/exit-plans", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listExitPlans();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.trades || []).filter((trade: any) => trade.exitPlan).map((trade: any) => ({
    tradeId: trade.id,
    symbol: trade.symbol,
    ...trade.exitPlan,
  })));
});

app.get("/api/reconciliation/latest", (req, res) => {
  const latest = productionStore.latestReconciliationReport();
  if (latest) {
    res.json(latest);
    return;
  }
  res.json({ id: "reconciliation-not-run", timestamp: new Date().toISOString(), status: "matched", mismatches: [] });
});

app.post("/api/reconciliation/run", requireAdminCommand, async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    const report = reconcileBrokerState({
      localTrades: productionStore.listTradeIntents().map((trade: any) => ({
        id: trade.id,
        brokerOrderId: trade.brokerOrderId,
        symbol: trade.symbol,
        qty: trade.qty,
        side: trade.side,
        status: trade.status,
      })),
      brokerOrders: await getAlpacaOpenOrders(),
      brokerPositions: portfolio.positions || [],
      account: portfolio,
    });
    productionStore.saveReconciliationReport(report);
    res.json(report);
  } catch (err: any) {
    res.status(502).json({ error: "Reconciliation failed", details: err.message });
  }
});

app.get("/api/telegram/status", (req, res) => {
  const roles = parseTelegramAdminRoles(process.env.TELEGRAM_ADMIN_ROLES);
  res.json({
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminsConfigured: Object.keys(roles).length,
    mode: process.env.TELEGRAM_RUNTIME || "long_polling_ready",
    commands: ["/status", "/health", "/positions", "/orders", "/trades", "/sync", "/dry_run", "/pause", "/resume", "/block_buys", "/close_all", "/breaker_reset", "/risk", "/regime"],
  });
});

app.get("/api/health", async (req, res) => {
  const broker = getBrokerConfig();
  const health = {
    ok: true,
    timestamp: new Date().toISOString(),
    broker: {
      configured: broker.configured,
      tradingMode: broker.tradingMode,
      liveTradingEnabled: broker.liveTradingEnabled,
      baseUrl: broker.baseUrl,
      reachable: false,
      error: undefined as string | undefined,
    },
  };
  if (broker.configured) {
    try {
      await getAlpacaPortfolio(broker);
      health.broker.reachable = true;
    } catch (err: any) {
      health.ok = false;
      health.broker.error = err.message;
    }
  }
  res.status(health.ok ? 200 : 502).json(health);
});

app.get("/api/portfolio", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    res.json(portfolio);
  } catch (err: any) {
    console.error("Error fetching portfolio:", err);
    res.status(500).json({ error: "Failed to retrieve portfolio details", details: err.message });
  }
});

// Core Integration execution cycle
// Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): the sync pipeline, callable
// by both POST /api/sync (trigger "manual") and the scheduler (trigger
// "scheduled") -- this is the extracted body of what used to be the route
// handler directly, moved (not rewritten) so both callers share one pipeline.
// `authHeader` carries the Gmail OAuth bearer token when the caller has one
// (only ever true for a manual sync driven by a browser session); the
// scheduler has no user session and always passes null, same as an
// unauthenticated manual call.
type SyncCycleResult =
  | { ok: true; trigger: "manual" | "scheduled"; analyses: StockAnalysis[]; logs: SyncLog[]; failed: boolean }
  | { ok: false; trigger: "manual" | "scheduled"; error: string };

async function runSyncCycle(trigger: "manual" | "scheduled", authHeader: string | null): Promise<SyncCycleResult> {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();

    const logs: SyncLog[] = [];
    const results: any[] = [];

    const timestamp = new Date().toISOString();
    const logId = () => "l-" + Math.random().toString(36).substr(2, 9);

    // Initialize helper to write log lines
    const addLog = (type: SyncLog["type"], msg: string, details?: string) => {
      const sl: SyncLog = { id: logId(), timestamp: new Date().toISOString(), type, message: msg, details, trigger };
      db.syncLogs.unshift(sl);
      logs.push(sl);
    };

    const currentConfig: AppConfig = db.config;

    addLog("sync", "Starting automation loop & thesis scanner...");
    appendAuditEvents(db, [{
      id: `ae-cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type: "sync",
      actor: trigger === "scheduled" ? "scheduler" : "manual_api",
      message: `Sync cycle started (trigger: ${trigger}).`,
      details: { trigger },
    }]);

    // Phase 2 Task 2: market-hours gate. Only a SCHEDULED cycle consults the
    // clock and reduces scope -- a manual sync is always full-scope (both
    // flags stay false when trigger !== "scheduled"), so every gate added
    // below this point is a structural no-op on the manual path, preserving
    // its existing behavior byte-for-byte. Clock-fetch failure fails closed
    // (treated as closed) per the plan's fail-closed rule.
    let marketKnownClosed = false;
    let reducedCycle = false;
    if (trigger === "scheduled") {
      const clockCheck = await checkMarketOpenForScheduledCycle(getBrokerConfig());
      addLog("sync", clockCheck.log);
      marketKnownClosed = !clockCheck.isOpen;
      reducedCycle = marketKnownClosed;
    }

    // ==========================================================
    // MODULE 1: OUTBOX RESILIENT SYNCHRONIZER QUEUE Retrying Failed Integrations
    // ==========================================================
    const hasGoogle = currentConfig.google && currentConfig.google.enabled && currentConfig.google.spreadsheetId;
    const hasNotion = currentConfig.notion && currentConfig.notion.token && currentConfig.notion.databaseId;
    const hasTelegram = currentConfig.telegram && currentConfig.telegram.enabled && currentConfig.telegram.botToken && currentConfig.telegram.chatId;

    const pendingTrades = (db.trades || []).filter((tr: any) =>
      (hasGoogle && authHeader && !tr.exportedSheets) ||
      (hasNotion && !tr.loggedNotion) ||
      (hasTelegram && !tr.notifiedTelegram)
    );

    if (pendingTrades.length > 0) {
      addLog("sync", `Outbox Synchronizer found ${pendingTrades.length} trades with pending integrations. Retrying...`);
      for (const tr of pendingTrades) {
        try {
          if (!tr.exportedSheets && hasGoogle && authHeader) {
            tr.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, tr);
            if (tr.exportedSheets) {
              addLog("sync", `Outbox Sync Success: Exported trade ${tr.id} (${tr.symbol}) to Google Sheets.`);
            }
          }
          if (!tr.loggedNotion && hasNotion) {
            const mockAnalysis: StockAnalysis = {
              id: "fake-" + tr.id,
              symbol: tr.symbol,
              source: "email",
              sourceTitle: "Outbox Queue Document Recovery",
              sourceContent: tr.reasoning,
              growthScore: 75,
              sentimentScore: 60,
              riskProfile: "Medium",
              reasoning: tr.reasoning,
              whipsawCheck: "Bypassed on sync recovery.",
              decision: tr.side.toUpperCase() as any,
              timestamp: tr.timestamp,
            };
            tr.loggedNotion = await saveToNotionDatabase(currentConfig.notion, mockAnalysis);
            if (tr.loggedNotion) {
              addLog("sync", `Outbox Sync Success: Logged trade ${tr.id} (${tr.symbol}) to Notion.`);
            }
          }
          if (!tr.notifiedTelegram && hasTelegram) {
            const tgMsg = `🔄 <b>Delayed Outbox Sync recovery event filled</b>\n<b>Ticker:</b> ${tr.symbol}\n<b>Side:</b> ${tr.side.toUpperCase()}\n<b>Price:</b> $${tr.price}`;
            tr.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
            if (tr.notifiedTelegram) {
              addLog("sync", `Outbox Sync Success: Dispatched delayed Telegram warning for trade ${tr.id} (${tr.symbol}).`);
            }
          }
        } catch (queueErr: any) {
          console.error("Failed handling outbox element retry:", queueErr.message);
        }
      }
    }

    // ==========================================================
    // MODULE 2.5: MARKET REGIME ASSESSMENT
    // Feeds real SPY/QQQ trend, broad-market drawdown, and a realized-vol proxy
    // (src/server/marketDataFetcher.ts) into detectRegime (regimeEngine.ts)
    // instead of the permanent conservative default a bare `detectRegime({})`
    // call produces. A persisted assessment younger than REGIME_STALENESS_MS is
    // reused without a refetch; otherwise this fetches fresh bars and persists
    // a new assessment. A fetch that comes back with nothing usable (or throws)
    // degrades to detectRegime({})'s own conservative default -- fail closed,
    // per docs/GO_LIVE_PLAN.md Phase 1.3. Gated on autoTrading (like MODULE 2
    // below): this keeps sync hermetic (no Alpaca calls) when trading is off,
    // matching every other Alpaca call in this file. Runs BEFORE MODULE 2 (Task
    // 9, docs/GO_LIVE_PLAN.md Phase 1.3) so this cycle's own regime assessment
    // -- not a stale one from a prior cycle -- feeds both MODULE 2's
    // regime-change exit dimension immediately below and the buy path further
    // down this sync.
    // ==========================================================
    // The store read is fallible (persistence calls can throw -- same reason
    // exitMonitor.ts documents lookupPlan as throw-capable) and, since the
    // Task 9 reorder, it now runs BEFORE MODULE 2's protective exits. It must
    // therefore never abort the sync: a broken regime store degrades to
    // detectRegime({})'s conservative default (reduce_size -- which can never
    // fire regime-change exits) so exit evaluation still runs this cycle.
    let regimeAssessment: RegimeAssessment;
    try {
      regimeAssessment = productionStore.latestRegimeAssessment() || detectRegime({});
    } catch (regimeStoreErr: any) {
      regimeAssessment = detectRegime({});
      addLog(
        "error",
        "Regime assessment store read failed; degrading to the conservative default (unclear / reduce_size / 0.5x) so exit evaluation still runs this cycle.",
        regimeStoreErr?.message || String(regimeStoreErr),
      );
    }
    if (currentConfig.system && currentConfig.system.autoTrading) {
      // Phase 2 Task 1, Item A (docs/GO_LIVE_PLAN.md "Phase 1 completion
      // report" -> "Deferred to Phase 2"): the 30-minute reuse decision keys
      // on WHEN THE FETCH HAPPENED (`fetchedAt`), not on `asOf` (the newest
      // market-data bar timestamp -- honest about data freshness, but usually
      // days old on weekends and always minutes-to-hours old during the
      // trading day, which made the cache dead code on the happy path before
      // this change). A legacy persisted row, or a row from a failed fetch
      // (see the catch branch below, which deliberately never sets
      // fetchedAt), has no `fetchedAt` at all, which parses to NaN here and
      // is therefore always treated as stale -- migration-safe and fail-closed
      // toward refetching rather than suppressing a retry.
      const cachedFetchedAt = regimeAssessment.fetchedAt;
      const cachedFetchedAtMs = cachedFetchedAt ? Date.parse(cachedFetchedAt) : NaN;
      const cachedIsFresh = Number.isFinite(cachedFetchedAtMs) && Date.now() - cachedFetchedAtMs < REGIME_STALENESS_MS;

      if (cachedIsFresh) {
        addLog("sync", `Regime assessment reused (fetched ${cachedFetchedAt}; younger than ${REGIME_STALENESS_MS / 60000} min).`);
      } else {
        try {
          const fetched = await fetchMarketRegimeInputs({
            brokerConfig: getBrokerConfig(),
            dataBaseUrl: process.env.ALPACA_DATA_URL || "https://data.alpaca.markets",
            fetchImpl: fetch,
          });
          const assessed = detectRegime(fetched.inputs);
          // fetchMarketRegimeInputs never throws (see its module comment) --
          // even a total outage across all three symbols resolves here with
          // empty `inputs`, which detectRegime turns into its own conservative
          // "unclear" default (its only path to marketMode "unclear"). That is
          // functionally a failure for caching purposes: no usable market data
          // was obtained this cycle, so -- same as the genuine-exception catch
          // branch below -- fetchedAt must NOT be written, or a transient
          // total outage would suppress retries for REGIME_STALENESS_MS just
          // like the original bug this task fixes. Only a fetch that produced
          // at least one usable input is cache-worthy.
          const fetchProducedUsableData = assessed.marketMode !== "unclear";
          // fetchedAt = now (drives the 30-min reuse decision above) --
          // conditional per the comment just above. asOf stays the newest-bar
          // timestamp reported by the fetch (drives nothing but honesty/audit
          // -- see the domainTypes.ts field comment) regardless.
          regimeAssessment = {
            ...assessed,
            asOf: fetched.asOf,
            inputs: fetched.inputs,
            ...(fetchProducedUsableData ? { fetchedAt: new Date().toISOString() } : {}),
          };
          if (fetched.unavailableReasons.length) {
            addLog(
              "sync",
              `Regime market-data unavailable for some inputs (falling back to conservative defaults for those fields): ${fetched.unavailableReasons.join("; ")}`,
            );
          }
          addLog(
            "sync",
            `Regime assessment refreshed: marketMode=${regimeAssessment.marketMode}, tradePermission=${regimeAssessment.tradePermission}, sizeMultiplier=${regimeAssessment.sizeMultiplier}.`,
          );
        } catch (regimeErr: any) {
          const conservative = detectRegime({});
          // Deliberately no `fetchedAt` here (Item A): a failed fetch must
          // never write a cache-suppressing timestamp. `asOf = now` still
          // gives this degraded row an honest audit timestamp, but only a
          // SUCCESSFUL fetch above ever writes `fetchedAt`, so next cycle's
          // freshness check above always treats this row as stale and
          // retries -- a transient outage no longer poisons the regime for
          // REGIME_STALENESS_MS.
          regimeAssessment = { ...conservative, asOf: new Date().toISOString(), inputs: {} };
          addLog(
            "error",
            "Regime market-data refetch failed; falling back to the conservative default (unclear / reduce_size / 0.5x). Next sync will retry (no cache suppression).",
            regimeErr?.message || String(regimeErr),
          );
        }
        // Persisting is best-effort for the same reason as the read above:
        // a broken store must not abort the sync before MODULE 2's protective
        // exits run. The in-memory regimeAssessment still feeds this cycle.
        try {
          productionStore.saveRegimeAssessment(regimeAssessment);
        } catch (regimeSaveErr: any) {
          addLog(
            "error",
            "Regime assessment could not be persisted; continuing with the in-memory assessment for this cycle.",
            regimeSaveErr?.message || String(regimeSaveErr),
          );
        }
      }
    }

    // ==========================================================
    // MODULE 2: ACTIVE PORTFOLIO RISK CONTROLLER
    // Evaluates each open position's persisted exit plan (stop-loss,
    // take-profit, time-exit, thesis-invalidation, regime-change -- see
    // exitEngine.ts) via evaluateOpenPositionExits (src/server/exitMonitor.ts).
    // A position with no plan, or a plan that fails numeric validation, falls
    // back to the legacy hardcoded 5% unrealized_plpc stop-loss so it is never
    // left unprotected. The regime-change dimension is fed this cycle's
    // tradePermission/marketMode from MODULE 2.5 above (Task 9,
    // docs/GO_LIVE_PLAN.md Phase 1.3): a plan whose regimeChangeAction is
    // "close" liquidates only when tradePermission is affirmatively
    // "close_only" this cycle. detectRegime({})'s conservative default
    // (reduce_size) can never be "close_only", so a missing/degraded
    // market-data feed can never liquidate a position through this dimension --
    // exits fail closed in the protective direction.
    // See docs/GO_LIVE_PLAN.md Phase 1.2.
    // ==========================================================
    if (currentConfig.system && currentConfig.system.autoTrading) {
      addLog("sync", "Active risk evaluator: Checking portfolio exit plans and stop-loss limits...");
      try {
        const portfolio = await getAlpacaPortfolio();
        const stopPercent = currentConfig.system.stopLossPercent || 5.0; // percentage trigger
        const positions = portfolio.positions || [];
        const positionBySymbol = new Map(positions.map((pos: any) => [pos.symbol, pos]));

        const exitEvaluation = evaluateOpenPositionExits({
          positions: positions.map((pos: any) => ({
            symbol: pos.symbol,
            qty: pos.qty,
            currentPrice: pos.current_price,
            unrealizedPlPercent: parseFloat(pos.unrealized_plpc) * 100,
          })),
          now: new Date(),
          legacyStopLossPercent: stopPercent,
          // This cycle's regime assessment (MODULE 2.5 above) -- undefined
          // permission (e.g. autoTrading was off last time regimeAssessment was
          // computed) is passed through as-is; evaluateExitPlan only ever
          // triggers on an exact "close_only" match, so undefined/reduce_size/
          // allow/block_new_buys all fail closed here.
          regimePermission: regimeAssessment.tradePermission,
          regimeMode: regimeAssessment.marketMode,
          lookupPlan: (symbol) => productionStore.latestBuySideExitPlanForSymbol(symbol),
          onHighWaterMarkRatchet: (tradeId, symbol, highWaterMark) => {
            try {
              productionStore.updateHighWaterMark(tradeId, highWaterMark);
            } catch (err: any) {
              console.error(`[trailing-stop] Failed to persist ratcheted high-water mark for ${symbol}:`, err?.message || err);
            }
          },
        });

        for (const skipped of exitEvaluation.skippedPlans) {
          addLog("error", `Exit plan evaluation skipped for ${skipped.symbol}`, skipped.message);
        }

        const exitDecisions: Array<
          | { kind: "plan_exit"; symbol: string; qty: number; reasoning: string; logMessage: string }
          | { kind: "legacy_stop_loss"; symbol: string; qty: number; reasoning: string; logMessage: string }
        > = [
          ...exitEvaluation.planExits.map((exit) => ({
            kind: exit.kind,
            symbol: exit.symbol,
            qty: exit.qty,
            reasoning: exit.reasoning,
            logMessage: `PLAN EXIT TRIGGERED: Position in ${exit.symbol} closed by exit plan (${exit.reasoning}).`,
          })),
          ...exitEvaluation.legacyExits.map((exit) => ({
            kind: exit.kind,
            symbol: exit.symbol,
            qty: exit.qty,
            reasoning: exit.reasoning,
            logMessage: `PROTECTIVE BOUND REACHED: Position in ${exit.symbol} is at ${exit.unrealizedLossPercent.toFixed(2)}% loss (Limit: -${stopPercent}%). Exercising Stop Loss sell execution!`,
          })),
        ];

        for (const decision of exitDecisions) {
          const pos: any = positionBySymbol.get(decision.symbol);
          if (!pos) continue;
          addLog("trade", decision.logMessage);

          const sellQty = Math.min(decision.qty, Math.floor(parseFloat(pos.qty)) || 0);
          if (sellQty <= 0) continue;

          const liquidationTrade = await executeTradeIntent({
            db,
            config: currentConfig,
            request: {
              source: "stop_loss",
              symbol: pos.symbol,
              qty: sellQty,
              estimatedPrice: parseFloat(pos.current_price) || 0,
              side: "sell",
              reasoning: decision.reasoning,
            },
            marketKnownClosed,
          });
          Object.assign(liquidationTrade, {
            symbol: pos.symbol,
            qty: sellQty,
            price: parseFloat(pos.current_price) || 50,
            side: "sell",
          });

          const tgAlertMsg = `🚨 <b>${decision.kind === "plan_exit" ? "EXIT PLAN TRIGGERED" : "STOP LOSS EXECUTION WARNING"}</b>\n<b>Ticker:</b> ${pos.symbol}\n<b>Reason:</b> ${decision.reasoning}\nAutomatically liquidated ${sellQty} shares to shield capital assets from further dropdowns.`;
          liquidationTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgAlertMsg);
          liquidationTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, liquidationTrade);
          liquidationTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, {
            id: "an-" + Math.random().toString(36).substr(2, 9),
            symbol: pos.symbol,
            source: "email",
            sourceTitle: "Protective Capital Liquidation",
            sourceContent: decision.kind === "plan_exit" ? "Exit plan threshold triggered" : "Loss threshold exceeded",
            growthScore: 0,
            sentimentScore: -100,
            riskProfile: "High",
            reasoning: liquidationTrade.reasoning,
            whipsawCheck: "Stop Limit breach verified, trend reversal detected.",
            decision: "SELL",
            timestamp: liquidationTrade.timestamp
          });

          db.trades.unshift(liquidationTrade);

          // Clean local simulated portfolio if offline mode
          if (!getBrokerConfig().configured && liquidationTrade.status !== "BrokerFailed" && liquidationTrade.status !== "RiskRejected") {
            db.simulatedPortfolio.positions = (db.simulatedPortfolio.positions || []).filter((p: any) => p.symbol !== pos.symbol);
            const fundBack = sellQty * (parseFloat(pos.current_price) || 50);
            db.simulatedPortfolio.cash = String(parseFloat(db.simulatedPortfolio.cash) + fundBack);
            db.simulatedPortfolio.long_market_value = String(parseFloat(db.simulatedPortfolio.long_market_value) - fundBack);
          }

          addLog("trade", `Liquidated ${sellQty} shares of ${pos.symbol} (${decision.kind === "plan_exit" ? "exit plan" : "legacy stop loss"} trigger).`);
        }
      } catch (riskManagerErr: any) {
        addLog("error", "Portfolio risk evaluator hit error", riskManagerErr.message);
      }
    }

    // Phase 2 Task 2: a reduced cycle (scheduled + market closed) skips Gmail/
    // YouTube ingestion and the whole Claude-driven analysis + order-placement
    // loop below -- don't burn a Claude API call analyzing a thesis nothing
    // can execute on. MODULE 2.5 (regime) and MODULE 2 (exit monitoring)
    // above already ran unconditionally (gated only on autoTrading, unchanged
    // by this task); this is the only other gate reducedCycle controls. A
    // manual sync never reaches the `if` branch (reducedCycle is always false
    // for trigger !== "scheduled"), so this whole wrapper is a no-op for the
    // manual path -- the `else` block below is the original, unmodified body.
    // gmailAttempted/youtubeAttempted distinguish "this source was never
    // tried" (e.g. Gmail with no OAuth token -- always true for a scheduled
    // cycle, which never carries a browser session's Authorization header)
    // from "this source was tried and errored". Guardrail 7's "every
    // ingestion source errored" only makes sense over sources that were
    // actually attempted -- a scheduled cycle's Gmail is structurally never
    // attempted, so it must never count against that source-attempted set
    // (an AND over Gmail+YouTube unconditionally would make a scheduled
    // cycle's ingestion-failure detection permanently unreachable, since
    // gmailErrored can never become true when Gmail is never attempted).
    let gmailAttempted = false;
    let gmailErrored = false;
    let youtubeAttempted = false;
    let youtubeErrored = false;
    let buyOrdersThisCycle = 0;
    const parsedAnalyses: StockAnalysis[] = [];
    if (reducedCycle) {
      addLog("sync", "Market closed: skipping Gmail ingestion, YouTube sentiment scan, and Claude thesis analysis this cycle (reduced cycle).");
    } else {
    // Variable to store Gmail messages
    let emailsToScan: EmailScanTarget[] = [];
    // Phase 2 Task 1, Item B (docs/GO_LIVE_PLAN.md "Phase 1 completion report"
    // -> "Deferred to Phase 2"): the latest reason this sync contributed zero
    // email scan-targets, threaded into the throttled Telegram alert text
    // below. All three causes (no OAuth token, non-OK Gmail response, zero
    // usable messages) share the one throttled alert class -- this makes the
    // alert text reflect whichever is CURRENT this sync, not whichever
    // happened to fire first after the last alert.
    let emptyEmailReason = "No Gmail authorization token detected.";

  if (authHeader) {
    gmailAttempted = true;
    addLog("sync", "Attempting to retrieve messages with active Gmail OAuth token...");
    try {
      // Query messages from charlie-from-ziptrader@ghost.io
      const gmailQuery = "from:charlie-from-ziptrader@ghost.io";
      const gmailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQuery)}&maxResults=5`,
        { headers: { Authorization: authHeader } }
      );

      if (gmailRes.ok) {
        const gmailData = await gmailRes.json();
        const messages = gmailData.messages || [];
        addLog("sync", `Successfully listed ${messages.length} messages from ZipTrader of ghost.io.`);
        emptyEmailReason =
          messages.length === 0
            ? "Gmail returned zero messages matching the tracked sender this sync."
            : "No message returned this sync was usable (per-message detail fetch failed, or extraction rejected it -- see per-message log entries).";

        for (const msg of messages) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: authHeader } }
          );
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const extraction = extractEmailScanTarget(detailData);
            if (extraction.ok === false) {
              // Fail-closed: no real send time could be recovered for this message.
              // Never fabricate "now" -- skip it rather than let an undated thesis
              // sail through the freshness check.
              addLog("error", `Skipping Gmail message ${msg.id}: ${extraction.reason}`);
              continue;
            }
            if (extraction.bodyDegraded) {
              addLog("sync", `Body extraction degraded for Gmail message ${msg.id}; using snippet fallback.`);
            }
            emailsToScan.push(extraction.target);
          }
        }
      } else {
        const errTxt = await gmailRes.text();
        addLog("error", "Gmail API failed. No email signals this sync.", errTxt);
        emptyEmailReason = `Gmail API request failed (non-OK response): ${errTxt.substring(0, 200)}`;
        gmailErrored = true;
      }
    } catch (err: any) {
      addLog("error", "Gmail sync connection error.", err.message);
      emptyEmailReason = `Gmail sync connection error: ${err.message}`;
      gmailErrored = true;
    }
  } else {
    addLog("sync", "No Gmail authorization token detected. Contributing zero email scan-targets this sync.");
  }

  // Fail closed: a fabricated thesis must never reach the trade pipeline. If Gmail
  // was unavailable (no OAuth token above) or returned zero usable emails, log it,
  // alert via Telegram if configured, and contribute zero email scan-targets --
  // never substitute simulated/demo content for a real ingested message.
  if (emailsToScan.length === 0) {
    addLog("sync", "Gmail ingestion produced zero usable email scan-targets this sync.");
    // Phase 2 Task 1, Item B: the LOG line above still fires every sync (logs
    // are cheap and honest); only the Telegram ALERT is throttled, to at most
    // one per EMPTY_SYNC_ALERT_WINDOW_MS (see alertThrottle.ts) -- trailing,
    // so the first occurrence after a quiet period alerts immediately. State
    // survives restarts via the app_state key-value table (persistence.ts).
    // Fail closed toward "alert": a throttle-state read/write failure is
    // treated as never-alerted rather than silently suppressing the alert --
    // see alertThrottle.ts's module comment for why this control's
    // fail-closed direction is the opposite of the regime cache's.
    let lastAlertedAt: string | undefined;
    try {
      lastAlertedAt = productionStore.getAppState(EMPTY_SYNC_ALERT_STATE_KEY);
    } catch (throttleReadErr: any) {
      lastAlertedAt = undefined;
      addLog(
        "error",
        "Empty-sync alert throttle state could not be read; treating as never-alerted (will alert this sync).",
        throttleReadErr?.message || String(throttleReadErr),
      );
    }
    if (shouldSendThrottledAlert(lastAlertedAt, Date.now())) {
      const alertDelivered = await sendTelegramAlert(
        currentConfig.telegram,
        `⚠️ <b>Gmail ingestion produced zero usable emails this sync.</b> ${emptyEmailReason} No email-derived signals will be generated.`,
      );
      // Only a DELIVERED alert advances the throttle stamp. sendTelegramAlert
      // returns false both when Telegram isn't configured (silent no-op) and
      // when the send itself fails -- stamping either case would suppress the
      // first REAL alert for up to the full window (e.g. an operator enabling
      // Telegram right after a no-op "attempt" would hear nothing for 6h),
      // contradicting this control's fail-open-toward-alerting direction
      // (alertThrottle.ts module comment). An undelivered attempt leaves the
      // stamp untouched, so the next sync simply tries again.
      if (alertDelivered) {
        try {
          productionStore.setAppState(EMPTY_SYNC_ALERT_STATE_KEY, new Date().toISOString());
        } catch (throttleWriteErr: any) {
          addLog(
            "error",
            "Empty-sync alert throttle state could not be persisted; the next sync may alert again even within the throttle window.",
            throttleWriteErr?.message || String(throttleWriteErr),
          );
        }
      }
    }
  }

  // 2. Fetch YouTube News & Sentiment using Claude web search
  let youtubeResult: YoutubeSentimentResult;
  youtubeAttempted = true;
  try {
    addLog("sync", "Querying Claude web search for recent ZipTrader YouTube video sentiment...");
    const anthropic = getClaudeClient();
    const queryRes = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      messages: [
        {
          role: "user",
          content:
            "Find recent YouTube video titles and market opinions from the 'ZipTrader' channel in 2026. What stocks is he discussing and what is his current sentiment?",
        },
      ],
    });
    const sentiment = claudeText(queryRes);
    if (sentiment) {
      youtubeResult = { ok: true, sentiment };
      addLog("sentiment", "ZipTrader YouTube Sentinel scan completed successfully.", sentiment.substring(0, 300) + "...");
    } else {
      // Fail closed: an empty web-search result is not simulated content to fall
      // back on -- it contributes zero YouTube scan-targets, same as a hard failure.
      youtubeResult = { ok: false, reason: "Claude web search returned no content." };
      addLog("sentiment", "YouTube sentiment scan returned no content; contributing zero YouTube scan-targets this sync.");
    }
  } catch (err: any) {
    console.error("Claude web search error:", err);
    // Fail closed: no ANTHROPIC_API_KEY or a failed web-search call must never pass
    // an error string into analysis as if it were real sentiment.
    youtubeResult = { ok: false, reason: err.message || "Claude web search failed." };
    addLog("error", "YouTube sentiment scan failed; contributing zero YouTube scan-targets this sync.", err.message);
    youtubeErrored = true;
  }

  // 3. Process each scanned thesis with Claude
  // The YouTube target (when present) keeps a "now" timestamp deliberately: the
  // sentiment is the output of a web search that just completed above, not an
  // ingested document with its own real send time to recover.
  const scanTargets = assembleScanTargets(emailsToScan, youtubeResult);

  for (const target of scanTargets) {
    try {
      addLog("sync", `Analyzing thesis with Claude: "${target.title.substring(0, 45)}..."`);
      const anthropic = getClaudeClient();

      // Ask Claude for strict quantitative evaluation; the JSON schema below is
      // enforced by the API (structured outputs), not just requested in the prompt.
      const response = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: `Analyze the following stock newsletter or trading commentary from ZipTrader.
Source Type: ${target.source}
Title: ${target.title}
Content: ${target.content}

You must extract the stock ticker symbol mentioned (like PLTR, MARA, TSLA, NVDA), assess growth potential score (0 to 100), market sentiment score (-100 to 100), and define a risk profile ('Low' | 'Medium' | 'High').
Crucially, when the stock goes down for any reason, assess whether it is a support level 'whipsaw' because of the overall market volatility OR a genuine 'trend reversal' before deciding to act. Validate the fundamentals and the core thesis.
Set a decision: 'BUY' (if sentiment is very bullish & whipsaw check passes), 'SELL' (if trend reversal is verified or target stop loss hit), 'HOLD', or 'NONE' (if no clear ticker discussed).

For "reasoning", write a concise human sentence explaining the fundamental thesis validation. For "whipsawCheck", give a definitive explanation of whether the current pull-back is a whipsaw or genuine trend reversal.
For "whipsawVerdict", classify that same judgment into exactly one of three structured values: 'whipsaw' (a temporary shakeout -- the dip is likely to recover), 'reversal' (a verified genuine trend reversal), or 'unclear' (you cannot determine which). This structured value is what the trading system gates SELL decisions and BUY confidence on, so it must reflect your actual judgment, not just be copied from the decision field. If no clear ticker is discussed, set "symbol" to "UNKNOWN".`,
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                growthScore: { type: "integer" },
                sentimentScore: { type: "integer" },
                riskProfile: { type: "string", enum: ["Low", "Medium", "High"] },
                reasoning: { type: "string" },
                whipsawCheck: { type: "string" },
                whipsawVerdict: { type: "string", enum: ["whipsaw", "reversal", "unclear"] },
                decision: { type: "string", enum: ["BUY", "SELL", "HOLD", "NONE"] },
              },
              required: ["symbol", "growthScore", "sentimentScore", "riskProfile", "reasoning", "whipsawCheck", "whipsawVerdict", "decision"],
              additionalProperties: false,
            },
          },
        },
      });

      const text = claudeText(response) || "{}";
      const parsed = JSON.parse(text);

      if (parsed.symbol && parsed.symbol !== "UNKNOWN" && parsed.symbol !== "THE_STOCK_TICKER") {
        // Gate on the whipsaw verdict (docs/GO_LIVE_PLAN.md Phase 1.1): a SELL only
        // proceeds if the reversal is verified; a BUY's confidence is haircut based
        // on the verdict. normalizeWhipsawVerdict is defensive parse-site validation
        // on top of the API-enforced schema -- any value other than the three allowed
        // strings fails closed to "unclear" before it ever reaches the gate.
        const whipsawVerdict = normalizeWhipsawVerdict(parsed.whipsawVerdict);
        const rawAiConfidence = Math.max(0, Math.min(100, Math.round((parsed.growthScore + Math.max(parsed.sentimentScore, 0)) / 2)));
        const gated = applyWhipsawGate(parsed.decision, whipsawVerdict, rawAiConfidence);

        if (gated.downgraded) {
          addLog("sentiment", `Whipsaw gate for ${parsed.symbol}: ${gated.note}`);
        }

        const item: StockAnalysis = {
          id: "an-" + Math.random().toString(36).substr(2, 9),
          symbol: parsed.symbol.toUpperCase(),
          source: target.source as any,
          sourceTitle: target.title,
          sourceContent: target.content,
          growthScore: parsed.growthScore,
          sentimentScore: parsed.sentimentScore,
          riskProfile: parsed.riskProfile as any,
          // Honest audit trail: when the gate downgrades a SELL to HOLD, that fact is
          // recorded directly in the persisted reasoning, not just the sync log.
          reasoning: gated.downgraded ? `${parsed.reasoning} [Whipsaw gate: ${gated.note}]` : parsed.reasoning,
          whipsawCheck: parsed.whipsawCheck,
          whipsawVerdict,
          decision: gated.decision as any,
          // Real source timestamp (Gmail internalDate/Date header for email, or
          // "now" for the just-completed YouTube web search) -- not "now" for
          // every thesis regardless of actual age. This is what lets the signal
          // engine's freshness check (maxAgeHours) do anything at all.
          timestamp: target.sourceTimestamp,
        };

        const rawSignal = createRawSignal({
          source: target.source === "youtube" ? "youtube" : "email",
          // Finding I1: identify an email by Gmail's message id, not its subject
          // line -- two distinct emails (e.g. a recurring weekly newsletter) can
          // share an identical title, which would otherwise collapse them into one
          // dedup identity. Falls back to the title-based id defensively if a
          // message id was never captured. YouTube has no per-message resource
          // (it's a fresh web-search summary each run) so it keeps the title-based
          // sourceId, unchanged.
          sourceId: target.source === "email" && target.messageId
            ? `email:${target.messageId}`
            : `${target.source}:${target.title}`,
          sourceTimestamp: item.timestamp,
          symbol: item.symbol,
          thesis: `${item.reasoning} ${item.whipsawCheck}`,
          // Finding I1: hash the raw ingested email body for dedup instead of
          // `thesis` above. `thesis` is Claude's free-text re-analysis of that
          // body, and its wording drifts between separate analyses of the exact
          // same email -- hashing it made the dedup key non-deterministic in
          // production (masked in testing only by the 24h symbol cooldown).
          // `target.content` is stable across re-syncs of the same message.
          // YouTube has no such stable content handle (the "content" IS a fresh
          // search summary each run) so it keeps hashing `thesis`, unchanged.
          dedupContent: target.source === "email" ? target.content : undefined,
          url: target.source === "youtube" ? "youtube://ziptrader" : "gmail://ziptrader",
          // Confidence already carries the whipsaw haircut (or is unchanged for
          // whipsaw/HOLD/NONE) -- this is what flows into sizing's confidenceMultiplier.
          aiConfidence: gated.aiConfidence,
        });
        const reviewedSignal = reviewAndPersistSignal(productionStore, rawSignal);
        if (reviewedSignal.status === "rejected") {
          addLog("error", `Signal rejected for ${item.symbol}: ${reviewedSignal.rejectionReason}`);
          continue;
        }

        db.analyses.unshift(item);
        parsedAnalyses.push(item);
        results.push(item);

        addLog("sentiment", `Analyzed ${item.symbol}: Growth ${item.growthScore}, Sentiment ${item.sentimentScore}%. Decision: ${item.decision}`);

        // 4. Automated orders placing based on Decision and Risk checks
        if (currentConfig.system.autoTrading && (item.decision === "BUY" || item.decision === "SELL")) {
          addLog("sync", `Risk Engine Evaluation for ticker ${item.symbol}...`);
          
          // Verify current position size limit
          const portfolio = await getAlpacaPortfolio();
          const currentShares = portfolio.positions.find((p: any) => p.symbol === item.symbol);
          const parsedPortfolioValue = Number(portfolio.portfolio_value);
          if (!Number.isFinite(parsedPortfolioValue) || parsedPortfolioValue <= 0) {
            addLog("error", `Order skipped for ${item.symbol}. Portfolio value is not a finite number; failing closed.`);
            continue;
          }
          const maxPositionValue = parsedPortfolioValue * (currentConfig.system.maxPositionSizePercent / 100);

          let price = 0;
          try {
            // Get current price if possible
            const brokerConfig = getBrokerConfig();
            if (brokerConfig.configured) {
              // Market data lives on data.alpaca.markets, not the trading host.
              const dataBaseUrl = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
              const latestTrade = await fetch(`${dataBaseUrl}/v2/stocks/${item.symbol}/trades/latest`, {
                headers: {
                  "APCA-API-KEY-ID": brokerConfig.apiKey || "",
                  "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
                },
              });
              if (latestTrade.ok) {
                const body = await latestTrade.json();
                price = Number(body.trade?.p || 0);
              }
            } else {
              const simulatedPos = (portfolio.positions || []).find((p: any) => p.symbol === item.symbol);
              price = Number(simulatedPos?.current_price || 0);
            }
          } catch (e) {
            addLog("error", `Price lookup failed for ${item.symbol}: ${e instanceof Error ? e.message : String(e)}`);
          }

          if (!price || !Number.isFinite(price) || price <= 0) {
            addLog("error", `Order skipped for ${item.symbol}. No deterministic market price was available.`);
            continue;
          }

          if (item.decision === "BUY") {
            const portfolioAssessment = assessPortfolio({
              account: portfolio,
              positions: portfolio.positions || [],
              openOrders: await getAlpacaOpenOrders(),
              source: getBrokerConfig().configured ? "alpaca" : "local_simulated_snapshot",
            });
            // Reuse this sync's already-fetched/persisted assessment (MODULE 2.5)
            // rather than re-querying the store or recomputing per item; recompute
            // with this item's symbol only to pick up the BTC-linked reason text
            // for crypto-linked equities (see regimeEngine.ts) -- marketMode/
            // tradePermission/sizeMultiplier are unaffected by symbol.
            const regime = detectRegime({ ...regimeAssessment.inputs, symbol: item.symbol });
            const stopLossPercent = Number(currentConfig.system.stopLossPercent);
            if (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0) {
              addLog("error", `Order skipped for ${item.symbol}. stopLossPercent is not a positive finite number.`);
              continue;
            }
            const sized = sizeTradeIntent({
              reviewedSignal,
              regime,
              portfolio: portfolioAssessment,
              side: "buy",
              estimatedPrice: price,
              stopLossPrice: price * (1 - stopLossPercent / 100),
              limits: {
                maxSinglePositionPercent: currentConfig.system.maxPositionSizePercent,
                maxPortfolioExposurePercent: riskLimits.maxPortfolioExposurePercent,
                maxNotionalPerTrade: maxPositionValue,
                minBuyingPowerAfterTrade: riskLimits.minBuyingPower,
              },
            });

            if (sized.qty < 1) {
              addLog("error", `Order skipped for ${item.symbol}. Sizing produced no executable quantity (${sized.sizingReason}; caps: ${sized.capsApplied.join(", ")}).`);
            } else if (buyOrdersThisCycle >= MAX_BUYS_PER_CYCLE) {
              // Guardrail 8 (docs/GO_LIVE_PLAN.md Phase 2.1): per-cycle BUY cap.
              // This 3rd+ BUY-decision this cycle is skipped BEFORE executeTradeIntent
              // is ever called -- no broker call, no risk review, just an honest,
              // audited skip. SELLs/exits are never capped (see the SELL branch below
              // and MODULE 2's liquidations above -- neither touches this counter).
              addLog("error", `Order skipped for ${item.symbol}. Per-cycle BUY cap (${MAX_BUYS_PER_CYCLE}) already reached this cycle.`);
              appendAuditEvents(db, [{
                id: `ae-buycap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                type: "risk",
                actor: trigger === "scheduled" ? "scheduler" : "manual_api",
                message: `BUY order for ${item.symbol} skipped: per-cycle BUY cap (${MAX_BUYS_PER_CYCLE}) reached.`,
                details: { symbol: item.symbol, cap: MAX_BUYS_PER_CYCLE, trigger },
              }]);
            } else {
              buyOrdersThisCycle++;
              const qty = sized.qty;
              addLog("sync", `Submitting buy intent for ${qty} shares of ${item.symbol} at approx $${price} through safety pipeline...`);
              const newTrade = await executeTradeIntent({
                db,
                config: currentConfig,
                request: {
                  source: "automation",
                  symbol: item.symbol,
                  qty,
                  estimatedPrice: price,
                  side: "buy",
                  reasoning: `ZipTrader thesis validated. Whipsaw check: ${item.whipsawCheck}. Fundamentals: ${item.reasoning}`,
                },
                maxNotional: maxPositionValue,
                marketKnownClosed,
              });

              // Notify channels
              const tgMsg = `🚨 <b>ZipTrader Automation: BUY INTENT ${newTrade.status}</b>\n<b>Ticker:</b> ${newTrade.symbol}\n<b>Quantity:</b> ${newTrade.qty}\n<b>Price:</b> $${newTrade.price}\n<b>Thesis Log:</b> ${newTrade.reasoning}`;
              newTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);

              // Log to Sheet
              newTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, newTrade);

              // Log to Notion
              newTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, item);

              db.trades.unshift(newTrade);

              // Update simulation list
              if (!getBrokerConfig().configured && newTrade.status !== "BrokerFailed" && newTrade.status !== "RiskRejected") {
                const currentSim = db.simulatedPortfolio;
                const existingPos = currentSim.positions.find((p: any) => p.symbol === item.symbol);
                if (existingPos) {
                  const oldQty = parseInt(existingPos.qty);
                  const oldBasis = parseFloat(existingPos.cost_basis);
                  const newQty = oldQty + qty;
                  const newBasis = oldBasis + (qty * price);
                  existingPos.qty = String(newQty);
                  existingPos.cost_basis = String(newBasis);
                  existingPos.current_price = String(price);
                  existingPos.market_value = String(newQty * price);
                } else {
                  currentSim.positions.push({
                    symbol: item.symbol,
                    qty: String(qty),
                    market_value: String(qty * price),
                    cost_basis: String(qty * price),
                    unrealized_pl: "0.00",
                    unrealized_plpc: "0.0000",
                    current_price: String(price),
                    avg_entry_price: String(price)
                  });
                }
                currentSim.cash = String(parseFloat(currentSim.cash) - (qty * price));
                currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) + (qty * price));
              }

              addLog("trade", `Submitted BUY ${qty} shares of ${item.symbol}. State: ${newTrade.status}. Telegram: ${newTrade.notifiedTelegram ? 'Sent' : 'Disabled'}, Sheets: ${newTrade.exportedSheets ? 'Appended' : 'Disabled'}, Notion: ${newTrade.loggedNotion ? 'Saved' : 'Disabled'}`);
            }
          } else if (item.decision === "SELL" && currentShares && parseInt(currentShares.qty) > 0) {
            const qty = parseInt(currentShares.qty);
            addLog("sync", `Submitting sell recommendation intent to close position of ${qty} shares for ${item.symbol}...`);
            const newTrade = await executeTradeIntent({
              db,
              config: currentConfig,
              request: {
                source: "automation",
                symbol: item.symbol,
                qty,
                estimatedPrice: price,
                side: "sell",
                reasoning: `Trend reversal warning assessed or stop loss margin hit. Closing positions.`,
              },
              marketKnownClosed,
            });

            const tgMsg = `🚨 <b>ZipTrader Automation: SELL INTENT ${newTrade.status}</b>\n<b>Ticker:</b> ${newTrade.symbol}\n<b>Quantity:</b> ${newTrade.qty}\n<b>Price:</b> $${newTrade.price}\n<b>Reasoning:</b> ${newTrade.reasoning}`;
            newTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
            newTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, newTrade);
            newTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, item);

            db.trades.unshift(newTrade);

            if (!getBrokerConfig().configured && newTrade.status !== "BrokerFailed" && newTrade.status !== "RiskRejected") {
              const currentSim = db.simulatedPortfolio;
              currentSim.positions = currentSim.positions.filter((p: any) => p.symbol !== item.symbol);
              currentSim.cash = String(parseFloat(currentSim.cash) + (qty * price));
              currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) - (qty * price));
            }

            addLog("trade", `Submitted SELL ${qty} shares of ${item.symbol}. State: ${newTrade.status}. Telegram: ${newTrade.notifiedTelegram ? 'Sent' : 'Disabled'}`);
          }
        }
      }
    } catch (err: any) {
      console.error("Failed to parse analysis target:", err);
      addLog("error", `Failed checking thesis for target: "${target.title}"`, err.message);
    }
  }
  }

  addLog("sync", "ZipTrader portfolio optimization cycle completed.");
  writeDB(db);
  // Guardrail 7 (docs/GO_LIVE_PLAN.md Phase 2.1): a cycle counts as FAILED if
  // every ATTEMPTED ingestion source errored -- not merely zero emails/no
  // YouTube content, both of which are expected, non-error outcomes (see
  // gmailErrored/youtubeErrored above, only ever set true in an actual
  // fetch-failure/non-OK-response/exception branch), and not a source that
  // was never attempted at all (e.g. Gmail on a scheduled cycle, which never
  // carries an OAuth token). Only meaningful when ingestion actually ran
  // (!reducedCycle) -- a reduced cycle that skipped ingestion entirely never
  // counts as failed on this basis, only a thrown exception (the outer catch
  // below) can fail a reduced cycle.
  const anySourceAttempted = gmailAttempted || youtubeAttempted;
  const allAttemptedSourcesErrored = (!gmailAttempted || gmailErrored) && (!youtubeAttempted || youtubeErrored);
  const failed = !reducedCycle && anySourceAttempted && allAttemptedSourcesErrored;
  return { ok: true, trigger, analyses: parsedAnalyses, logs, failed };
  } catch (err: any) {
    console.error("Critical error in /api/sync:", err);
    return { ok: false, trigger, error: err.message };
  } finally {
    release();
  }
}

app.post("/api/sync", requireAdminCommand, async (req, res) => {
  const result = await runSyncCycle("manual", req.headers.authorization || null);
  // Explicit `=== true`/`=== false` (not a truthy `if (result.ok)`): this
  // tsconfig doesn't enable strictNullChecks, and without it TS's
  // discriminated-union narrowing only fires on an explicit literal
  // comparison, not a truthiness check -- same reason numericSafety.ts's
  // ParsedFiniteNumber callers below use `parsed.ok === false` throughout.
  if (result.ok === true) {
    res.json({ success: true, analyses: result.analyses, logs: result.logs });
  } else {
    res.status(500).json({ error: "Sync failed", details: result.error });
  }
});

// Manual Override trade actions API
app.post("/api/override/trade", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const { symbol, side } = req.body;
    const db = readDB();
    const authHeader = req.headers.authorization || null;

    const currentConfig: AppConfig = db.config;
    const timestamp = new Date().toISOString();

    const addLog = (type: SyncLog["type"], msg: string, details?: string) => {
      db.syncLogs.unshift({ id: "l-" + Math.random().toString(36).substr(2, 9), timestamp, type, message: msg, details });
    };

    // Fail closed on unparsable request numerics (docs/GO_LIVE_PLAN.md Phase 1.4):
    // a non-finite/non-positive qty or price is rejected outright rather than
    // coerced to NaN/0 and passed through to the safety pipeline.
    const qtyParsed = parseFiniteNumber(req.body.qty, "qty");
    if (!qtyParsed.ok || qtyParsed.value <= 0) {
      res.status(400).json({ error: "Manual trade override rejected", details: `Request field "qty" must be a positive finite number.` });
      return;
    }
    const priceParsed = parseFiniteNumber(req.body.price, "price");
    if (!priceParsed.ok || priceParsed.value <= 0) {
      res.status(400).json({ error: "Manual trade override rejected", details: `Request field "price" must be a positive finite number.` });
      return;
    }
    const requestedQty: number = qtyParsed.value;
    const price: number = priceParsed.value;

    let qty: number = requestedQty;
    let clamp: { requestedQty: number; approvedQty: number; capsApplied: string[] } | undefined;

    // Task 12 (docs/GO_LIVE_PLAN.md Phase 1.4, "Route every buy path through
    // sizing"): a manual BUY is clamped to the same per-position/exposure/
    // buying-power/max-notional caps the automation path (/api/sync) uses, via
    // the computeCapRoom helper shared with sizingEngine.ts's sizeTradeIntent --
    // no forked math. Deliberately skips sizeTradeIntent's confidence/stop-
    // distance/regime multipliers: those scale down for automated *signal
    // quality*, which has no meaning for a human's explicit order. SELLs are
    // de-risking and stay unrestricted by these caps (unchanged).
    if (side === "buy") {
      const brokerConfig = getBrokerConfig();
      const portfolio = await getAlpacaPortfolio(brokerConfig);
      const portfolioAssessment = assessPortfolio({
        account: portfolio,
        positions: portfolio.positions || [],
        openOrders: await getAlpacaOpenOrders(brokerConfig),
        source: brokerConfig.configured ? "alpaca" : "local_simulated_snapshot",
      });
      const parsedPortfolioValue = Number(portfolio.portfolio_value);
      if (!Number.isFinite(parsedPortfolioValue) || parsedPortfolioValue <= 0) {
        addLog("error", `Manual override BUY rejected for ${symbol}. Portfolio value is not a finite number; failing closed.`);
        writeDB(db);
        res.status(422).json({ error: "Manual trade override rejected", details: "Portfolio value is not a finite number; failing closed." });
        return;
      }
      // Same wiring as the automation buy path in /api/sync: max-notional-per-trade
      // is maxPositionSizePercent of total portfolio value, not equity.
      const maxNotionalPerTrade = parsedPortfolioValue * (currentConfig.system.maxPositionSizePercent / 100);

      const capRoom = computeCapRoom({
        portfolio: portfolioAssessment,
        symbol,
        limits: {
          maxSinglePositionPercent: currentConfig.system.maxPositionSizePercent,
          maxPortfolioExposurePercent: riskLimits.maxPortfolioExposurePercent,
          maxNotionalPerTrade,
          minBuyingPowerAfterTrade: riskLimits.minBuyingPower,
        },
      });
      const capQty = capRoomToQty(capRoom.allowedNotional, price);

      if (capQty <= 0) {
        const capNames = capRoom.capsApplied.join(", ") || "no room remaining";
        addLog("error", `Manual override BUY rejected for ${symbol}. No executable quantity remains under cap(s): ${capNames}.`);
        writeDB(db);
        res.status(422).json({
          error: "Manual trade override rejected",
          details: `No executable quantity remains under cap(s): ${capNames}.`,
          capsApplied: capRoom.capsApplied,
        });
        return;
      }

      if (capQty < requestedQty) {
        qty = capQty;
        clamp = { requestedQty, approvedQty: capQty, capsApplied: capRoom.capsApplied };
        addLog("override", `Manual override BUY for ${symbol} clamped from ${requestedQty} to ${capQty} shares (cap: ${capRoom.capsApplied.join(", ")}).`);
        appendAuditEvents(db, [{
          id: `ae-override-clamp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          type: "risk",
          actor: "ui",
          message: `Manual override BUY for ${symbol} clamped from ${requestedQty} to ${capQty} shares by cap(s): ${capRoom.capsApplied.join(", ")}.`,
          details: { symbol, requestedQty, approvedQty: capQty, capsApplied: capRoom.capsApplied },
        }]);
      }
    }

    addLog("override", `Manual Override Triggered: Place market order: ${side.toUpperCase()} ${qty} ${symbol}`);

    const tradeVal = await executeTradeIntent({
      db,
      config: currentConfig,
      request: {
        source: "manual",
        symbol,
        qty,
        estimatedPrice: price,
        side,
        reasoning: clamp
          ? `Manual trader override dispatched from dashboard control deck. Requested ${clamp.requestedQty}, clamped to ${clamp.approvedQty} by cap(s): ${clamp.capsApplied.join(", ")}.`
          : "Manual trader override dispatched from dashboard control deck.",
        actor: "ui",
      },
    });

    // Dispatch notifications
    const tgMsg = `🚨 <b>MANUAL OVERRIDE ${tradeVal.status}</b>\n<b>Ticker:</b> ${tradeVal.symbol}\n<b>Side:</b> ${tradeVal.side.toUpperCase()}\n<b>Qty:</b> ${tradeVal.qty}\n<b>Price:</b> $${tradeVal.price}`;
    tradeVal.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
    tradeVal.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, tradeVal);

    // Intentionally NOT deduped by client_order_id: this legacy JSON trades log is an
    // append-only per-attempt record (UI history, daily trade counting); the SQLite
    // trade_intents store is the deduped source of truth for reconciliation (Task 13).
    db.trades.unshift(tradeVal);

    if (!getBrokerConfig().configured && tradeVal.status !== "BrokerFailed" && tradeVal.status !== "RiskRejected") {
      const currentSim = db.simulatedPortfolio;
      const existingPos = currentSim.positions.find((p: any) => p.symbol === symbol);
      const sharesCost = qty * price;

      if (side === "buy") {
        if (existingPos) {
          const oq = parseInt(existingPos.qty);
          const oc = parseFloat(existingPos.cost_basis);
          existingPos.qty = String(oq + qty);
          existingPos.cost_basis = String(oc + sharesCost);
          existingPos.market_value = String((oq + qty) * price);
        } else {
          currentSim.positions.push({
            symbol,
            qty: String(qty),
            market_value: String(sharesCost),
            cost_basis: String(sharesCost),
            unrealized_pl: "0.00",
            unrealized_plpc: "0.0000",
            current_price: String(price),
            avg_entry_price: String(price)
          });
        }
        currentSim.cash = String(parseFloat(currentSim.cash) - sharesCost);
        currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) + sharesCost);
      } else {
        if (existingPos) {
          const oq = parseInt(existingPos.qty);
          const remainder = oq - qty;
          if (remainder <= 0) {
            currentSim.positions = currentSim.positions.filter((p: any) => p.symbol !== symbol);
          } else {
            existingPos.qty = String(remainder);
            existingPos.market_value = String(remainder * price);
          }
          currentSim.cash = String(parseFloat(currentSim.cash) + sharesCost);
          currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) - sharesCost);
        }
      }
    }

    writeDB(db);
    res.json({ success: true, trade: tradeVal, ...(clamp ? { clamp } : {}) });
  } catch (err: any) {
    console.error("Critical error in /api/override/trade:", err);
    res.status(500).json({ error: "Manual trade override failed", details: err.message });
  } finally {
    release();
  }
});

// Urgent close-out control
app.post("/api/override/close-all", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const timestamp = new Date().toISOString();
    const config = db.config;

    db.syncLogs.unshift({
      id: "l-" + Math.random().toString(36).substr(2, 9),
      timestamp,
      type: "override",
      message: "EMERGENCY OVERRIDE Dispatched: Close out all paper portfolio positions immediately."
    });

    const portfolio = await getAlpacaPortfolio();

    for (const pos of portfolio.positions) {
      const currentPrice = parseFloat(pos.current_price);
      if (!currentPrice || !Number.isFinite(currentPrice)) {
        db.syncLogs.unshift({
          id: "l-" + Math.random().toString(36).substr(2, 9),
          timestamp,
          type: "error",
          message: `Emergency close skipped for ${pos.symbol}; no deterministic current price was available.`,
        });
        continue;
      }
      const emergencyTrade = await executeTradeIntent({
        db,
        config,
        request: {
          source: "emergency",
          symbol: pos.symbol,
          qty: parseInt(pos.qty),
          estimatedPrice: currentPrice,
          side: "sell",
          reasoning: "Emergency override action triggered from administrative dashboard.",
          actor: "ui",
        },
      });
      db.trades.unshift(emergencyTrade);
    }

    if (!getBrokerConfig().configured) {
      const totalPosValue = parseFloat(db.simulatedPortfolio.long_market_value) || 0;
      db.simulatedPortfolio.cash = String(parseFloat(db.simulatedPortfolio.cash) + totalPosValue);
      db.simulatedPortfolio.long_market_value = "0.00";
      db.simulatedPortfolio.positions = [];
    }

    // Send panic telegram broadcast
    await sendTelegramAlert(config.telegram, "🚨 <b>Portfolio Panic Trigger: EMERGENCY CLOSE DISPATCHED.</b> All open paper positions have been sold to secure liquidated capital reserves.");

    writeDB(db);
    res.json({ success: true, message: "Emergency portfolio liquidate sequence executed successfully." });
  } catch (err: any) {
    console.error("Critical error in /api/override/close-all:", err);
    res.status(500).json({ error: "Emergency close out failed", details: err.message });
  } finally {
    release();
  }
});


// Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): the autonomous sync
// scheduler. Wired here (module scope, not inside run()) so it exists
// regardless of NODE_ENV -- only `.start()` (called from run() below) is
// gated off in tests; the instance itself, and the test-visible manual tick
// trigger exported at the bottom of this file, are always available so
// integration tests can drive scheduled cycles without waiting on a real
// setTimeout chain.
const SCHEDULER_FAILURE_COUNT_STATE_KEY = "scheduler_consecutive_failure_count";

const scheduler = createScheduler({
  now: () => Date.now(),
  setTimer: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  getIntervalMinutesRaw: () => readDB().config?.system?.runIntervalMins,
  isAutoTradingOn: () => Boolean(readDB().config?.system?.autoTrading),
  runScheduledCycle: async () => {
    const result = await runSyncCycle("scheduled", null);
    return { failed: result.ok ? result.failed : true };
  },
  getConsecutiveFailureCount: () => {
    try {
      const raw = productionStore.getAppState(SCHEDULER_FAILURE_COUNT_STATE_KEY);
      const parsed = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (err) {
      console.error("[scheduler] Failed to read the persisted consecutive-failure count; defaulting to 0.", err);
      return 0;
    }
  },
  setConsecutiveFailureCount: (count) => {
    try {
      productionStore.setAppState(SCHEDULER_FAILURE_COUNT_STATE_KEY, String(count));
    } catch (err) {
      console.error("[scheduler] Failed to persist the consecutive-failure count.", err);
    }
  },
  onAutoPause: async () => {
    // Guardrail 7: 3 consecutive failed SCHEDULED sync cycles ->
    // autoTrading=false (persisted), an audit event, and an UNTHROTTLED
    // Telegram alert (unlike the empty-sync alert, this fires once per
    // actual pause -- a state change, not a repeating warning).
    const release = await dbMutex.acquire();
    let telegramConfig: AppConfig["telegram"] | undefined;
    try {
      const db = readDB();
      db.config.system.autoTrading = false;
      telegramConfig = db.config.telegram;
      appendAuditEvents(db, [{
        id: `ae-autopause-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: "config",
        actor: "scheduler",
        message: `Auto-pause: ${MAX_CONSECUTIVE_FAILURES} consecutive scheduled sync cycle failures; autoTrading set to false. Stays paused until a human resumes.`,
        details: { consecutiveFailures: MAX_CONSECUTIVE_FAILURES },
      }]);
      writeDB(db);
    } finally {
      release();
    }
    await sendTelegramAlert(
      telegramConfig,
      `🛑 <b>Auto-trading paused.</b> ${MAX_CONSECUTIVE_FAILURES} consecutive scheduled sync cycles failed. Trading stays paused until a human resumes (POST /api/config or the Telegram /resume command).`,
    );
  },
  log: (message) => console.log(message),
});

// Test-visible manual trigger (Phase 2 Task 2 testing requirement): runs
// exactly one scheduled tick's logic directly, without waiting for a real
// timer. NODE_ENV=test never calls scheduler.start() (see the bottom of this
// file), so this is the only way a test drives a scheduled cycle.
async function runScheduledSyncTickForTests(): Promise<void> {
  await scheduler.runTickNow();
}

// Dev support or vite mounting
async function run() {
  const startupIssues = validateStartupEnv(process.env);
  for (const issue of startupIssues) {
    const log = issue.level === "fatal" ? console.error : console.warn;
    log(`[startup:${issue.level}] ${issue.message}`);
  }
  if (startupIssues.some((issue) => issue.level === "fatal")) {
    console.error("[startup] Fatal configuration issues found. Refusing to start.");
    process.exit(1);
  }

  const distPath = path.join(process.cwd(), "dist");

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server starting on port ${PORT}`);
    startTelegramRuntime();
    scheduler.start();
  });

  installProcessGuards({
    log: (message, error) => (error === undefined ? console.error(message) : console.error(message, error)),
    exit: (code) => process.exit(code),
    closeServer: (onClosed) => httpServer.close(onClosed),
    stopScheduler: () => scheduler.stop(),
  });
}

export { app, dbMutex, handleTelegramCommand, readDB, runScheduledSyncTickForTests };

if (process.env.NODE_ENV !== "test") {
  run();
}
