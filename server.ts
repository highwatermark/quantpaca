import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { AlpacaPosition, AppConfig, StockAnalysis, Trade, SyncLog } from "./src/types";
import {
  AuditEvent,
  BROKER_SUCCESS_TRADE_STATUSES,
  BrokerConfig,
  buildBrokerConfigFromEnv,
  ExitPlan,
  redactConfigForClient,
  RiskDecision,
  stripPersistedSecrets,
  submitTradeThroughPipeline,
  TradeRequest,
  TradeState,
} from "./src/server/tradingSafety";
import {
  fetchBrokerOrder,
  applyLegPollResult,
  isTerminalTradeState,
  pollPendingOrders,
} from "./src/server/orderStatusPoller";
import { createProductionStore } from "./src/server/persistence";
import { buildBracketLegs, BRACKET_TIME_IN_FORCE, PLAIN_TIME_IN_FORCE } from "./src/server/bracketOrders";
import { createRawSignal } from "./src/server/signalEngine";
import { applyWhipsawGate, normalizeWhipsawVerdict } from "./src/server/whipsawGate";
import { BearishMappingResult, evaluateBearishMapping, normalizeStance } from "./src/server/bearishMapping";
import { CROSS_SOURCE_WINDOW_HOURS, evaluateCrossSource } from "./src/server/crossSourceConfirmation";
import { reviewAndPersistSignal } from "./src/server/signalReviewStep";
import { extractEmailScanTarget, extractFromHeader } from "./src/server/emailIngestion";
import { assembleScanTargets, EmailScanTarget, YoutubeSentimentResult } from "./src/server/scanTargetAssembly";
import { loadSourceRegistry, GMAIL_MAX_RESULTS_PER_SOURCE, MAX_ENABLED_SOURCES_PER_CYCLE, SourceRegistryIssue } from "./src/server/sourceRegistry";
import { evaluateSender } from "./src/server/senderPolicy";
import { detectRegime } from "./src/server/regimeEngine";
import { assessPortfolio } from "./src/server/portfolioEngine";
import { buildPositionReconciliationReport, reconcileBrokerState } from "./src/server/reconciliationEngine";
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
import { checkAssetTradable } from "./src/server/tradabilityGuard";
import { ReconciliationReport, RegimeAssessment } from "./src/server/domainTypes";
import { parseFiniteNumber } from "./src/server/numericSafety";
import { EMPTY_SYNC_ALERT_STATE_KEY, EMPTY_SYNC_ALERT_WINDOW_MS, shouldSendThrottledAlert } from "./src/server/alertThrottle";
import { createScheduler, resolveIntervalMinutes, MAX_BUYS_PER_CYCLE, MAX_CONSECUTIVE_FAILURES } from "./src/server/scheduler";
import {
  CRASH_LOOP_MAX_BOOTS,
  CRASH_LOOP_WINDOW_MS,
  CRASH_LOOP_STAY_DOWN_EXIT_CODE,
  RESTART_HISTORY_APP_STATE_KEY,
  CLEAN_SHUTDOWN_APP_STATE_KEY,
  evaluateCrashLoopOnBoot,
  parseRestartHistory,
} from "./src/server/crashLoopGuard";
import {
  MISSED_CYCLE_ALERT_MULTIPLIER,
  CYCLE_COUNT_APP_STATE_KEY,
  LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY,
  WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY,
  shouldSendHeartbeat,
  shouldAlertOverdueGap,
} from "./src/server/heartbeat";
import {
  buyGateRejectionReason,
  clearOrphans,
  getOrphanOrders,
  hasUnresolvedOrphans,
  isTradingReady,
  runStartupReconciliation,
  STARTUP_ORPHANS_APP_STATE_KEY,
} from "./src/server/startupReconciliation";
import { BackupDeps, runBackup, shouldRunScheduledBackup } from "./src/server/backupEngine";
import { fetchWithTimeout } from "./src/server/httpDefaults";
import { createRateLimitMiddleware } from "./src/server/rateLimiter";
import { AppStore, createAppStore, DBJSON_MIGRATED_AT_APP_STATE_KEY, migrateDbJsonIfNeeded, SimulatedPortfolio } from "./src/server/appStore";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): a simple in-memory
// fixed-window limiter across all of /api/* (RATE_LIMIT_PER_MINUTE per IP;
// /api/health is exempt -- see rateLimiter.ts). Mounted once, before every
// route, so it applies uniformly to admin/read/unauthenticated routes alike.
// This is an intentionally minimal control, not a substitute for a real
// reverse-proxy rate limiter in production -- see docs/OPS_RUNBOOK.md.
app.use("/api", createRateLimitMiddleware());

const DATA_DIR = process.env.QUANTPACA_DATA_DIR || path.join(process.cwd(), "data");
// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// db.json is frozen legacy state -- read exactly once, at boot, by the
// one-time migration below (migrateDbJsonIfNeeded), and never written again.
// It is deliberately NOT deleted (conservative migration; see
// docs/OPS_RUNBOOK.md). DB_PATH stays a module constant because
// backupEngine.ts's best-effort backup copy (Task 13) and the migration both
// still need to know where it lives on disk.
const DB_PATH = path.join(DATA_DIR, "db.json");
const productionStore = createProductionStore(path.join(DATA_DIR, "quantpaca.sqlite"));
// Store facade (src/server/appStore.ts) -- replaces the old atomic-JSON
// read/write db.json pair everywhere in this file. Owns the config
// read-modify-write mutex internally (see appStore.ts's doc comment); every
// OTHER call site in this file that needs to compose several appStore calls
// into one larger critical section still acquires appStore.acquire() itself
// first, same acquire/read/.../write/release pattern the old db.json mutex
// call sites used.
const appStore: AppStore = createAppStore(productionStore);
// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4): the signal-source registry
// lives alongside the rest of this app's data (same DATA_DIR as the sqlite
// file), not a new env var -- it's config DATA, edited by operators, not a
// deploy-time setting. sourceRegistry.ts creates it with the default
// ZipTrader-only source on first read if it's absent (migration-safe).
const SOURCE_REGISTRY_PATH = path.join(DATA_DIR, "signal-sources.json");
// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backups land here,
// same DATA_DIR convention as everything else -- survives container
// replacement via the same volume mount documented in docs/OPS_RUNBOOK.md.
const BACKUPS_DIR = path.join(DATA_DIR, "backups");

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
// (Task 5: moved to tradingSafety.ts so persistence.ts can reuse the same set --
// see that module's comment.)

const getBrokerConfig = () => buildBrokerConfigFromEnv(process.env);

// Phase 2 Task 14: this used to ALSO push onto the legacy db.json
// `auditEvents` array (db.auditEvents.push(...)) -- removed. SQLite's
// audit_events table (productionStore.appendAuditEvents, below) was already
// written unconditionally on every call, so it was always a full mirror; the
// db.json copy was 100% redundant. GET /api/audit already reads straight
// from productionStore.listAuditEvents().
function appendAuditEvents(events: AuditEvent[]) {
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

// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): read-endpoint auth.
// Accepts EITHER a dedicated read-only token (QUANTPACA_READ_TOKEN, a
// lower-privilege credential meant for dashboards/monitors) OR the admin
// token (an operator who already has admin access can read too). Mirrors
// requireAdminCommand's shape: disabled (503) only when NEITHER token is
// configured at all -- there would be nothing to check a provided token
// against. When only the admin token is configured (QUANTPACA_READ_TOKEN
// unset), read endpoints simply require that -- see startupChecks.ts's boot
// warning recommending a dedicated read token be set.
//
// /api/health is deliberately NOT behind this middleware (Docker healthcheck
// + uptime monitors need it unauthenticated) -- see its route below, and
// createRateLimitMiddleware's matching exemption.
function requireReadToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN || "";
  const readToken = process.env.QUANTPACA_READ_TOKEN || "";
  if (!adminToken && !readToken) {
    res.status(503).json({
      error: "Read routes are disabled until QUANTPACA_READ_TOKEN or ADMIN_API_TOKEN is configured.",
    });
    return;
  }
  const providedAdminToken = req.header("x-admin-token") || "";
  const providedReadToken = req.header("x-read-token") || "";
  const adminOk = Boolean(adminToken) && Boolean(providedAdminToken) && tokensMatch(providedAdminToken, adminToken);
  const readOk = Boolean(readToken) && Boolean(providedReadToken) && tokensMatch(providedReadToken, readToken);
  if (!adminOk && !readOk) {
    res.status(401).json({ error: "Unauthorized read request." });
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

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3): app_state (persistence.ts)
// keys for position-level reconciliation's own small pieces of cross-restart
// state -- same "no schema migration needed" convention as
// EMPTY_SYNC_ALERT_STATE_KEY (alertThrottle.ts) and STARTUP_ORPHANS_APP_STATE_KEY
// (startupReconciliation.ts).
const RECONCILIATION_ACKNOWLEDGED_BASELINES_APP_STATE_KEY = "reconciliation_acknowledged_baselines";
const RECONCILIATION_MISMATCH_ALERT_STATE_KEY = "reconciliation_mismatch_alert_state";

// POST /api/reconciliation/acknowledge (below) writes this map (symbol ->
// accepted baseline qty); computeExpectedPositions (reconciliationEngine.ts)
// folds it additively into the expected-position ledger every cycle. Fails
// closed to {} (no baselines) on any read/parse/shape failure -- an admin's
// prior acknowledgment silently going missing can only make a real drift MORE
// visible again (re-flagged as unexpected_position), never less, which is
// the same fail-closed-into-visibility direction as every other control in
// this task.
function readAcknowledgedBaselines(): Record<string, number> {
  try {
    const raw = productionStore.getAppState(RECONCILIATION_ACKNOWLEDGED_BASELINES_APP_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [symbol, qty] of Object.entries(parsed as Record<string, unknown>)) {
      const parsedQty = parseFiniteNumber(qty, "qty");
      if (parsedQty.ok) result[symbol] = parsedQty.value;
    }
    return result;
  } catch (err) {
    console.error("[reconciliation] Failed to read acknowledged baselines; treating as none (fail closed into visibility).", err);
    return {};
  }
}

// Stable signature of a mismatch set -- used to tell "the SAME mismatch is
// still present" (throttle to once per EMPTY_SYNC_ALERT_WINDOW_MS, reusing
// Task 1's throttle helper) apart from "a NEW/different mismatch just
// appeared" (alert immediately, per this task's binding rule), without
// persisting the full mismatch payload.
function fingerprintMismatches(mismatches: ReconciliationReport["mismatches"]): string {
  return mismatches
    .map((m) => `${m.type}:${m.symbol || ""}:${m.localId || ""}:${m.expected || ""}:${m.actual || ""}`)
    .sort()
    .join("|");
}

// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4, signal-source registry):
// config-failure alert state key -- same "no schema migration needed" app_state
// convention as the other alert-throttle keys above.
const SOURCE_REGISTRY_ALERT_STATE_KEY = "signal_source_registry_alert_state";

function fingerprintRegistryIssues(issues: SourceRegistryIssue[]): string {
  return issues
    .map((i) => `${i.scope}:${i.id || ""}:${i.message}`)
    .sort()
    .join("|");
}

// Throttled Telegram alert for a malformed signal-source registry (file or
// entry level) -- reuses Task 1's shouldSendThrottledAlert exactly the way
// the reconciliation-mismatch alert above does: a NEW/different set of
// issues always alerts immediately (fingerprint changed); the SAME issue set
// only re-alerts once EMPTY_SYNC_ALERT_WINDOW_MS has elapsed. Only a
// DELIVERED alert advances the stamp -- an undelivered attempt (Telegram
// unconfigured/down) must never suppress the next real alert, same
// fail-open-toward-alerting direction as every other alert-throttle in this
// file.
async function alertOnSourceRegistryIssues(config: AppConfig, issues: SourceRegistryIssue[]): Promise<void> {
  const fingerprint = fingerprintRegistryIssues(issues);
  let alertState: { fingerprint?: string; lastSentAt?: string } = {};
  try {
    const rawAlertState = productionStore.getAppState(SOURCE_REGISTRY_ALERT_STATE_KEY);
    if (rawAlertState) alertState = JSON.parse(rawAlertState);
  } catch {
    alertState = {};
  }
  const isNewOrDifferent = alertState.fingerprint !== fingerprint;
  const dueByThrottle = shouldSendThrottledAlert(alertState.lastSentAt, Date.now(), EMPTY_SYNC_ALERT_WINDOW_MS);
  if (!isNewOrDifferent && !dueByThrottle) return;

  const tgMsg = `⚠️ <b>Signal source registry validation failed.</b> ${issues.length} issue(s) -- the affected source(s) are disabled (fail closed), never guessed: ${issues.map((i) => i.message).join(" | ").slice(0, 2500)}`;
  const delivered = await sendTelegramAlert(config.telegram, tgMsg);
  if (delivered) {
    productionStore.setAppState(SOURCE_REGISTRY_ALERT_STATE_KEY, JSON.stringify({ fingerprint, lastSentAt: new Date().toISOString() }));
  }
}

async function executeTradeIntent(input: {
  config: AppConfig;
  request: TradeRequest;
  maxNotional?: number;
  // Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): the order chokepoint for
  // the market-hours gate. Set true only by a SCHEDULED cycle that found the
  // clock closed (or unreachable -- fail closed); manual syncs never set
  // this (human's call). When true, a BUY is rejected below with an honest
  // reason before any broker call is made -- same RiskRejected path every
  // other rejection already uses, so it is audited automatically. SELLs are
  // EXEMPT, per the plan's standing principle that de-risking always stays
  // available (the cooldown just below, the breaker's block_new_buys, and
  // the per-cycle BUY cap all already encode the same asymmetry):
  // risk-increasing orders fail closed on a closed/UNKNOWN market state, but
  // a risk-reducing order (stop-loss/exit-plan liquidation, automation SELL,
  // close-all) always proceeds. When the market is genuinely closed, Alpaca
  // queues the day market order for the open -- acceptable; when the clock
  // fetch merely failed transiently, protection proceeds immediately instead
  // of being suppressed by a broken clock.
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
    appendAuditEvents([
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
  // Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, cross-source
  // confirmation): additive risk input, same BUY-only shape as cooldownSymbols
  // just above -- de-risking (a SELL) must always stay available, and a
  // conflict is only ever meaningful for the bullish side's own trade intent
  // (see bearishMapping.ts's do-not-buy/thesis-invalidation machinery, which
  // this must never suppress). The sync decision loop is the only caller that
  // ever sets request.crossSourceConflict; every other call site leaves it
  // undefined, so this list is empty there.
  const crossSourceConflictSymbols =
    input.request.side === "buy" && input.request.crossSourceConflict ? [input.request.symbol] : [];
  // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, do-not-buy list): like
  // the cooldown just above, enforced HERE -- the shared order chokepoint --
  // so it guards EVERY buy path (sync automation, manual override), not just
  // the sync decision loop's own early check. BUY-only, same de-risking
  // asymmetry as the cooldown; a store read failure fails closed (the BUY is
  // rejected rather than proceeding as if no entries exist). The deliberate
  // escape hatch for a human who really wants the symbol is
  // DELETE /api/do-not-buy/:symbol (admin, audited) -- remove the entry
  // first; the check itself is never bypassed.
  let doNotBuyEntry: { symbol: string; sourceId: string; reason: string; expiresAt: string } | undefined;
  let doNotBuyLoadFailed = false;
  if (input.request.side === "buy") {
    try {
      doNotBuyEntry = productionStore.listActiveDoNotBuy(new Date().toISOString()).find((e) => e.symbol === input.request.symbol);
    } catch (err) {
      console.error("[do-not-buy] Failed to load the do-not-buy list; failing closed on buy order.", err);
      doNotBuyLoadFailed = true;
    }
  }
  // Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2, startup reconciliation):
  // the order chokepoint for boot safety. Computed BEFORE the tradability
  // network call below (same "don't spend a network call on an order that's
  // rejected either way" reasoning the market-hours gate already documents)
  // since this is the cheapest, most fundamental check -- until startup
  // reconciliation has completed at least once, this process does not yet
  // know the true state of its own open orders, so no new BUY may increase
  // exposure. Undefined for a sell -- see startupReconciliation.ts's
  // buyGateRejectionReason, which is always undefined for "sell".
  const reconciliationRejectionReason = buyGateRejectionReason(input.request.side);

  // Phase 2 Task 3: per-asset tradability guard (BUY only, fail closed on any
  // fetch/parse failure). Skipped when the broker isn't configured (simulated/
  // dry-run mode has no Alpaca asset endpoint to check against -- same
  // precedent as checkMarketOpenForScheduledCycle treating an unconfigured
  // broker as open), when the market-hours chokepoint has already rejected
  // this BUY, and when the startup-reconciliation gate above already has
  // (no need to spend a network call and cache slot on an order that
  // is rejected either way).
  let tradabilityRejectionReason: string | null = null;
  if (input.request.side === "buy" && brokerConfig.configured && !input.marketKnownClosed && !reconciliationRejectionReason) {
    const tradability = await checkAssetTradable(input.request.symbol, {
      baseUrl: brokerConfig.baseUrl,
      apiKey: brokerConfig.apiKey,
      secretKey: brokerConfig.secretKey,
    });
    if (!tradability.tradable) tradabilityRejectionReason = tradability.reason;
  }
  const riskDecision: RiskDecision = reconciliationRejectionReason
    ? { status: "rejected", reason: reconciliationRejectionReason }
    : input.marketKnownClosed && input.request.side === "buy"
    ? { status: "rejected", reason: "Market is closed (or clock state unknown); BUY blocked at the market-hours chokepoint. Risk-reducing sells are exempt." }
    : tradabilityRejectionReason
    ? { status: "rejected", reason: tradabilityRejectionReason }
    : cooldownLoadFailed
    ? { status: "rejected", reason: "Failed to load symbol cooldown state; failing closed on this buy order." }
    : doNotBuyLoadFailed
    ? { status: "rejected", reason: "Failed to load the do-not-buy list; failing closed on this buy order." }
    : doNotBuyEntry
    ? {
        status: "rejected",
        reason: `${input.request.symbol} is on the do-not-buy list until ${doNotBuyEntry.expiresAt} (source "${doNotBuyEntry.sourceId}": ${doNotBuyEntry.reason}). An admin can remove the entry via DELETE /api/do-not-buy/${input.request.symbol} to override.`,
      }
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
          dailyTradeCount: appStore.listTrades().filter((trade: any) => String(trade.timestamp || "").startsWith(new Date().toISOString().slice(0, 10))).length,
          openPositionCount: portfolioAssessment.positions.length,
          // Phase 2 Task 3 (PDT guard): threaded straight from the account
          // snapshot fetched above (portfolio.equity / portfolio.daytrade_count
          // -- the same fields already read into getAlpacaPortfolio's return
          // shape). The simulated/unconfigured-broker portfolio always reports
          // a healthy equity and daytrade_count 0, so the guard never fires
          // in dry-run mode.
          accountEquity: portfolio.equity,
          dayTradeCount: portfolio.daytrade_count,
        },
        limits: {
          maxDailyLoss: riskLimits.maxDailyLoss,
          maxDailyTradeCount: riskLimits.maxDailyTradeCount,
          maxOpenPositions: riskLimits.maxOpenPositions,
          minBuyingPower: riskLimits.minBuyingPower,
          cooldownSymbols,
          crossSourceConflictSymbols,
        },
      });
  // Task 4: placeAlpacaOrder reports bracket-specific protection-degradation
  // events (validation fail-open, 422-rejection retry) through this callback
  // rather than through submitTradeThroughPipeline's own audit() -- it has no
  // knowledge of the trade id/actor that owns this submission. Collected here
  // and turned into real AuditEvents (with the trade's final id/actor) below,
  // once `result` exists.
  const bracketNotes: Array<{ message: string; details?: Record<string, unknown> }> = [];
  const result = await submitTradeThroughPipeline({
    request: input.request,
    brokerConfig,
    riskDecision,
    exitPlan,
    brokerSubmit: (clientOrderId) =>
      placeAlpacaOrder(
        brokerConfig,
        input.request.symbol,
        riskDecision.adjustedQty || input.request.qty,
        input.request.side,
        clientOrderId,
        input.request.side === "buy" ? { entryEstimate: input.request.estimatedPrice, exitPlan } : undefined,
        (note) => bracketNotes.push(note),
      ),
  });

  // Task 13 (idempotent orders): if this exact intent (by client_order_id) was
  // already recorded locally -- e.g. a retry/double-submit that Alpaca's own
  // client_order_id dedup collapsed into the SAME broker order -- reuse that
  // earlier local trade's id so saveTradeIntent below overwrites it in place
  // instead of inserting a second local record for one broker order.
  //
  // Gated on BROKER_REACHED_TRADE_STATUSES (Task 5): only an attempt that
  // itself reached the broker is a genuine resubmission of "the same order"
  // deriveClientOrderId's content hash is meant to reconcile. A RiskRejected
  // attempt never left this process (e.g. blocked by the symbol cooldown) --
  // it is NOT the same broker order as an earlier successful attempt that
  // happens to share the same content hash, and repointing/overwriting the
  // earlier trade's row with this one's data would silently clobber a live
  // position's trade record (its brokerOrderId, bracket leg ids, and status)
  // with a rejected attempt's. Task 5 now reads trade_intents.status as the
  // live source of truth for "is this still the open lot's entry order"
  // (latestBuySideExitPlanForSymbol, persistence.ts) and reads/writes whole
  // trade rows by id (getTradeIntentById) -- both depend on this row never
  // being clobbered by an unrelated, never-reached-the-broker attempt.
  if (result.trade.clientOrderId && BROKER_REACHED_TRADE_STATUSES.has(result.trade.status)) {
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

  // Task 4: attach the collected bracket notes as real audit events, entityId
  // now resolved to this trade's FINAL id (post dedup re-pointing above).
  for (const note of bracketNotes) {
    result.auditEvents.push({
      id: `ae-bracket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type: "broker",
      actor: input.request.actor || input.request.source,
      entityId: result.trade.id,
      message: note.message,
      details: note.details,
    });
  }

  appendAuditEvents(result.auditEvents);
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
// "admin_api" or "telegram:<userId>") and is responsible for NOT already
// holding appStore's lock -- this acquires it itself (broker calls must not
// happen while already holding the lock; see handleTelegramCommand's
// read-only-reply comment below).
async function performBreakerReset(actor: string): Promise<{ status: BreakerState["status"]; reTripped: boolean }> {
  const release = await appStore.acquire();
  try {
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
    appendAuditEvents([auditEvent]);
    return { status: latchResult.effective.status, reTripped };
  } finally {
    release();
  }
}

// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): the Anthropic SDK manages
// its own transport (it does not go through fetchWithTimeout above), so the
// bounded-timeout requirement is met via the client's own `timeout` option
// instead. The SDK's default is 10 MINUTES, meant for very long-running
// completions -- far too long to be a useful bound for a sync cycle that
// must still complete promptly. 30s balances that against thesis-analysis
// calls that may use the web-search tool (slower than a bare completion).
// maxRetries is left at the SDK default (2, with backoff) -- these calls are
// pure reads of a stateless LLM response, not order placement, so retrying
// carries none of the double-fire risk fetchWithTimeout's GET-only policy
// guards against.
const ANTHROPIC_CLIENT_TIMEOUT_MS = 30_000;

// Global Claude client. Both call sites in /api/sync run inside try/catch
// blocks; a missing ANTHROPIC_API_KEY or a failed call is treated as a hard
// failure of that source -- it contributes zero scan-targets/signals rather
// than falling back to simulated analysis (see scanTargetAssembly.ts).
const getClaudeClient = () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("No ANTHROPIC_API_KEY environment variable found. Claude calls will fail.");
  }
  return new Anthropic({ apiKey, timeout: ANTHROPIC_CLIENT_TIMEOUT_MS });
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
    return appStore.getSimulatedPortfolio();
  }

  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };

  try {
    const acctRes = await fetchWithTimeout(`${brokerConfig.baseUrl}/account`, { headers });
    if (!acctRes.ok) throw new Error(`Alpaca Accounts API responded with ${acctRes.status}`);
    const account = await acctRes.json();

    const posRes = await fetchWithTimeout(`${brokerConfig.baseUrl}/positions`, { headers });
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

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3): a dedicated account+positions
// fetch for position reconciliation ONLY -- deliberately NOT getAlpacaPortfolio
// above, whose positions fetch silently degrades to an empty array on a non-OK
// response (`posRes.ok ? await posRes.json() : []`, line ~711). That silent-empty
// behavior is safe everywhere ELSE it's used (a degraded/empty portfolio view is
// honest enough for e.g. the dashboard or sizing math to treat conservatively),
// but for THIS gate it would be actively dangerous: an empty positions list
// would look exactly like "every expected position was manually closed",
// fabricating a `missing_position` mismatch for every open lot on a transient
// Alpaca outage -- precisely the false-positive-drift failure mode this task's
// binding rule ("absence of data is never drift") exists to prevent. This
// helper instead fails closed (`ok: false`) on ANY non-OK/malformed response
// from either endpoint, so the caller can skip the comparison entirely rather
// than trust a partial read.
async function fetchAccountAndPositionsForReconciliation(
  brokerConfig: BrokerConfig,
): Promise<{ ok: true; account: any; positions: AlpacaPosition[] } | { ok: false; errorMessage: string }> {
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };
  try {
    const acctRes = await fetchWithTimeout(`${brokerConfig.baseUrl}/account`, { headers });
    if (!acctRes.ok) return { ok: false, errorMessage: `GET /account responded with ${acctRes.status}` };
    const account = await acctRes.json();

    const posRes = await fetchWithTimeout(`${brokerConfig.baseUrl}/positions`, { headers });
    if (!posRes.ok) return { ok: false, errorMessage: `GET /positions responded with ${posRes.status}` };
    const rawPositions = await posRes.json();
    if (!Array.isArray(rawPositions)) return { ok: false, errorMessage: "GET /positions did not return an array" };

    return {
      ok: true,
      account: {
        cash: account.cash,
        buying_power: account.buying_power,
        portfolio_value: account.portfolio_value,
        equity: account.equity,
        last_equity: account.last_equity,
        long_market_value: account.long_market_value,
        daytrade_count: account.daytrade_count,
      },
      positions: rawPositions.map((p: any) => ({
        symbol: p.symbol,
        qty: p.qty,
        market_value: p.market_value,
        cost_basis: p.cost_basis,
        unrealized_pl: p.unrealized_pl,
        unrealized_plpc: p.unrealized_plpc,
        current_price: p.current_price,
        avg_entry_price: p.avg_entry_price,
      })),
    };
  } catch (err: any) {
    return { ok: false, errorMessage: err?.message || String(err) };
  }
}

async function getAlpacaOpenOrders(brokerConfig: BrokerConfig = getBrokerConfig()) {
  if (!brokerConfig.configured) return [];
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };
  const res = await fetchWithTimeout(`${brokerConfig.baseUrl}/orders?status=open`, { headers });
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
    const res = await fetchWithTimeout(`${brokerConfig.baseUrl}/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[client_order_id] Failed to fetch the existing order after a duplicate client_order_id rejection.", err);
    return null;
  }
}

// Task 4 (broker-native bracket orders): does an Alpaca error response
// indicate the REJECTION was about the bracket shape of the order itself
// (order_class/take_profit/stop_loss), as opposed to some unrelated
// rejection (insufficient buying power, bad symbol, market closed, etc.)?
// Matched narrowly (422 + wording) so an unrelated 422 isn't misclassified
// as "safe to retry as a plain order" -- see submitTradeThroughPipeline's
// "non-bracket failures keep existing behavior" requirement.
function isBracketOrderRejection(status: number, bodyText: string): boolean {
  if (status !== 422) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("bracket") || lower.includes("order_class");
}

// Task 4: cancels one open broker order (used to clear a position's live
// bracket legs before the software exit monitor submits a liquidation sell --
// see the MODULE 2 call site). Never throws: any failure (network error, a
// non-2xx status other than "already gone") resolves to `{ ok: false }` so
// the caller can fail closed (skip the software exit this cycle) instead of
// risking a sell that Alpaca rejects because the shares are still held by an
// open bracket leg. A 404 (the order already filled/was already canceled --
// nothing left to cancel) is treated as success: there is no live leg left
// to conflict with the sell.
async function cancelAlpacaOrder(brokerConfig: BrokerConfig, orderId: string): Promise<{ ok: boolean; status?: number }> {
  if (!brokerConfig.configured) return { ok: true };
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };
  try {
    const res = await fetchWithTimeout(`${brokerConfig.baseUrl}/orders/${encodeURIComponent(orderId)}`, { method: "DELETE", headers });
    if (res.ok || res.status === 404) return { ok: true, status: res.status };
    return { ok: false, status: res.status };
  } catch (err) {
    console.error(`[bracket-cancel] DELETE /orders/${orderId} failed.`, err);
    return { ok: false };
  }
}

// Task 4 (docs/GO_LIVE_PLAN.md Phase 2.2): the ONE shared cancel-legs-before-
// sell step used by every sell call site -- the software exit monitor
// (MODULE 2), the emergency close-all endpoint, and manual override sells --
// so the bracket interaction can never drift between them. A position whose
// BUY was placed as a broker-native bracket has live take_profit/stop_loss
// child orders holding its shares; a plain sell submitted while they're open
// is rejected by Alpaca ("insufficient qty -- held for orders"). So: look up
// the symbol's persisted leg ids and cancel each via DELETE /v2/orders/{id}
// BEFORE the sell.
//
// Fail CLOSED, always audited: if the leg lookup throws or any cancel fails,
// returns `ok: false` and the caller must SKIP the sell -- the broker legs
// are that position's only protection at that moment, and a sell that Alpaca
// would reject anyway must not be reported as a successful liquidation. Both
// failure modes append an audit event here (not in the callers) so the
// disclosure can't be forgotten at a call site. No legs recorded (a plain
// order, a pre-existing position, or an unconfigured/dry-run broker) is a
// no-op success: the sell proceeds exactly as it did before Task 4.
//
// Task 5 (order-status polling) closes two bracket-orders review findings:
// 1. The leg lookup now comes from latestBuySideExitPlanForSymbol's
//    status-filtered query (persistence.ts) -- see that method's doc comment.
// 2. A leg already known terminal (poller previously recorded it in
//    brokerLegStates) is SKIPPED, not DELETE-d -- and a 422 "not cancelable"
//    on a leg still believed live is re-polled ONCE before failing closed: if
//    the re-poll shows the leg is actually terminal already, the sell
//    proceeds (nothing left to cancel); if it's still live (or the re-poll
//    itself fails), this fails closed exactly as before Task 5.
async function cancelBracketLegsBeforeSell(input: {
  symbol: string;
  // For the audit trail: which sell path is asking (e.g. "exit_monitor",
  // "emergency_close", "manual_override").
  actor: string;
}): Promise<{ ok: boolean; canceledCount: number; reason: string }> {
  const brokerConfig = getBrokerConfig();
  if (!brokerConfig.configured) return { ok: true, canceledCount: 0, reason: "" };

  const auditNote = (message: string, details: Record<string, unknown>) => {
    appendAuditEvents([{
      id: `ae-bracket-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type: "broker",
      actor: input.actor,
      message,
      details,
    }]);
  };

  let legOrderIds: string[] = [];
  let legStates: Record<string, TradeState> = {};
  let entryTradeId: string | undefined;
  try {
    const record = productionStore.latestBuySideExitPlanForSymbol(input.symbol);
    legOrderIds = record?.legOrderIds || [];
    legStates = record?.legStates || {};
    entryTradeId = record?.tradeId;
  } catch (err: any) {
    const reason = `failed to look up bracket legs for ${input.symbol} (${err?.message || String(err)})`;
    console.error(`[bracket-cancel] ${reason}; skipping this sell.`, err);
    auditNote(
      `Failed to look up bracket legs for ${input.symbol} before a sell; the sell was SKIPPED. The position may still be covered by broker-native bracket legs.`,
      { symbol: input.symbol, error: err?.message || String(err) },
    );
    return { ok: false, canceledCount: 0, reason };
  }

  let canceledCount = 0;
  for (const legId of legOrderIds) {
    if (isTerminalTradeState(legStates[legId])) {
      // Finding 2: already known terminal from a prior poll -- nothing to
      // cancel, and DELETE-ing it would only ever come back "not cancelable".
      continue;
    }

    const cancelResult = await cancelAlpacaOrder(brokerConfig, legId);
    if (cancelResult.ok) {
      canceledCount++;
      // Record this leg as Canceled now that we know it for certain -- a
      // successful DELETE is at least as strong evidence of terminal state as
      // a poll, and recording it here (not waiting for the next poll cycle)
      // keeps it out of the poller's candidate set going forward instead of
      // leaving it "not known terminal" indefinitely.
      if (entryTradeId) {
        try {
          const entryTrade = productionStore.getTradeIntentById(entryTradeId);
          if (entryTrade) {
            productionStore.saveTradeIntent({
              ...entryTrade,
              brokerLegStates: { ...(entryTrade.brokerLegStates || {}), [legId]: "Canceled" },
            });
          }
        } catch (saveErr: any) {
          console.error(`[bracket-cancel] Failed to persist canceled-leg state for ${legId} (${input.symbol}).`, saveErr);
        }
      }
      continue;
    }

    if (cancelResult.status === 422 && entryTradeId) {
      // Finding 2: the broker is telling us this leg can't be canceled --
      // most likely because it already went terminal (filled, or
      // OCO-canceled by its sibling leg filling) since we last polled it.
      // Re-poll ONCE to find out, rather than assuming either way.
      const poll = await fetchBrokerOrder({ brokerConfig, orderId: legId, fetchImpl: fetch });
      if (poll.ok) {
        const entryTrade = productionStore.getTradeIntentById(entryTradeId);
        if (entryTrade) {
          const outcome = applyLegPollResult(entryTrade, legId, poll, () => new Date());
          try {
            productionStore.saveTradeIntent(outcome.trade);
            // Bracket-orders review finding C1: this re-poll path can ALSO be
            // the first time a leg's fill is discovered (not just MODULE 1.5's
            // regular poll) -- persist the synthetic SELL ledger entry here
            // too, or a fill only ever surfaced via this 422-retry path would
            // poison computeExpectedPositions exactly like the original bug.
            if (outcome.syntheticSellTrade) {
              productionStore.saveTradeIntent(outcome.syntheticSellTrade);
            }
          } catch (saveErr: any) {
            console.error(`[bracket-cancel] Failed to persist re-polled leg state for ${legId} (${input.symbol}).`, saveErr);
          }
          if (outcome.auditEvents.length) {
            appendAuditEvents(outcome.auditEvents.map((event) => ({
              id: `ae-bracket-repoll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: new Date().toISOString(),
              actor: input.actor,
              ...event,
            })));
          }
          if (outcome.becameTerminal) {
            auditNote(
              `Bracket leg ${legId} for ${input.symbol} was already terminal at the broker (confirmed by re-polling after a 422 "not cancelable" response); proceeding with the sell without a DELETE.`,
              { symbol: input.symbol, legId, legState: outcome.legMappedState },
            );
            continue;
          }
        }
      }
    }

    // Still live (or the re-poll failed/wasn't applicable) -- fail closed,
    // same as before Task 5.
    const reason = `failed to cancel bracket leg ${legId} for ${input.symbol}${cancelResult.status ? ` (broker status ${cancelResult.status})` : ""}`;
    auditNote(
      `Failed to cancel bracket leg ${legId} for ${input.symbol} before a sell; the sell was SKIPPED. The position remains protected by its broker-native bracket legs.`,
      { symbol: input.symbol, legId, status: cancelResult.status },
    );
    return { ok: false, canceledCount, reason };
  }
  return { ok: true, canceledCount, reason: "" };
}

// Task 4 (docs/GO_LIVE_PLAN.md Phase 2.2): submits a BUY as a broker-native
// bracket order (order_class "bracket", carrying the exit plan's stop-loss
// and take-profit) so protection survives process death, instead of relying
// solely on the software exit monitor. `bracketContext` is only ever passed
// for BUY intents (see executeTradeIntent below) -- SELL/liquidation orders
// always stay plain (requirement 3: closing, not opening, positions).
//
// Fail-open policy (never blocks the entry, always discloses a protection
// degradation via `onBracketEvent`):
//   - bracket validation failure (degenerate/inverted plan, non-finite
//     prices) -> falls back to a single plain order, never touching the
//     broker with a bracket at all.
//   - bracket REJECTED by Alpaca (422 naming bracket/order_class) -> retries
//     ONCE as a plain order under a DIFFERENT client_order_id (`-p` suffix --
//     this is a genuinely different order, not a resubmission of the same
//     one, so it must not collide with Task 13's client_order_id dedup).
//   - any other broker failure (bad symbol, insufficient buying power, a
//     genuine duplicate client_order_id, ...) keeps existing behavior
//     unchanged -- no bracket-specific handling kicks in.
async function placeAlpacaOrder(
  brokerConfig: BrokerConfig,
  symbol: string,
  qty: number,
  side: "buy" | "sell",
  clientOrderId: string,
  bracketContext?: { entryEstimate: number; exitPlan?: ExitPlan },
  onBracketEvent?: (event: { message: string; details?: Record<string, unknown> }) => void,
) {
  let bracketLegs: { takeProfitLimitPrice: number; stopLossStopPrice: number } | null = null;
  if (side === "buy" && bracketContext?.exitPlan) {
    const validated = buildBracketLegs({
      side,
      entryEstimate: bracketContext.entryEstimate,
      stopLossPrice: bracketContext.exitPlan.initialStopLossPrice,
      takeProfitPrice: bracketContext.exitPlan.takeProfitPrice,
    });
    if (validated.ok) {
      bracketLegs = validated.legs;
    } else {
      onBracketEvent?.({
        message: `Bracket order not used for ${symbol}: ${validated.reason} Falling back to a plain market order; protection is software-only (exit monitor) for this position.`,
        details: { symbol, reason: validated.reason },
      });
    }
  }

  if (!brokerConfig.configured) {
    // Task 13: the dry-run path also carries the id, for consistency with the
    // live path's response shape (and so tests/callers can assert on it
    // uniformly regardless of whether a broker is configured).
    const base = { id: "dry-run-" + Date.now(), qty: String(qty), status: "accepted", client_order_id: clientOrderId };
    if (!bracketLegs) return base;
    // Requirement 6: mirror the bracket structure (including a `legs` array)
    // in the dry-run fake response, for test fidelity with the live path.
    return {
      ...base,
      order_class: "bracket",
      legs: [
        { id: `${base.id}-leg-tp`, type: "limit", limit_price: String(bracketLegs.takeProfitLimitPrice) },
        { id: `${base.id}-leg-sl`, type: "stop", stop_price: String(bracketLegs.stopLossStopPrice) },
      ],
    };
  }

  if (brokerConfig.tradingMode === "live" && !brokerConfig.liveTradingEnabled) {
    throw new Error("Live trading is blocked unless LIVE_TRADING_ENABLED=true.");
  }

  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };

  const submit = (id: string, useBracket: boolean) => {
    const body: Record<string, unknown> = {
      symbol,
      qty: String(qty),
      side,
      type: "market",
      client_order_id: id,
    };
    if (useBracket && bracketLegs) {
      // Alpaca requires the bracket's entry order and both child legs to
      // share ONE time_in_force. "gtc" (not the plain-order default "day")
      // is used for the WHOLE bracket so the legs survive overnight -- the
      // one disclosed behavior change from the pre-Task-4 plain day order
      // (see bracketOrders.ts's BRACKET_TIME_IN_FORCE doc comment).
      body.time_in_force = BRACKET_TIME_IN_FORCE;
      body.order_class = "bracket";
      body.take_profit = { limit_price: String(bracketLegs.takeProfitLimitPrice) };
      body.stop_loss = { stop_price: String(bracketLegs.stopLossStopPrice) };
    } else {
      body.time_in_force = PLAIN_TIME_IN_FORCE;
    }
    // POST -- bounded timeout, NEVER retried (order submission must not
    // double-fire; client_order_id dedup above is defense in depth, not
    // relied upon here).
    return fetchWithTimeout(`${brokerConfig.baseUrl}/orders`, { method: "POST", headers, body: JSON.stringify(body) });
  };

  const attemptedBracket = Boolean(bracketLegs);
  const orderRes = await submit(clientOrderId, attemptedBracket);

  if (!orderRes.ok) {
    const errTxt = await orderRes.text();

    if (attemptedBracket && isBracketOrderRejection(orderRes.status, errTxt)) {
      const retryClientOrderId = `${clientOrderId}-p`;
      onBracketEvent?.({
        message: `Bracket order for ${symbol} was rejected by Alpaca (status ${orderRes.status}); retrying as a plain market order (client_order_id ${retryClientOrderId}) -- this is a DIFFERENT order from the rejected bracket. Protection is software-only (exit monitor) for this position.`,
        details: { symbol, status: orderRes.status, brokerResponse: errTxt, rejectedClientOrderId: clientOrderId, retryClientOrderId },
      });
      const retryRes = await submit(retryClientOrderId, false);
      if (!retryRes.ok) {
        const retryErrTxt = await retryRes.text();
        onBracketEvent?.({
          message: `Plain-order retry for ${symbol} after a bracket rejection also failed.`,
          details: { symbol, status: retryRes.status, brokerResponse: retryErrTxt, clientOrderId: retryClientOrderId },
        });
        if (isDuplicateClientOrderIdError(retryRes.status, retryErrTxt)) {
          const existing = await fetchExistingAlpacaOrderByClientOrderId(brokerConfig, retryClientOrderId);
          if (existing) return existing;
        }
        throw new Error(`Alpaca order rejected: ${retryErrTxt}`);
      }
      const retryOrder = await retryRes.json();
      onBracketEvent?.({
        message: `Plain-order retry for ${symbol} (client_order_id ${retryClientOrderId}) succeeded after the bracket order was rejected.`,
        details: { symbol, clientOrderId: retryClientOrderId, brokerOrderId: (retryOrder as { id?: string })?.id },
      });
      return retryOrder;
    }

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
    const res = await fetchWithTimeout(`${brokerConfig.baseUrl}/clock`, { headers });
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
    // POST -- bounded timeout, never retried (a retried send could double-post
    // the same alert to the chat).
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
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
    // POST -- bounded timeout, never retried (same double-post concern as
    // sendTelegramAlert above).
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
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

  const release = await appStore.acquire();
  try {
    const auditEvent: AuditEvent = {
      id: `tg-${update.update_id || Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "telegram",
      actor: userId,
      message: `Telegram command ${command} ${auth.allowed ? "accepted" : "rejected"}`,
      details: { command, chatId, auth },
    };
    appendAuditEvents([auditEvent]);

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
      const config = appStore.getConfig();
      appStore.setConfig({ ...config, system: { ...config.system, autoTrading: false } });
      outbound.push("Auto trading paused. New buys are blocked.");
    } else if (command === "/resume") {
      const config = appStore.getConfig();
      appStore.setConfig({ ...config, system: { ...config.system, autoTrading: true } });
      outbound.push("Auto trading resumed subject to risk checks.");
    } else {
      needsReadOnlyReply = true;
    }
  } finally {
    release();
  }

  if (confirmedBreakerReset) {
    // Admin reset path 2 of 2 (Task 10). Runs after the lock above is released;
    // performBreakerReset re-acquires appStore's lock itself around the actual state change.
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
      // GET, bounded timeout + 1 retry (fetchWithTimeout's default policy).
      // The URL's own `timeout=10` is Telegram's long-poll hold time (it may
      // legitimately keep the connection open up to 10s waiting for updates);
      // our client-side timeout is set a bit longer (15s) than that so a
      // normal long-poll response is never mistaken for a hang. A timeout (or
      // any other failure) is caught below and logged -- the setInterval
      // keeps ticking either way (Task 13: timeouts must never kill the poll
      // loop).
      const res = await fetchWithTimeout(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=10&offset=${offset}`,
        {},
        15_000,
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const update of data.result || []) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        await handleTelegramCommand(update);
      }
    } catch (err) {
      console.error("Telegram polling failed (timeout tolerated silently; the poll loop keeps running):", err);
    }
  }, 5000);
}

// 3. Google Sheets Export Helper
async function appendTradeToSheets(config: AppConfig["google"], authHeader: string | null, trade: Trade) {
  if (!config || !config.enabled || !config.spreadsheetId || !authHeader) return false;
  try {
    // POST -- bounded timeout, never retried (fetchWithTimeout's non-GET
    // policy; a retry could append the same trade row twice). Task 13 review
    // expansion: this export call previously had no timeout and could hang a
    // sync cycle indefinitely.
    const res = await fetchWithTimeout(
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
    // POST -- bounded timeout, never retried (a retry could create a
    // duplicate Notion page). Same Task 13 review expansion as
    // appendTradeToSheets above.
    const res = await fetchWithTimeout(`https://api.notion.com/v1/pages`, {
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
app.get("/api/config", requireReadToken, (req, res) => {
  res.json(redactConfigForClient(appStore.getConfig()));
});

app.post("/api/config", requireAdminCommand, async (req, res) => {
  try {
    const config = await appStore.updateConfig((current) => stripPersistedSecrets({ ...current, ...req.body }) as AppConfig);
    res.json({ success: true, config: redactConfigForClient(config) });
  } catch (error) {
    console.error("Config update failed:", error);
    res.status(500).json({ error: "Failed to update configuration." });
  }
});

// Logs, Trades, Analyses
app.get("/api/analyses", requireReadToken, (req, res) => {
  res.json(appStore.listAnalyses());
});

app.get("/api/trades", requireReadToken, (req, res) => {
  res.json(appStore.listTrades());
});

app.get("/api/logs", requireReadToken, (req, res) => {
  res.json(appStore.getLogs());
});

app.get("/api/audit", requireReadToken, (req, res) => {
  // Phase 2 Task 14: the legacy db.json `auditEvents` fallback is gone --
  // productionStore.appendAuditEvents was already called unconditionally on
  // every appendAuditEvents(...) call site, so SQLite's audit_events table
  // was always a full mirror (see appendAuditEvents's doc comment above).
  res.json(productionStore.listAuditEvents());
});

app.get("/api/regime/latest", requireReadToken, (req, res) => {
  const latest = productionStore.latestRegimeAssessment();
  if (latest) {
    res.json(latest);
    return;
  }
  const conservative = detectRegime({});
  productionStore.saveRegimeAssessment(conservative);
  res.json(conservative);
});

app.get("/api/breaker/latest", requireReadToken, (req, res) => {
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

app.get("/api/portfolio/assessment", requireReadToken, async (req, res) => {
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

app.get("/api/signals/reviewed", requireReadToken, (req, res) => {
  const persisted = productionStore.listReviewedSignals();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json(appStore.listAnalyses().map((analysis: StockAnalysis) => ({
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

app.get("/api/trade-intents", requireReadToken, (req, res) => {
  const persisted = productionStore.listTradeIntents();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json(appStore.listTrades().map((trade: any) => ({
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

app.get("/api/risk-decisions", requireReadToken, (req, res) => {
  const persisted = productionStore.listRiskDecisions();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json(appStore.listTrades().filter((trade: any) => trade.riskDecision).map((trade: any) => ({
    tradeId: trade.id,
    symbol: trade.symbol,
    ...trade.riskDecision,
  })));
});

app.get("/api/exit-plans", requireReadToken, (req, res) => {
  const persisted = productionStore.listExitPlans();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json(appStore.listTrades().filter((trade: any) => trade.exitPlan).map((trade: any) => ({
    tradeId: trade.id,
    symbol: trade.symbol,
    ...trade.exitPlan,
  })));
});

// Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
// Burry Substack): admin visibility into the do-not-buy list (item 4 of the
// task brief). Unauthenticated read, same pattern as the other GET list
// endpoints above (/api/exit-plans, /api/risk-decisions, /api/audit) -- a
// read-only view of internal risk state, no admin token required. Expired
// entries are already filtered by the store's listActiveDoNotBuy (fail-
// closed to an empty list on a store read error, matching every other
// fallible store read in this file).
app.get("/api/do-not-buy", requireReadToken, (req, res) => {
  try {
    res.json(productionStore.listActiveDoNotBuy(new Date().toISOString()));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read the do-not-buy list", details: err?.message || String(err) });
  }
});

// Phase 2 Task 10 (review fix 1): the deliberate admin escape hatch for the
// do-not-buy chokepoint in executeTradeIntent. A human who genuinely wants
// to buy an avoided symbol removes its entry here first (audited); the
// chokepoint check itself is never bypassed. Idempotent: deleting a symbol
// with no entry is a 200 with removed: false.
app.delete("/api/do-not-buy/:symbol", requireAdminCommand, (req, res) => {
  const symbol = String(req.params.symbol || "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "A non-empty symbol is required." });
    return;
  }
  try {
    const removed = productionStore.deleteDoNotBuy(symbol);
    if (removed) {
      productionStore.appendAuditEvents([
        {
          id: `ae-donotbuy-remove-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          type: "risk",
          actor: "admin_api",
          entityId: symbol,
          message: `Admin removed ${symbol} from the do-not-buy list; BUY orders for it are no longer blocked by this entry.`,
          details: { symbol },
        },
      ]);
    }
    res.json({ success: true, symbol, removed });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove the do-not-buy entry", details: err?.message || String(err) });
  }
});

app.get("/api/reconciliation/latest", requireReadToken, (req, res) => {
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

// Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation's
// orphan sweep never auto-cancels an unmatched open broker order -- it might
// be a legitimate manual order a human placed directly, and canceling
// something a human is relying on would be its own incident. Instead new
// BUYs stay blocked (sells are unaffected) while ANY orphan is unresolved.
// This route is how a human resolves that block after reviewing the orphan
// list (GET /api/reconciliation/latest does not carry it; read it via
// productionStore's app_state key if needed, or trust the Telegram alert this
// module sends when an orphan is first found). Clearing is explicitly a
// "trust" operation, not a "fix" operation: it does NOT cancel, modify, or
// otherwise touch the underlying broker order(s) -- they are left exactly as
// they were. If the same order is still open and still unmatched at the next
// boot (or next scheduled reconciliation, once that exists), it will be
// flagged again.
app.post("/api/reconciliation/orphans/clear", requireAdminCommand, async (req, res) => {
  const clearedOrphans = clearOrphans();
  try {
    productionStore.setAppState(STARTUP_ORPHANS_APP_STATE_KEY, JSON.stringify([]));
    productionStore.appendAuditEvents([
      {
        id: `ae-orphans-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: "broker",
        actor: "admin_api",
        message: `Admin cleared ${clearedOrphans.length} orphan broker order(s) after review; BUY orders unblocked. The underlying broker order(s) were NOT canceled.`,
        details: { clearedCount: clearedOrphans.length, clearedOrphanIds: clearedOrphans.map((o) => o.id) },
      },
    ]);
  } catch (err) {
    console.error("[reconciliation] Failed to persist the cleared orphan list; the in-memory BUY gate is unblocked regardless.", err);
  }
  res.json({ cleared: clearedOrphans.length, orphans: clearedOrphans });
});

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3, "known-drift acceptance"):
// records the accepted qty for a symbol MODULE 1.6's position reconciliation
// would otherwise keep re-flagging as unexpected_position/quantity_drift/
// missing_position -- e.g. the operator's own manually-held SGOV, which this
// system never traded. Does NOT touch the breaker latch itself (it is
// sticky/human-reset-only, per this task's brief); the very next comparison
// simply computes a clean expected position for this symbol going forward,
// so if this was the ONLY mismatch, an admin still needs POST
// /api/breaker/reset to clear the already-latched block_new_buys (or it
// clears on the following cycle's re-evaluation once genuinely clean and the
// admin resets). Each call SETS (overwrites, does not add to) the baseline
// for `symbol` -- calling it again with a corrected qty is how an admin fixes
// a mistaken acknowledgment.
app.post("/api/reconciliation/acknowledge", requireAdminCommand, async (req, res) => {
  const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim() : "";
  if (!symbol) {
    res.status(400).json({ error: "Reconciliation acknowledge rejected", details: `Request field "symbol" must be a non-empty string.` });
    return;
  }
  const qtyParsed = parseFiniteNumber(req.body?.qty, "qty");
  if (!qtyParsed.ok) {
    res.status(400).json({ error: "Reconciliation acknowledge rejected", details: `Request field "qty" must be a finite number.` });
    return;
  }
  const qty = qtyParsed.value;
  try {
    const baselines = readAcknowledgedBaselines();
    baselines[symbol] = qty;
    productionStore.setAppState(RECONCILIATION_ACKNOWLEDGED_BASELINES_APP_STATE_KEY, JSON.stringify(baselines));
    productionStore.appendAuditEvents([
      {
        id: `ae-reconciliation-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: "broker",
        actor: "admin_api",
        message: `Admin acknowledged a baseline position of ${qty} share(s) for ${symbol}; future reconciliation comparisons will include it in the expected position.`,
        details: { symbol, qty },
      },
    ]);
    res.json({ success: true, symbol, qty, baselines });
  } catch (err: any) {
    console.error("[reconciliation] Failed to persist an acknowledged baseline:", err);
    res.status(500).json({ error: "Reconciliation acknowledge failed", details: err.message });
  }
});

app.get("/api/telegram/status", requireReadToken, (req, res) => {
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
    // Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation
    // visibility -- lets an operator (or a test) see the BUY gate's state
    // without reaching into app_state/SQLite directly.
    startupReconciliation: {
      tradingReady: isTradingReady(),
      orphanCount: getOrphanOrders().length,
      hasUnresolvedOrphans: hasUnresolvedOrphans(),
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

app.get("/api/portfolio", requireReadToken, async (req, res) => {
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
  const release = await appStore.acquire();
  try {
    const logs: SyncLog[] = [];
    const results: any[] = [];

    const timestamp = new Date().toISOString();
    const logId = () => "l-" + Math.random().toString(36).substr(2, 9);

    // Initialize helper to write log lines. Phase 2 Task 14: persists
    // immediately (appStore.addLog) instead of staging into an in-memory
    // db.json object for one big batched write at the end of the cycle --
    // every log line this function has EVER written is now durable the
    // moment it's written, not just if the whole cycle reaches its final
    // batched write without crashing first.
    const addLog = (type: SyncLog["type"], msg: string, details?: string) => {
      const sl: SyncLog = { id: logId(), timestamp: new Date().toISOString(), type, message: msg, details, trigger };
      appStore.addLog(sl);
      logs.push(sl);
    };

    const currentConfig: AppConfig = appStore.getConfig();
    // Phase 2 Task 14: read once, mutated in place at each simulated-fill
    // point below (mirrors the old db.simulatedPortfolio's shared-mutable-
    // object pattern so multiple trades within ONE cycle keep compounding
    // against each other), persisted via appStore.setSimulatedPortfolio(...)
    // immediately after each mutation point rather than in one final batch.
    const simulatedPortfolio: SimulatedPortfolio = appStore.getSimulatedPortfolio();

    addLog("sync", "Starting automation loop & thesis scanner...");
    appendAuditEvents([{
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

    const pendingTrades = appStore.listTrades().filter((tr: any) =>
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
          // Phase 2 Task 14: persist this trade's (possibly) updated outbox
          // flags immediately -- appendTrade upserts by id (same "in place"
          // semantics the old db.trades array mutation + one final batched
          // write used to rely on).
          appStore.appendTrade(tr);
        } catch (queueErr: any) {
          console.error("Failed handling outbox element retry:", queueErr.message);
        }
      }
    }

    // ==========================================================
    // MODULE 1.5: ORDER-STATUS POLLING (Phase 2 Task 5,
    // docs/GO_LIVE_PLAN.md Phase 2.2)
    // Polls every locally non-terminal trade's own order AND every
    // not-yet-known-terminal bracket leg against the broker (bounded, oldest
    // first -- see src/server/orderStatusPoller.ts), updating local state
    // through the existing mapBrokerStatusToTradeState mapping. Runs
    // unconditionally (not gated on autoTrading, and NOT skipped on a
    // reduced/market-closed cycle -- unlike the Claude-driven analysis loop
    // further down) because order-status truth matters every cycle: a
    // position's bracket legs can fill or a partial fill can go stale
    // whether or not this cycle places any new trades. Gated only on the
    // broker actually being configured (pollPendingOrders no-ops otherwise,
    // same convention as every other Alpaca-calling module in this file).
    // Runs BEFORE MODULE 2 so that same cycle's exit evaluation and bracket
    // leg cancellation see the freshest known state.
    // ==========================================================
    try {
      const brokerConfig = getBrokerConfig();
      if (brokerConfig.configured) {
        // Bounded window of recent trades to consider as poll candidates.
        // selectPollTargets itself re-sorts and caps to
        // MAX_ORDERS_PER_POLL_CYCLE, oldest first, so this window only needs
        // to be generous enough to contain every currently-open order; 250
        // matches every other unbounded listTradeIntents call in this file.
        const candidateTrades = productionStore.listTradeIntents(250);
        const pollResult = await pollPendingOrders({
          trades: candidateTrades,
          brokerConfig,
          fetchImpl: fetch,
          cancelOrder: (orderId) => cancelAlpacaOrder(brokerConfig, orderId),
          saveTrade: (trade) => productionStore.saveTradeIntent(trade),
        });
        for (const line of pollResult.logs) addLog("sync", line);
        for (const line of pollResult.errorLogs) addLog("error", line);
        if (pollResult.auditEvents.length) {
          appendAuditEvents(pollResult.auditEvents.map((event) => ({
            id: `ae-poll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            actor: "order_status_poller",
            ...event,
          })));
        }
      }
    } catch (pollErr: any) {
      addLog(
        "error",
        "Order-status poll failed; continuing this sync cycle without updated broker order state.",
        pollErr?.message || String(pollErr),
      );
    }

    // ==========================================================
    // MODULE 1.6: POSITION-LEVEL RECONCILIATION (Phase 2 Task 7,
    // docs/GO_LIVE_PLAN.md Phase 2.3: "Scheduled position-level reconciliation"
    // + "Mismatch halts buys"). Runs EVERY cycle (full AND reduced -- unlike
    // MODULE 2/2.5 below, this is not gated on autoTrading or reducedCycle:
    // "positions truth matters every cycle whether or not this cycle places
    // any new trades", same reasoning MODULE 1.5's poll above already
    // documents). Compares what our own successfully-placed trades imply we
    // should hold (reconciliationEngine.ts's computeExpectedPositions) against
    // Alpaca's live /positions -- the previously-unused `brokerPositions`
    // input reconcileBrokerState always accepted but never read. Runs AFTER
    // the order-status poll above so this comparison sees the freshest known
    // filledQty, and BEFORE every trade-placing module below so a mismatch
    // found this cycle blocks THIS cycle's own BUYs, not just the next one.
    //
    // Gated on the broker being configured (nothing to reconcile against in
    // dry-run/simulated mode -- same convention as startupReconciliation.ts).
    // A positions-fetch failure is deliberately NOT treated as drift: absence
    // of data is never drift (this task's binding fail-closed rule) -- the
    // comparison is skipped and logged, no report is persisted, and the
    // breaker latch is left untouched.
    // ==========================================================
    try {
      const reconciliationBrokerConfig = getBrokerConfig();
      if (!reconciliationBrokerConfig.configured) {
        addLog("sync", "Position reconciliation skipped: broker not configured (dry-run/simulated mode).");
      } else {
        const reconciliationFetch = await fetchAccountAndPositionsForReconciliation(reconciliationBrokerConfig);
        if (reconciliationFetch.ok === false) {
          addLog(
            "error",
            "Position reconciliation skipped: Alpaca account/positions fetch failed. Absence of data is not drift; latch state left unchanged.",
            reconciliationFetch.errorMessage,
          );
        } else {
          const reconciliationAccount = reconciliationFetch.account;
          const ledgerTrades = productionStore.listTradeIntents(250).map((trade) => ({
            id: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            status: trade.status,
            qty: trade.qty,
            filledQty: trade.filledQty,
          }));
          const acknowledgedBaselines = readAcknowledgedBaselines();
          const report = buildPositionReconciliationReport({
            trades: ledgerTrades,
            livePositions: reconciliationFetch.positions,
            acknowledgedBaselines,
            account: reconciliationAccount,
          });
          productionStore.saveReconciliationReport(report);
          addLog(
            "sync",
            `Position reconciliation: ${report.status} (${report.mismatches.length} mismatch(es)).`,
            report.mismatches.length ? JSON.stringify(report.mismatches) : undefined,
          );
          appendAuditEvents([
            {
              id: `ae-position-reconciliation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: new Date().toISOString(),
              type: "sync",
              actor: "position_reconciliation",
              message: `Position reconciliation ${report.status}: ${report.mismatches.length} mismatch(es).`,
              details: { reportId: report.id, status: report.status, mismatches: report.mismatches },
            },
          ]);

          if (report.mismatches.length > 0) {
            // Reuse the EXISTING breaker latch machinery (Task 10,
            // breakerLatch.ts) -- no parallel latch. Start from a REAL fresh
            // breaker evaluation (same equity/peakEquity continuity
            // executeTradeIntent/performBreakerReset already rely on) so
            // this never corrupts the drawdown breaker's own high-water
            // mark; a reconciliation mismatch only ever ESCALATES that
            // fresh status (never downgrades close_only to block_new_buys),
            // with "reconciliation_mismatch" added to its reasons -- the
            // additive reason-vocabulary extension this task's brief calls
            // for.
            const previousBreaker = productionStore.latestBreakerState<PreviousBreakerRecord>();
            const freshBreaker = evaluateFreshBreaker(reconciliationAccount, reconciliationBrokerConfig, previousBreaker?.peakEquity ?? null);
            const escalatedStatus: BreakerState["status"] = freshBreaker.status === "close_only" ? "close_only" : "block_new_buys";
            const escalatedFresh: BreakerState = {
              ...freshBreaker,
              status: escalatedStatus,
              reasons: [...freshBreaker.reasons, "reconciliation_mismatch"],
            };
            const latchResult = applyBreakerLatch(escalatedFresh, previousBreaker?.latch);
            const toPersist = { ...latchResult.effective, latch: latchResult.latchState };
            productionStore.saveBreakerState(toPersist);
            if (latchResult.event !== "none") {
              appendAuditEvents([
                breakerLatchAuditEvent({
                  event: latchResult.event,
                  corrupt: latchResult.corrupt,
                  latchedStatus: latchResult.latchState.latchedStatus,
                  fresh: escalatedFresh,
                  actor: "reconciliation_engine",
                }),
              ]);
            }

            // Throttled Telegram alert (Task 1's shouldSendThrottledAlert,
            // reused -- not a new throttle mechanism): a mismatch whose
            // fingerprint matches the last one alerted on is "persisting"
            // and only re-alerts once EMPTY_SYNC_ALERT_WINDOW_MS has
            // elapsed; a NEW/different mismatch fingerprint always alerts
            // immediately, bypassing the window. Only a DELIVERED alert
            // advances the stamp (same convention as the empty-sync alert
            // above) -- an undelivered attempt (Telegram unconfigured/down)
            // must never suppress the next real alert.
            const fingerprint = fingerprintMismatches(report.mismatches);
            let alertState: { fingerprint?: string; lastSentAt?: string } = {};
            try {
              const rawAlertState = productionStore.getAppState(RECONCILIATION_MISMATCH_ALERT_STATE_KEY);
              if (rawAlertState) alertState = JSON.parse(rawAlertState);
            } catch {
              alertState = {};
            }
            const isNewOrDifferentMismatch = alertState.fingerprint !== fingerprint;
            const dueByThrottle = shouldSendThrottledAlert(alertState.lastSentAt, Date.now(), EMPTY_SYNC_ALERT_WINDOW_MS);
            if (isNewOrDifferentMismatch || dueByThrottle) {
              const tgMsg = `🚨 <b>Reconciliation mismatch detected</b>\n${report.mismatches.length} mismatch(es) between local trade records and Alpaca's live positions. New BUY orders are blocked (sells remain available) until an admin investigates and either acknowledges the drift (POST /api/reconciliation/acknowledge) or resets the breaker (POST /api/breaker/reset) once resolved.\n<b>Details:</b> ${JSON.stringify(report.mismatches).slice(0, 2500)}`;
              const delivered = await sendTelegramAlert(currentConfig.telegram, tgMsg);
              if (delivered) {
                productionStore.setAppState(RECONCILIATION_MISMATCH_ALERT_STATE_KEY, JSON.stringify({ fingerprint, lastSentAt: new Date().toISOString() }));
              }
            }
          }
        }
      }
    } catch (reconciliationErr: any) {
      addLog(
        "error",
        "Position reconciliation failed unexpectedly; continuing this sync cycle without a fresh reconciliation report.",
        reconciliationErr?.message || String(reconciliationErr),
      );
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

        // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 --
        // Michael Burry Substack): symbols with an active, persisted
        // thesis_invalidations record -- this is what makes evaluateExitPlan's
        // thesisInvalidated dimension (exitEngine.ts) live for the first time
        // since Phase 1. A store read failure fails closed to an empty set
        // (never force-close a position on unknown/corrupt data), same
        // asymmetry as the regime-assessment read failure above.
        let thesisInvalidatedSymbols = new Set<string>();
        try {
          thesisInvalidatedSymbols = new Set(productionStore.listActiveThesisInvalidatedSymbols(new Date().toISOString()));
        } catch (thesisStoreErr: any) {
          addLog(
            "error",
            "Thesis invalidation store read failed; degrading to no invalidations this cycle (fail closed toward NOT force-closing positions).",
            thesisStoreErr?.message || String(thesisStoreErr),
          );
        }

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
          thesisInvalidatedSymbols,
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

          // Task 4 (docs/GO_LIVE_PLAN.md Phase 2.2): clear this symbol's live
          // bracket legs before the liquidation sell (see the shared helper
          // for the full rationale). Fail closed: a lookup/cancel failure
          // skips this software exit for the cycle -- the broker legs remain
          // the position's active protection (audited by the helper).
          const legCancel = await cancelBracketLegsBeforeSell({ symbol: decision.symbol, actor: "exit_monitor" });
          if (!legCancel.ok) {
            addLog("error", `Software exit for ${decision.symbol} skipped: ${legCancel.reason}. The broker-native bracket legs remain this position's active protection.`);
            continue;
          }
          if (legCancel.canceledCount > 0) {
            addLog("trade", `Canceled ${legCancel.canceledCount} bracket leg(s) for ${decision.symbol} before the software exit sell.`);
          }

          const liquidationTrade = await executeTradeIntent({
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

          appStore.appendTrade(liquidationTrade);

          // Clean local simulated portfolio if offline mode
          if (!getBrokerConfig().configured && liquidationTrade.status !== "BrokerFailed" && liquidationTrade.status !== "RiskRejected") {
            simulatedPortfolio.positions = (simulatedPortfolio.positions || []).filter((p: any) => p.symbol !== pos.symbol);
            const fundBack = sellQty * (parseFloat(pos.current_price) || 50);
            simulatedPortfolio.cash = String(parseFloat(simulatedPortfolio.cash) + fundBack);
            simulatedPortfolio.long_market_value = String(parseFloat(simulatedPortfolio.long_market_value) - fundBack);
            appStore.setSimulatedPortfolio(simulatedPortfolio);
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
    // below. All causes (no OAuth token, zero enabled registry sources, a
    // non-OK Gmail response, zero usable messages) share the one throttled
    // alert class -- this makes the alert text reflect whichever is CURRENT
    // this sync, not whichever happened to fire first after the last alert.
    let emptyEmailReason = "No Gmail authorization token detected.";

  if (authHeader) {
    gmailAttempted = true;
    addLog("sync", "Attempting to retrieve messages with active Gmail OAuth token...");

    // Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4): the registry replaces
    // the old single hardcoded ZipTrader query with a config-driven list of
    // sources, read FRESH every cycle (an operator's edit to the file takes
    // effect on the very next sync, no restart needed) -- see
    // sourceRegistry.ts for the fail-closed validation this wraps.
    const registryResult = loadSourceRegistry(SOURCE_REGISTRY_PATH);
    if (registryResult.createdDefaultFile) {
      addLog("sync", `Signal source registry file not found; created the default registry (ZipTrader only) at ${SOURCE_REGISTRY_PATH}.`);
    }
    for (const issue of registryResult.issues) {
      addLog(
        "error",
        `Signal source registry ${issue.scope === "file" ? "file is invalid" : `entry${issue.id ? ` "${issue.id}"` : ""} is invalid`}: ${issue.message}`,
      );
    }
    if (registryResult.cappedIds.length > 0) {
      addLog(
        "error",
        `Signal source registry: ${registryResult.cappedIds.length} enabled source(s) exceeded the ${MAX_ENABLED_SOURCES_PER_CYCLE}-source cap (Guardrail 8) and were skipped this cycle: ${registryResult.cappedIds.join(", ")}.`,
      );
    }
    if (registryResult.migratedIds.length > 0) {
      // Phase 2 Task 9: additive registry migration -- an existing registry
      // file that predates a newly-shipped default source (e.g. motley-fool)
      // was just extended with it, disabled, on this load. Logged (not
      // alerted -- this is an expected, non-error one-time upgrade event, not
      // a malformed-config issue) so an operator sees it and can review/enable.
      addLog(
        "sync",
        `Signal source registry: added missing default source(s), disabled, during migration: ${registryResult.migratedIds.join(", ")}. Review and enable in ${SOURCE_REGISTRY_PATH} when ready.`,
      );
    }
    if (registryResult.issues.length > 0) {
      await alertOnSourceRegistryIssues(currentConfig, registryResult.issues);
    }

    const enabledSources = registryResult.sources;
    if (enabledSources.length === 0) {
      addLog("sync", "Signal source registry has zero enabled, valid sources; contributing zero email scan-targets this sync.");
      emptyEmailReason = "Signal source registry has zero enabled, valid sources.";
    }

    const perSourceErrored: boolean[] = [];
    const perSourceReasons: string[] = [];

    for (const source of enabledSources) {
      try {
        const gmailRes = await fetchWithTimeout(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(source.gmailQuery)}&maxResults=${GMAIL_MAX_RESULTS_PER_SOURCE}`,
          { headers: { Authorization: authHeader } }
        );

        if (gmailRes.ok) {
          const gmailData = await gmailRes.json();
          const messages = gmailData.messages || [];
          addLog("sync", `Successfully listed ${messages.length} messages from source "${source.id}" (${source.gmailQuery}).`);
          perSourceErrored.push(false);
          perSourceReasons.push(
            messages.length === 0
              ? `${source.id}: zero messages matched this sync.`
              : `${source.id}: messages returned but none were usable this sync (see per-message log entries).`,
          );

          for (const msg of messages) {
            const detailRes = await fetchWithTimeout(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
              { headers: { Authorization: authHeader } }
            );
            if (!detailRes.ok) continue;
            const detailData = await detailRes.json();

            // Sender policy, blocklist BEFORE allowlist (docs/GO_LIVE_PLAN.md
            // Phase 2.4): a global brokerage-notification blocklist that no
            // registry entry can override, checked ahead of this source's own
            // sender allowlist (exact-match on the parsed From address).
            const fromHeader = extractFromHeader(detailData);
            const senderDecision = evaluateSender(fromHeader, source.senderAllowlist);
            if (senderDecision.outcome === "blocked") {
              addLog(
                "error",
                `Blocklisted sender skipped for source "${source.id}", message ${msg.id}: ${senderDecision.address}.` +
                  (senderDecision.blocklistConflict
                    ? ` This address is ALSO present in source "${source.id}"'s senderAllowlist -- the blocklist wins, but check the registry config for a mistaken allowlist entry.`
                    : ""),
              );
              continue;
            }
            if (senderDecision.outcome === "rejected") {
              addLog(
                "error",
                `Skipping Gmail message ${msg.id} from source "${source.id}": sender ${senderDecision.address ?? "(unparsable From header)"} is not on the allowlist.`,
              );
              continue;
            }

            const extraction = extractEmailScanTarget(detailData);
            if (extraction.ok === false) {
              // Fail-closed: no real send time could be recovered for this message.
              // Never fabricate "now" -- skip it rather than let an undated thesis
              // sail through the freshness check.
              addLog("error", `Skipping Gmail message ${msg.id} from source "${source.id}": ${extraction.reason}`);
              continue;
            }
            if (extraction.bodyDegraded) {
              addLog("sync", `Body extraction degraded for Gmail message ${msg.id} (source "${source.id}"); using snippet fallback.`);
            }
            emailsToScan.push({
              kind: "email",
              source: source.id,
              title: extraction.target.title,
              content: extraction.target.content,
              sourceTimestamp: extraction.target.sourceTimestamp,
              messageId: extraction.target.messageId,
              trustTier: source.trustTier,
              maxAgeHours: source.maxAgeHours,
              // Phase 2 Task 9: additive, carried straight through from the
              // registry entry -- absent for every source without one (e.g.
              // ziptrader), so analysis prompt content is unchanged for them.
              promptHint: source.promptHint,
            });
          }
        } else {
          const errTxt = await gmailRes.text();
          addLog("error", `Gmail API failed for source "${source.id}". No email signals from this source this sync.`, errTxt);
          perSourceErrored.push(true);
          perSourceReasons.push(`${source.id}: Gmail API request failed (non-OK response): ${errTxt.substring(0, 200)}`);
        }
      } catch (err: any) {
        addLog("error", `Gmail sync connection error for source "${source.id}".`, err.message);
        perSourceErrored.push(true);
        perSourceReasons.push(`${source.id}: Gmail sync connection error: ${err.message}`);
      }
    }

    if (enabledSources.length > 0) {
      // Aggregate across sources, same semantics as the pre-Task-8 single-
      // source flags: "errored" means every source we actually queried this
      // cycle failed outright (network error / non-OK response) -- not
      // merely zero/unusable messages, which is an expected, non-error
      // outcome that must not trip Guardrail 7's "every attempted source
      // errored" check below.
      gmailErrored = perSourceErrored.length > 0 && perSourceErrored.every(Boolean);
      if (perSourceReasons.length > 0) emptyEmailReason = perSourceReasons.join(" | ");
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

      // Phase 2 Task 9 (docs/GO_LIVE_PLAN.md Phase 2.4): additive per-source
      // prompt awareness. Only email targets carry a registry-sourced
      // promptHint at all, and it's optional even then -- absent for every
      // source that doesn't set one (ziptrader included), so the prompt text
      // below is byte-for-byte unchanged for those.
      const promptHintSection = target.kind === "email" && target.promptHint ? `\n\n${target.promptHint}` : "";

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
Content: ${target.content}${promptHintSection}

You must extract the stock ticker symbol mentioned (like PLTR, MARA, TSLA, NVDA), assess growth potential score (0 to 100), market sentiment score (-100 to 100), and define a risk profile ('Low' | 'Medium' | 'High').
Crucially, when the stock goes down for any reason, assess whether it is a support level 'whipsaw' because of the overall market volatility OR a genuine 'trend reversal' before deciding to act. Validate the fundamentals and the core thesis.
Set a decision: 'BUY' (if sentiment is very bullish & whipsaw check passes), 'SELL' (if trend reversal is verified or target stop loss hit), 'HOLD', or 'NONE' (if no clear ticker discussed).

For "reasoning", write a concise human sentence explaining the fundamental thesis validation. For "whipsawCheck", give a definitive explanation of whether the current pull-back is a whipsaw or genuine trend reversal.
For "whipsawVerdict", classify that same judgment into exactly one of three structured values: 'whipsaw' (a temporary shakeout -- the dip is likely to recover), 'reversal' (a verified genuine trend reversal), or 'unclear' (you cannot determine which). This structured value is what the trading system gates SELL decisions and BUY confidence on, so it must reflect your actual judgment, not just be copied from the decision field. If no clear ticker is discussed, set "symbol" to "UNKNOWN".
For "stance", classify the source's own directional call on the ticker into exactly one of three structured values: 'bullish' (a buy/add/positive recommendation), 'bearish' (an explicit sell instruction, a short thesis, or another clearly bearish call -- this trading system is long-only and never opens shorts, so a bearish stance means exit an existing position or avoid a new one, never short), or 'neutral' (a hold, a mixed/unclear call, or insufficient information to judge direction). This must reflect the source's actual directional judgment, not be mechanically copied from "decision".`,
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
                stance: { type: "string", enum: ["bullish", "bearish", "neutral"] },
                decision: { type: "string", enum: ["BUY", "SELL", "HOLD", "NONE"] },
              },
              required: ["symbol", "growthScore", "sentimentScore", "riskProfile", "reasoning", "whipsawCheck", "whipsawVerdict", "stance", "decision"],
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

        // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 --
        // Michael Burry Substack, long-only bearish mapping). normalizeStance
        // is the same defensive parse-site validation whipsawVerdict already
        // gets: any value other than the three allowed strings fails closed
        // to "neutral" -- neutral never trades and never invalidates a thesis
        // (src/server/bearishMapping.ts).
        const stance = normalizeStance(parsed.stance);
        // decision BUY + stance bearish is a contradiction the schema
        // shouldn't produce (this system never opens shorts, so a bearish
        // call can never be a BUY) -- defensive, logged loudly, forced to
        // NONE. Computed from `parsed.decision` (pre-whipsaw-gate) since the
        // gate has no awareness of stance and would otherwise let a
        // confidence-haircut BUY straight through.
        const bearishBuyContradiction = parsed.decision === "BUY" && stance === "bearish";
        if (bearishBuyContradiction) {
          addLog(
            "error",
            `Contradiction: ${parsed.symbol} was analyzed with decision "BUY" but stance "bearish" -- this system is long-only and never opens shorts, so a bearish stance can never be a BUY. Forcing decision to NONE.`,
          );
        }
        const effectiveDecision = bearishBuyContradiction ? "NONE" : gated.decision;

        const item: StockAnalysis = {
          id: "an-" + Math.random().toString(36).substr(2, 9),
          symbol: parsed.symbol.toUpperCase(),
          // StockAnalysis.source stays the coarse "email" | "youtube"
          // category the UI (ZipTraderCard.tsx) switches display copy on --
          // NOT the specific registry source id. That finer-grained id
          // (e.g. "ziptrader") is stamped onto the signal-engine layer
          // (RawSignal/ReviewedSignal) below instead, per the task brief
          // ("store `source` on every signal"), leaving this display-level
          // field and the frontend that reads it untouched.
          source: target.kind === "youtube" ? "youtube" : "email",
          sourceTitle: target.title,
          sourceContent: target.content,
          growthScore: parsed.growthScore,
          sentimentScore: parsed.sentimentScore,
          riskProfile: parsed.riskProfile as any,
          // Honest audit trail: when the gate downgrades a SELL to HOLD, or a
          // bearish/BUY contradiction is forced to NONE, that fact is
          // recorded directly in the persisted reasoning, not just the sync
          // log.
          reasoning: bearishBuyContradiction
            ? `${parsed.reasoning} [Bearish/BUY contradiction: source flagged stance "bearish" with decision "BUY"; forced to NONE -- this system never opens shorts.]`
            : gated.downgraded
            ? `${parsed.reasoning} [Whipsaw gate: ${gated.note}]`
            : parsed.reasoning,
          whipsawCheck: parsed.whipsawCheck,
          whipsawVerdict,
          stance,
          decision: effectiveDecision as any,
          // Real source timestamp (Gmail internalDate/Date header for email, or
          // "now" for the just-completed YouTube web search) -- not "now" for
          // every thesis regardless of actual age. This is what lets the signal
          // engine's freshness check (maxAgeHours) do anything at all.
          timestamp: target.sourceTimestamp,
        };

        // Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, "Cross-source
        // confirmation bonus"): computed BEFORE the raw signal is built, so a
        // boost can be baked into `aiConfidence` before reviewSignal/sizing
        // ever consumes it, and so the applied effect is recorded on the
        // signal itself (`crossSource`, below) rather than only logged. A
        // store read failure fails toward "no corroborating signals" (effect
        // "none", the inert default) rather than fabricating a boost or
        // blocking the signal outright -- still logged for visibility.
        let crossSourceRecentSignals: ReturnType<typeof productionStore.recentAcceptedSignalsForSymbol> = [];
        try {
          const crossSourceSinceIso = new Date(Date.now() - CROSS_SOURCE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
          crossSourceRecentSignals = productionStore.recentAcceptedSignalsForSymbol(item.symbol, crossSourceSinceIso);
        } catch (err: any) {
          addLog("error", `Cross-source confirmation lookup failed for ${item.symbol}; treating as no corroborating signals.`, err?.message || String(err));
        }
        const crossSourceResult = evaluateCrossSource({
          symbol: item.symbol,
          currentSource: target.source,
          stance,
          recentSignals: crossSourceRecentSignals,
        });
        let crossSourceConfidence = gated.aiConfidence;
        if (crossSourceResult.effect === "boost") {
          crossSourceConfidence = Math.max(0, Math.min(100, gated.aiConfidence * crossSourceResult.multiplier));
          addLog(
            "sentiment",
            `Cross-source confirmation for ${item.symbol}: another bullish source agrees within ${CROSS_SOURCE_WINDOW_HOURS}h -- confidence boosted x${crossSourceResult.multiplier} (${gated.aiConfidence} -> ${crossSourceConfidence}).`,
          );
        } else if (crossSourceResult.effect === "conflict") {
          addLog(
            "sentiment",
            `Cross-source conflict for ${item.symbol}: another source disagrees (opposite stance) within ${CROSS_SOURCE_WINDOW_HOURS}h.`,
          );
        }
        // Per the plan, the conflict flag applies to the BULLISH side's trade
        // intent only -- it must never suppress bearishMapping.ts's own
        // do-not-buy/thesis-invalidation consequences for the bearish side
        // (evaluated further below; untouched by this flag).
        const crossSourceConflictForBuy = stance === "bullish" && crossSourceResult.effect === "conflict";

        const rawSignal = createRawSignal({
          // Phase 2 Task 8 (signal-source registry): an email target's
          // `source` is now the registry's own id (e.g. "ziptrader"), not a
          // generic "email" literal -- stamped straight through so Phase 3
          // attribution can compare sources. YouTube keeps its unchanged
          // literal "youtube".
          source: target.source,
          // Finding I1: identify an email by Gmail's message id, not its subject
          // line -- two distinct emails (e.g. a recurring weekly newsletter) can
          // share an identical title, which would otherwise collapse them into one
          // dedup identity. Falls back to the title-based id defensively if a
          // message id was never captured. YouTube has no per-message resource
          // (it's a fresh web-search summary each run) so it keeps the title-based
          // sourceId, unchanged.
          sourceId: target.kind === "email" && target.messageId
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
          dedupContent: target.kind === "email" ? target.content : undefined,
          url: target.kind === "youtube" ? "youtube://ziptrader" : `gmail://${target.source}`,
          // Confidence already carries the whipsaw haircut (or is unchanged for
          // whipsaw/HOLD/NONE), and now also the Task 11 cross-source boost
          // (or is unchanged when the effect was "conflict"/"none") -- this is
          // what flows into sizing's confidenceMultiplier.
          aiConfidence: crossSourceConfidence,
          // Phase 2 Task 8: recorded-only, carried through from the source's
          // registry entry -- YouTube (not registry-governed) leaves it unset.
          trustTier: target.kind === "email" ? target.trustTier : undefined,
          // Phase 2 Task 11: the authoritative stance and the cross-source
          // effect computed for THIS signal, carried straight onto the
          // persisted reviewed signal (domainTypes.ts).
          stance,
          crossSource: crossSourceResult,
        });
        // Phase 2 Task 8: per-source maxAgeHours (email) replaces the
        // universal 72h default for registry-governed sources -- YouTube
        // keeps that same 72h default, unchanged, by omitting the override.
        const reviewedSignal = reviewAndPersistSignal(productionStore, rawSignal, {
          maxAgeHours: target.kind === "email" ? target.maxAgeHours : undefined,
        });
        if (reviewedSignal.status === "rejected") {
          addLog("error", `Signal rejected for ${item.symbol}: ${reviewedSignal.rejectionReason}`);
          continue;
        }

        appStore.appendAnalysis(item);
        parsedAnalyses.push(item);
        results.push(item);

        addLog("sentiment", `Analyzed ${item.symbol}: Growth ${item.growthScore}, Sentiment ${item.sentimentScore}%. Decision: ${item.decision}`);

        // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 --
        // Michael Burry Substack): the long-only bearish-mapping layer.
        // Recording is BOOKKEEPING, not trading -- so this block is
        // deliberately NOT gated on autoTrading (review fix 2): signal dedup
        // fires a given email exactly once, and autoTrading off is the
        // default state while an operator reviews a newly-enabled source, so
        // gating these writes on autoTrading would permanently lose the
        // record. Only the exit EXECUTION (the sell intent, further below)
        // stays behind autoTrading. A bearish SELL is also evaluated here
        // even when the whipsaw gate downgraded it to HOLD (see
        // bearishMapping.ts's precedence doc comment) -- `parsed.decision`
        // (pre-gate) is deliberately used as `originalDecision`.
        const bearishSellCandidate = stance === "bearish" && parsed.decision === "SELL";
        let bearishMappingResult: BearishMappingResult | undefined;
        if (bearishSellCandidate) {
          // The held-state check needs a portfolio snapshot even when
          // autoTrading is off -- the one deliberate exception to "no broker
          // calls when trading is off", since which list the symbol belongs
          // on (thesis-invalidation vs. do-not-buy) depends on whether it is
          // held. A fetch failure fails toward the CHEAP action: treat as
          // unheld (do-not-buy) -- never toward marking a thesis invalidated
          // (which would later force an exit) on unknown data.
          let symbolHeldForMapping = false;
          try {
            const heldCheckPortfolio = await getAlpacaPortfolio();
            const heldPos = (heldCheckPortfolio.positions || []).find((p: any) => p.symbol === item.symbol);
            symbolHeldForMapping = !!heldPos && parseInt(heldPos.qty) > 0;
          } catch (err: any) {
            addLog("error", `Bearish mapping for ${item.symbol}: portfolio fetch for the held-state check failed; treating as unheld (do-not-buy -- the cheap action).`, err?.message || String(err));
          }
          bearishMappingResult = evaluateBearishMapping({
            symbol: item.symbol,
            sourceId: target.source,
            originalDecision: parsed.decision,
            stance: parsed.stance,
            symbolHeld: symbolHeldForMapping,
            whipsawDowngraded: gated.downgraded,
          });

          if (bearishMappingResult.kind === "thesis_invalidation") {
            try {
              productionStore.saveThesisInvalidation({
                symbol: bearishMappingResult.symbol,
                sourceId: bearishMappingResult.sourceId,
                reason: bearishMappingResult.reason,
                expiresAt: bearishMappingResult.expiresAt,
              });
              addLog(
                "trade",
                `Thesis invalidated for ${item.symbol} by source "${bearishMappingResult.sourceId}" (bearish stance, whipsaw-verified reversal). With autoTrading on, the exit executes via the SELL decision path this cycle; MODULE 2 re-evaluates this dimension on subsequent cycles until ${bearishMappingResult.expiresAt}.`,
              );
              appendAuditEvents([{
                id: `ae-thesisinv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                type: "risk",
                actor: "bearish_mapping",
                entityId: item.symbol,
                message: `Thesis invalidated for ${item.symbol}: ${bearishMappingResult.reason}`,
                details: { symbol: item.symbol, sourceId: bearishMappingResult.sourceId, expiresAt: bearishMappingResult.expiresAt },
              }]);
            } catch (err: any) {
              addLog("error", `Failed to persist thesis invalidation for ${item.symbol}; this cycle's SELL still executes via the normal decision path if applicable.`, err?.message || String(err));
            }
          } else if (bearishMappingResult.kind === "do_not_buy") {
            try {
              productionStore.saveDoNotBuy({
                symbol: bearishMappingResult.symbol,
                sourceId: bearishMappingResult.sourceId,
                reason: bearishMappingResult.reason,
                expiresAt: bearishMappingResult.expiresAt,
              });
              addLog(
                "trade",
                `${item.symbol} added to the do-not-buy list by source "${bearishMappingResult.sourceId}" (bearish stance on an unheld symbol) until ${bearishMappingResult.expiresAt}.`,
              );
              appendAuditEvents([{
                id: `ae-donotbuy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                type: "risk",
                actor: "bearish_mapping",
                entityId: item.symbol,
                message: `${item.symbol} added to do-not-buy: ${bearishMappingResult.reason}`,
                details: { symbol: item.symbol, sourceId: bearishMappingResult.sourceId, expiresAt: bearishMappingResult.expiresAt },
              }]);
            } catch (err: any) {
              addLog("error", `Failed to persist do-not-buy entry for ${item.symbol}.`, err?.message || String(err));
            }
          }
        }

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
              const latestTrade = await fetchWithTimeout(`${dataBaseUrl}/v2/stocks/${item.symbol}/trades/latest`, {
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
            // Phase 2 Task 10: do-not-buy enforcement, checked before sizing.
            // A store read failure fails closed -- the BUY is rejected rather
            // than proceeding as if no do-not-buy entries exist (same
            // precedent as the symbol-cooldown read failure in
            // executeTradeIntent above).
            let doNotBuyEntry: { symbol: string; sourceId: string; reason: string; expiresAt: string } | undefined;
            let doNotBuyLoadFailed = false;
            try {
              doNotBuyEntry = productionStore.listActiveDoNotBuy(new Date().toISOString()).find((e) => e.symbol === item.symbol);
            } catch (err: any) {
              doNotBuyLoadFailed = true;
              addLog("error", `Do-not-buy store read failed for ${item.symbol}; failing closed and rejecting this BUY.`, err?.message || String(err));
            }
            if (doNotBuyLoadFailed) {
              appendAuditEvents([{
                id: `ae-donotbuy-readfail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                type: "risk",
                actor: "bearish_mapping",
                entityId: item.symbol,
                message: `BUY for ${item.symbol} rejected: do-not-buy store read failed (fail closed).`,
              }]);
            } else if (doNotBuyEntry) {
              addLog(
                "error",
                `Order skipped for ${item.symbol}. On the do-not-buy list until ${doNotBuyEntry.expiresAt} (source "${doNotBuyEntry.sourceId}": ${doNotBuyEntry.reason}).`,
              );
              appendAuditEvents([{
                id: `ae-donotbuy-blocked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
                type: "risk",
                actor: "bearish_mapping",
                entityId: item.symbol,
                message: `BUY for ${item.symbol} rejected: on do-not-buy list (source "${doNotBuyEntry.sourceId}", expires ${doNotBuyEntry.expiresAt}).`,
                details: { symbol: item.symbol, sourceId: doNotBuyEntry.sourceId, expiresAt: doNotBuyEntry.expiresAt, reason: doNotBuyEntry.reason },
              }]);
            } else {
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
              appendAuditEvents([{
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
                config: currentConfig,
                request: {
                  source: "automation",
                  symbol: item.symbol,
                  qty,
                  estimatedPrice: price,
                  side: "buy",
                  reasoning: `ZipTrader thesis validated. Whipsaw check: ${item.whipsawCheck}. Fundamentals: ${item.reasoning}`,
                  // Phase 2 Task 11: routes into reviewRisk's additive
                  // crossSourceConflictSymbols input via executeTradeIntent.
                  crossSourceConflict: crossSourceConflictForBuy,
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

              appStore.appendTrade(newTrade);

              // Update simulation list
              if (!getBrokerConfig().configured && newTrade.status !== "BrokerFailed" && newTrade.status !== "RiskRejected") {
                const currentSim = simulatedPortfolio;
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
                appStore.setSimulatedPortfolio(currentSim);
              }

              addLog("trade", `Submitted BUY ${qty} shares of ${item.symbol}. State: ${newTrade.status}. Telegram: ${newTrade.notifiedTelegram ? 'Sent' : 'Disabled'}, Sheets: ${newTrade.exportedSheets ? 'Appended' : 'Disabled'}, Notion: ${newTrade.loggedNotion ? 'Saved' : 'Disabled'}`);
            }
            }
          } else if (item.decision === "SELL" && currentShares && parseInt(currentShares.qty) > 0) {
            const qty = parseInt(currentShares.qty);
            addLog("sync", `Submitting sell recommendation intent to close position of ${qty} shares for ${item.symbol}...`);

            // Task 4 (docs/GO_LIVE_PLAN.md Phase 2.2): the automation
            // SELL-decision path is a sell call site like any other -- clear
            // this symbol's live bracket legs first (shared helper; same
            // fail-closed semantics as MODULE 2). A cancel failure skips
            // THIS cycle's sell only (log + audit, both handled here/in the
            // helper) -- the broker legs remain the position's protection,
            // the analysis loop continues with the next target, and the
            // next cycle re-evaluates. Without this, every trend-reversal
            // close on a bracket-protected position would be deterministically
            // rejected by Alpaca ("insufficient qty -- held for orders").
            const legCancel = await cancelBracketLegsBeforeSell({ symbol: item.symbol, actor: "automation" });
            if (!legCancel.ok) {
              addLog("error", `Automation SELL for ${item.symbol} skipped this cycle: ${legCancel.reason}. The broker-native bracket legs remain this position's active protection.`);
              continue;
            }
            if (legCancel.canceledCount > 0) {
              addLog("trade", `Canceled ${legCancel.canceledCount} bracket leg(s) for ${item.symbol} before the automation sell.`);
            }

            // Phase 2 Task 10: when the bearish-mapping layer classified this
            // SELL as a thesis invalidation (held symbol, bearish stance,
            // whipsaw-verified reversal -- see above), the executed trade's
            // reasoning says so explicitly, exercising exitEngine.ts's
            // thesis_invalidation dimension text/wording for a consistent
            // audit trail with MODULE 2's own plan exits (exitMonitor.ts's
            // buildPlanReasoning).
            const sellReasoning = bearishMappingResult?.kind === "thesis_invalidation"
              ? `thesis_invalidation triggered: ${bearishMappingResult.reason}`
              : `Trend reversal warning assessed or stop loss margin hit. Closing positions.`;

            const newTrade = await executeTradeIntent({
              config: currentConfig,
              request: {
                source: "automation",
                symbol: item.symbol,
                qty,
                estimatedPrice: price,
                side: "sell",
                reasoning: sellReasoning,
              },
              marketKnownClosed,
            });

            const tgMsg = `🚨 <b>ZipTrader Automation: SELL INTENT ${newTrade.status}</b>\n<b>Ticker:</b> ${newTrade.symbol}\n<b>Quantity:</b> ${newTrade.qty}\n<b>Price:</b> $${newTrade.price}\n<b>Reasoning:</b> ${newTrade.reasoning}`;
            newTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
            newTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, newTrade);
            newTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, item);

            appStore.appendTrade(newTrade);

            if (!getBrokerConfig().configured && newTrade.status !== "BrokerFailed" && newTrade.status !== "RiskRejected") {
              const currentSim = simulatedPortfolio;
              currentSim.positions = currentSim.positions.filter((p: any) => p.symbol !== item.symbol);
              currentSim.cash = String(parseFloat(currentSim.cash) + (qty * price));
              currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) - (qty * price));
              appStore.setSimulatedPortfolio(currentSim);
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
  const release = await appStore.acquire();
  try {
    const { symbol, side } = req.body;
    const authHeader = req.headers.authorization || null;

    const currentConfig: AppConfig = appStore.getConfig();
    const simulatedPortfolio: SimulatedPortfolio = appStore.getSimulatedPortfolio();
    const timestamp = new Date().toISOString();

    const addLog = (type: SyncLog["type"], msg: string, details?: string) => {
      appStore.addLog({ id: "l-" + Math.random().toString(36).substr(2, 9), timestamp, type, message: msg, details });
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
        appendAuditEvents([{
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

    // Task 4 (docs/GO_LIVE_PLAN.md Phase 2.2): a manual SELL on a position
    // whose BUY was placed as a broker-native bracket must clear the live
    // legs first, or Alpaca rejects the sell ("insufficient qty -- held for
    // orders"). Shared helper -- same fail-closed semantics as the exit
    // monitor and close-all: if a cancel fails, the sell is NOT submitted
    // (the legs remain the protection) and the response says so honestly
    // instead of claiming success for an order that never went out.
    if (side === "sell") {
      const legCancel = await cancelBracketLegsBeforeSell({ symbol, actor: "manual_override" });
      if (!legCancel.ok) {
        addLog("error", `Manual override SELL for ${symbol} skipped: ${legCancel.reason}. The broker-native bracket legs remain this position's active protection.`);
        res.status(502).json({
          success: false,
          error: "Manual trade override rejected",
          details: `Failed to cancel this position's live bracket leg(s), so the sell was NOT submitted (${legCancel.reason}). The position remains protected by its broker-native bracket order; retry once the broker is reachable.`,
        });
        return;
      }
      if (legCancel.canceledCount > 0) {
        addLog("override", `Canceled ${legCancel.canceledCount} bracket leg(s) for ${symbol} before the manual override sell.`);
      }
    }

    const tradeVal = await executeTradeIntent({
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

    // Intentionally NOT deduped by client_order_id: this legacy trades log is an
    // append-only per-attempt record (UI history, daily trade counting); the SQLite
    // trade_intents store is the deduped source of truth for reconciliation (Task 13).
    appStore.appendTrade(tradeVal);

    if (!getBrokerConfig().configured && tradeVal.status !== "BrokerFailed" && tradeVal.status !== "RiskRejected") {
      const currentSim = simulatedPortfolio;
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
      appStore.setSimulatedPortfolio(currentSim);
    }

    // Task 4 honesty fix: `orderPlaced` (additive field) reports whether this
    // trade actually reached the broker successfully; for a SELL, `success`
    // itself is honest -- a RiskRejected/BrokerFailed sell must never read as
    // a successful liquidation (the UI reads trade.status and error only, so
    // this is backward-compatible). BUY `success` semantics are unchanged.
    const orderPlaced = BROKER_SUCCESS_TRADE_STATUSES.has(tradeVal.status);
    res.json({
      success: side === "sell" ? orderPlaced : true,
      orderPlaced,
      trade: tradeVal,
      ...(clamp ? { clamp } : {}),
    });
  } catch (err: any) {
    console.error("Critical error in /api/override/trade:", err);
    res.status(500).json({ error: "Manual trade override failed", details: err.message });
  } finally {
    release();
  }
});

// Urgent close-out control
app.post("/api/override/close-all", requireAdminCommand, async (req, res) => {
  const release = await appStore.acquire();
  try {
    const config = appStore.getConfig();
    const simulatedPortfolio: SimulatedPortfolio = appStore.getSimulatedPortfolio();
    const timestamp = new Date().toISOString();

    appStore.addLog({
      id: "l-" + Math.random().toString(36).substr(2, 9),
      timestamp,
      type: "override",
      message: "EMERGENCY OVERRIDE Dispatched: Close out all paper portfolio positions immediately."
    });

    const portfolio = await getAlpacaPortfolio();

    // Task 4 honesty fix: per-symbol outcomes, reported truthfully. Before
    // this fix, the endpoint unconditionally claimed every position was sold
    // -- even when a sell was RiskRejected/BrokerFailed, or (with brackets
    // now the default for BUYs) would have been rejected by Alpaca because
    // the shares were held by live bracket legs. The panic button must never
    // silently no-op.
    const results: Array<{ symbol: string; sold: boolean; status: string; reason?: string }> = [];

    for (const pos of portfolio.positions) {
      const currentPrice = parseFloat(pos.current_price);
      if (!currentPrice || !Number.isFinite(currentPrice)) {
        appStore.addLog({
          id: "l-" + Math.random().toString(36).substr(2, 9),
          timestamp,
          type: "error",
          message: `Emergency close skipped for ${pos.symbol}; no deterministic current price was available.`,
        });
        results.push({ symbol: pos.symbol, sold: false, status: "Skipped", reason: "no deterministic current price was available" });
        continue;
      }
      // Task 4: clear live bracket legs before the sell (shared helper; same
      // fail-closed semantics as the exit monitor). A cancel failure skips
      // THIS symbol only -- its legs remain the protection -- and the rest of
      // the portfolio still closes; the failure is counted and audited.
      const legCancel = await cancelBracketLegsBeforeSell({ symbol: pos.symbol, actor: "emergency_close" });
      if (!legCancel.ok) {
        appStore.addLog({
          id: "l-" + Math.random().toString(36).substr(2, 9),
          timestamp,
          type: "error",
          message: `Emergency close skipped for ${pos.symbol}: ${legCancel.reason}. The broker-native bracket legs remain this position's active protection.`,
        });
        results.push({ symbol: pos.symbol, sold: false, status: "Skipped", reason: legCancel.reason });
        continue;
      }
      const emergencyTrade = await executeTradeIntent({
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
      appStore.appendTrade(emergencyTrade);
      const sold = BROKER_SUCCESS_TRADE_STATUSES.has(emergencyTrade.status);
      results.push({
        symbol: pos.symbol,
        sold,
        status: emergencyTrade.status,
        ...(sold ? {} : { reason: emergencyTrade.riskDecision?.reason || `sell ended in status ${emergencyTrade.status}` }),
      });
    }

    const soldCount = results.filter((r) => r.sold).length;
    const failedCount = results.length - soldCount;

    if (!getBrokerConfig().configured) {
      const totalPosValue = parseFloat(simulatedPortfolio.long_market_value) || 0;
      simulatedPortfolio.cash = String(parseFloat(simulatedPortfolio.cash) + totalPosValue);
      simulatedPortfolio.long_market_value = "0.00";
      simulatedPortfolio.positions = [];
      appStore.setSimulatedPortfolio(simulatedPortfolio);
    }

    // Send panic telegram broadcast -- honest about the real outcome, never
    // an unconditional "everything sold" claim.
    const failedSymbols = results.filter((r) => !r.sold).map((r) => r.symbol);
    const tgMessage = failedCount === 0
      ? `🚨 <b>Portfolio Panic Trigger: EMERGENCY CLOSE DISPATCHED.</b> ${soldCount} of ${results.length} open position(s) sold.`
      : `🚨 <b>Portfolio Panic Trigger: EMERGENCY CLOSE PARTIAL.</b> ${soldCount} of ${results.length} position(s) sold; ${failedCount} FAILED/SKIPPED (${failedSymbols.join(", ")}). Skipped bracket-protected positions remain covered by their broker legs. Manual review required.`;
    await sendTelegramAlert(config.telegram, tgMessage);

    res.json({
      success: failedCount === 0,
      soldCount,
      failedCount,
      results,
      message: failedCount === 0
        ? `Emergency close executed: ${soldCount} of ${results.length} position(s) sold.`
        : `Emergency close PARTIAL: ${soldCount} of ${results.length} position(s) sold; ${failedCount} failed/skipped (${failedSymbols.join(", ")}). Manual review required.`,
    });
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
  getIntervalMinutesRaw: () => appStore.getConfig().system?.runIntervalMins,
  isAutoTradingOn: () => Boolean(appStore.getConfig().system?.autoTrading),
  // Phase 2 Task 6: read fresh every tick, same as isAutoTradingOn -- a tick
  // that fires while startup reconciliation is still pending (or retrying)
  // skips the whole cycle (scheduler.ts logs "startup reconciliation pending").
  isTradingReady: () => isTradingReady(),
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
    // appStore.updateConfig acquires/releases the lock itself -- do not wrap
    // this in a manual appStore.acquire() (it would deadlock).
    const config = await appStore.updateConfig((current) => ({ ...current, system: { ...current.system, autoTrading: false } }));
    const telegramConfig = config.telegram;
    appendAuditEvents([{
      id: `ae-autopause-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type: "config",
      actor: "scheduler",
      message: `Auto-pause: ${MAX_CONSECUTIVE_FAILURES} consecutive scheduled sync cycle failures; autoTrading set to false. Stays paused until a human resumes.`,
      details: { consecutiveFailures: MAX_CONSECUTIVE_FAILURES },
    }]);
    await sendTelegramAlert(
      telegramConfig,
      `🛑 <b>Auto-trading paused.</b> ${MAX_CONSECUTIVE_FAILURES} consecutive scheduled sync cycles failed. Trading stays paused until a human resumes (POST /api/config or the Telegram /resume command).`,
    );
  },
  // Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5): heartbeat counter.
  // Fires exactly once per ACTUALLY-RUN scheduled cycle (scheduler.ts never
  // calls this for a tick skipped due to autoTrading-off/startup-
  // reconciliation-pending/single-flight overlap). "Completed" counts a
  // FAILED cycle too -- it still ran to completion, it just didn't succeed --
  // same definition the pre-existing MAX_CONSECUTIVE_FAILURES counter above
  // already uses one level up. No market-hours exception needed: a reduced
  // cycle (market closed) still calls runScheduledCycle and still completes
  // (see heartbeat.ts's MISSED_CYCLE_ALERT_MULTIPLIER doc comment).
  onCycleCompleted: async () => {
    let count = 0;
    try {
      const raw = productionStore.getAppState(CYCLE_COUNT_APP_STATE_KEY);
      const parsed = raw === undefined ? NaN : Number(raw);
      count = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (err) {
      console.error("[heartbeat] Failed to read the persisted completed-cycle count; defaulting to 0.", err);
    }
    count += 1;
    try {
      productionStore.setAppState(CYCLE_COUNT_APP_STATE_KEY, String(count));
      productionStore.setAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY, String(Date.now()));
    } catch (err) {
      console.error("[heartbeat] Failed to persist the completed-cycle count / last-completed-at timestamp.", err);
    }

    // Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): reuses the SAME
    // completed-cycle counter as the heartbeat above (one counter, two
    // independent cadences -- BACKUP_EVERY_N_CYCLES=48 vs HEARTBEAT_EVERY_N_CYCLES=12).
    // Must run BEFORE the heartbeat's own early return below, or a non-heartbeat
    // cycle would never reach it.
    if (shouldRunScheduledBackup(count)) {
      await runBackupIfDue("cycle");
    }

    if (!shouldSendHeartbeat(count)) return;

    const regime = productionStore.latestRegimeAssessment();
    let openPositions: number | "unknown" = "unknown";
    try {
      const portfolio = await getAlpacaPortfolio();
      openPositions = Array.isArray(portfolio.positions) ? portfolio.positions.length : "unknown";
    } catch (err) {
      console.error("[heartbeat] Failed to fetch open positions for the heartbeat message; reporting unknown.", err);
    }

    // Heartbeat is informational, NOT throttled by the 6h empty-sync alert
    // window (a separate channel class -- see alertThrottle.ts) -- it is
    // inherently non-repeating already (gated on the cycle counter crossing
    // a new multiple of HEARTBEAT_EVERY_N_CYCLES, not on elapsed time), so
    // there is no throttle state to check. It IS delivery-gated in the sense
    // that a failed/unconfigured send is only logged, never retried or
    // thrown -- an unconfigured Telegram must never spin the scheduler loop.
    const delivered = await sendTelegramAlert(
      appStore.getConfig().telegram,
      `💓 <b>Alive.</b> cycle ${count}, last regime ${regime?.marketMode ?? "unknown"}, open positions ${openPositions}.`,
    );
    if (!delivered) {
      console.log(`[heartbeat] Telegram not configured or the send failed; heartbeat for cycle ${count} was not delivered (informational only, no retry).`);
    }
  },
  // Phase 2 Task 12: missed-cycle watchdog. Invoked on scheduler.ts's own
  // independent WATCHDOG_CHECK_INTERVAL_MS timer (not the main tick chain --
  // see that constant's doc comment for why), so it can detect the main
  // cycle chain itself being stuck/dead, not just a failing cycle.
  checkWatchdog: async () => {
    const autoTradingOn = Boolean(appStore.getConfig().system?.autoTrading);
    if (!autoTradingOn) return;

    let lastCycleCompletedAtMs: number | undefined;
    try {
      const raw = productionStore.getAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY);
      const parsed = raw === undefined ? NaN : Number(raw);
      lastCycleCompletedAtMs = Number.isFinite(parsed) ? parsed : undefined;
    } catch (err) {
      console.error("[watchdog] Failed to read the last-completed-cycle timestamp; skipping this check.", err);
      return;
    }

    const intervalMinutes = resolveIntervalMinutes(appStore.getConfig().system?.runIntervalMins, (m) => console.log(m));
    const nowMs = Date.now();

    let alreadyAlertedGapStartMs: number | undefined;
    try {
      const raw = productionStore.getAppState(WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY);
      const parsed = raw === undefined ? NaN : Number(raw);
      alreadyAlertedGapStartMs = Number.isFinite(parsed) ? parsed : undefined;
    } catch (err) {
      console.error("[watchdog] Failed to read the already-alerted-gap marker; treating as no prior alert for this gap.", err);
    }

    if (!shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, intervalMinutes, alreadyAlertedGapStartMs)) return;

    const delivered = await sendTelegramAlert(
      appStore.getConfig().telegram,
      `⏰ <b>Scheduled cycle overdue.</b> No completed scheduled cycle in over ${MISSED_CYCLE_ALERT_MULTIPLIER}x the configured interval (${intervalMinutes}m). Last completed: ${lastCycleCompletedAtMs ? new Date(lastCycleCompletedAtMs).toISOString() : "never"}.`,
    );
    // Delivery-gated stamping (same pattern as the empty-sync alert throttle,
    // Task 1, and onAutoPause above): only a DELIVERED alert stamps the gap
    // as alerted. Stamping on a failed/unconfigured send would silently
    // suppress the one alert that matters once Telegram comes back -- worse
    // here than a time-based throttle, since an unstamped overdue gap stays
    // overdue (and gets retried) until a human notices, rather than
    // eventually re-opening on its own.
    if (delivered) {
      try {
        productionStore.setAppState(WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY, String(lastCycleCompletedAtMs));
      } catch (err) {
        console.error("[watchdog] Failed to persist the alerted-gap marker; may re-alert on the next check.", err);
      }
    }
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

// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// the one-time db.json -> SQLite migration (src/server/appStore.ts). Wired
// as a standalone function (not inlined in run()) for the same reason as
// performStartupReconciliation below -- tests invoke exactly this, with the
// real store/fs plumbing, without booting the rest of run(). Synchronous
// (migrateDbJsonIfNeeded does no I/O beyond fs/sqlite, both synchronous
// APIs) -- never throws (a migration failure degrades to clean defaults
// internally; see that function's doc comment).
function performDbJsonMigration(): ReturnType<typeof migrateDbJsonIfNeeded> {
  return migrateDbJsonIfNeeded(appStore, productionStore, DB_PATH);
}

// Test-visible manual trigger (same rationale as runScheduledSyncTickForTests
// above): runs exactly the real one-time migration on demand, without
// waiting for run() (which NODE_ENV=test never calls).
function runDbJsonMigrationForTests(): ReturnType<typeof migrateDbJsonIfNeeded> {
  return performDbJsonMigration();
}

// Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): the boot-time reconciliation
// step, wired here as a standalone async function (not inlined in run()) so
// tests can invoke exactly this -- with the real store/broker/Telegram
// plumbing -- without booting vite/the HTTP listener/process guards the rest
// of run() sets up. Mirrors runScheduledSyncTickForTests's existing pattern.
// Resolves once the FIRST reconciliation attempt completes; every retry after
// that runs in the background via the injected setTimer (see
// startupReconciliation.ts's runStartupReconciliation for why this never
// blocks server startup for the full retry budget).
async function performStartupReconciliation(): Promise<void> {
  const brokerConfig = getBrokerConfig();
  try {
    await runStartupReconciliation({
      brokerConfig,
      fetchImpl: fetch,
      // Same bounded window every other pollPendingOrders call site in this
      // file uses (productionStore.listTradeIntents(250)).
      listTrades: () => productionStore.listTradeIntents(250),
      saveTrade: (trade) => productionStore.saveTradeIntent(trade),
      cancelOrder: (orderId) => cancelAlpacaOrder(brokerConfig, orderId),
      // Straight to the durable SQLite store -- GET /api/audit reads straight
      // from productionStore.listAuditEvents(), so this alone is sufficient
      // for every audit-reading route/test to see these events.
      appendAuditEvents: (events) =>
        productionStore.appendAuditEvents(
          events.map((event) => ({
            id: `ae-startup-reconciliation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            actor: "startup_reconciliation",
            ...event,
          })),
        ),
      persistOrphans: (orphans) => productionStore.setAppState(STARTUP_ORPHANS_APP_STATE_KEY, JSON.stringify(orphans)),
      sendTelegramAlert: (message) => sendTelegramAlert(appStore.getConfig().telegram, message),
      log: (message) => console.log(message),
      setTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      },
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    });
  } catch (err: any) {
    // runStartupReconciliation is documented to never throw (every I/O path
    // inside it is caught) -- this is a defensive backstop only, so a bug in
    // that guarantee can never crash the boot sequence itself. tradingReady
    // simply stays at whatever it already was (false, on a fresh boot) --
    // fail closed.
    console.error("[startup-reconciliation] Unexpected error running startup reconciliation; BUY orders stay blocked.", err?.message || err);
  }
}

// Test-visible manual trigger (same rationale as runScheduledSyncTickForTests
// above): runs exactly the real boot-time reconciliation logic on demand,
// without waiting for run() (which NODE_ENV=test never calls).
async function runStartupReconciliationForTests(): Promise<void> {
  await performStartupReconciliation();
}

// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backups. All I/O
// is injected (backupEngine.ts's runBackup is otherwise pure/fully unit
// tested -- see tests/backupEngine.test.ts) so this object is the ONLY place
// server.ts's real fs/productionStore/Telegram calls meet the backup logic.
// Never throws (runBackup's own contract): both call sites below (boot, and
// the Nth-completed-cycle hook in the scheduler wiring further down) can
// `await` this directly.
const backupDeps: BackupDeps = {
  now: () => Date.now(),
  ensureBackupsDir: () => fs.mkdirSync(BACKUPS_DIR, { recursive: true }),
  backupSqliteTo: (filename) => productionStore.backupTo(path.join(BACKUPS_DIR, filename)),
  // Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
  // marker-aware. Pre-migration (marker absent), db.json is still live
  // interim state and rides along with every backup, same as Task 13. Once
  // the one-time migration has run, db.json is frozen legacy state -- copying
  // it into every future backup would be pointless (it never changes again)
  // and would misleadingly suggest it's still part of the current system of
  // record. Post-migration state lives fully in the SQLite backup; see
  // docs/OPS_RUNBOOK.md's restore-drill note.
  dbJsonExists: () => !productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY) && fs.existsSync(DB_PATH),
  copyDbJsonTo: (filename) => fs.copyFileSync(DB_PATH, path.join(BACKUPS_DIR, filename)),
  listBackupsDir: () => {
    try {
      return fs.readdirSync(BACKUPS_DIR);
    } catch (err: any) {
      // ENOENT (backups dir doesn't exist yet, e.g. very first boot before
      // ensureBackupsDir has ever run) is not a retention-pruning failure --
      // there is simply nothing to prune yet.
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  },
  deleteBackupFile: (filename) => fs.unlinkSync(path.join(BACKUPS_DIR, filename)),
  getAppState: (key) => productionStore.getAppState(key),
  setAppState: (key, value) => productionStore.setAppState(key, value),
  // Straight to the durable SQLite store, same rationale
  // performStartupReconciliation's appendAuditEvents dep above documents --
  // GET /api/audit reads straight from productionStore.listAuditEvents().
  appendAuditEvent: (message, details) =>
    productionStore.appendAuditEvents([{
      id: `ae-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      type: "backup",
      actor: "backup_engine",
      message,
      details,
    }]),
  sendAlert: (message) => sendTelegramAlert(appStore.getConfig().telegram, message),
  log: (message) => console.log(message),
};

async function runBackupIfDue(reason: "boot" | "cycle"): Promise<void> {
  await runBackup(reason, backupDeps);
}

// Test-visible manual trigger (same rationale as runStartupReconciliationForTests
// above): runs exactly one backup attempt against the real store/filesystem,
// without waiting for boot or 48 real scheduled cycles.
async function runBackupForTests(reason: "boot" | "cycle" = "boot"): Promise<{ ok: boolean }> {
  return runBackup(reason, backupDeps);
}

// Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5, guardrail 9): the boot-time
// crash-loop check. Pure decision logic lives in src/server/crashLoopGuard.ts;
// this owns the app_state reads/writes and the Telegram alert. Standalone
// (not inlined in run()) for the same reason as performStartupReconciliation
// above: tests invoke exactly this, with the real store/Telegram plumbing,
// without booting vite/the HTTP listener.
//
// Sequence per boot:
//   1. Read + CLEAR the clean-shutdown marker (one marker excuses exactly one
//      boot -- processGuards.ts writes it again on the next graceful shutdown).
//   2. Read restart_history, prune entries older than CRASH_LOOP_WINDOW_MS,
//      append this boot (unless excused by the marker), persist the pruned
//      list back (bounded -- item 3 of the task brief).
//   3. If CRASH_LOOP_MAX_BOOTS boots now sit inside the window: alert + tell
//      the caller to stay down. run() then exits with
//      CRASH_LOOP_STAY_DOWN_EXIT_CODE (0!) WITHOUT starting reconciliation,
//      the scheduler, or the HTTP server -- see that constant's comment in
//      crashLoopGuard.ts for why staying down REQUIRES a clean exit 0 under
//      docker-compose's `restart: on-failure`.
// Phase 2 Task 14 review fix 1: the crash-loop check above runs FIRST at boot
// -- deliberately BEFORE the one-time db.json -> SQLite migration (a crash
// loop caused by any later boot step, including a buggy migration itself,
// must still be caught). On a PRE-migration boot (marker absent) the SQLite
// config row doesn't exist yet: the Telegram config still lives in the
// legacy db.json, and reading only the store's clean defaults would make the
// crash-loop alert silently no-op exactly when an upgrading deployment
// crash-loops for the first time. This helper falls back to a tolerant,
// READ-ONLY db.json parse for that one window; any failure (missing/corrupt
// file, malformed shape) logs and proceeds with the store's config/defaults
// -- the alert path never blocks or changes the boot decision.
function telegramConfigForBootAlert(): AppConfig["telegram"] | undefined {
  try {
    if (!productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY) && fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8")) as { config?: { telegram?: AppConfig["telegram"] } };
      const telegram = parsed?.config?.telegram;
      if (telegram && typeof telegram === "object") return telegram;
    }
  } catch (err) {
    console.error("[crash-loop] Failed to read the legacy db.json telegram config for the boot alert; falling back to the store's config/defaults.", err);
  }
  return appStore.getConfig().telegram;
}

async function performCrashLoopBootCheck(): Promise<{ stayDown: boolean }> {
  let hadCleanShutdownMarker = false;
  try {
    hadCleanShutdownMarker = Boolean(productionStore.getAppState(CLEAN_SHUTDOWN_APP_STATE_KEY));
    if (hadCleanShutdownMarker) {
      // Clear immediately (empty string = no marker; app_state has no
      // delete): the marker excuses THIS boot only. If this boot then
      // crashes, the next boot must count normally.
      productionStore.setAppState(CLEAN_SHUTDOWN_APP_STATE_KEY, "");
    }
  } catch (err) {
    // Fail toward "no marker" (this boot counts): an unreadable marker must
    // not silently excuse boots from the crash window -- the marker is an
    // optimization for operators, the window is the safety control.
    console.error("[crash-loop] Failed to read/clear the clean-shutdown marker; treating this boot as counting toward the crash window.", err);
    hadCleanShutdownMarker = false;
  }

  let priorHistory: number[] = [];
  try {
    priorHistory = parseRestartHistory(productionStore.getAppState(RESTART_HISTORY_APP_STATE_KEY));
  } catch (err) {
    // parseRestartHistory itself never throws; this catches a failed
    // app_state READ. Fail open to an empty history (boot normally) -- see
    // crashLoopGuard.ts's parseRestartHistory doc comment for why the
    // breaker's own broken state must not stop the trading process.
    console.error("[crash-loop] Failed to read restart_history; treating as empty (boots normally).", err);
  }

  const decision = evaluateCrashLoopOnBoot(priorHistory, Date.now(), hadCleanShutdownMarker);

  try {
    productionStore.setAppState(RESTART_HISTORY_APP_STATE_KEY, JSON.stringify(decision.prunedHistory));
  } catch (err) {
    console.error("[crash-loop] Failed to persist restart_history; the next boot may undercount restarts.", err);
  }

  if (decision.crashLoopDetected) {
    console.error(
      `[crash-loop] ${decision.prunedHistory.length} boots within ${CRASH_LOOP_WINDOW_MS / 60_000} minutes (limit ${CRASH_LOOP_MAX_BOOTS}, guardrail 9). Staying down instead of thrashing; a human must restart deliberately (docker compose up -d). Positions remain protected by broker-native bracket orders.`,
    );
    // Unthrottled and delivery-gated only in the weak sense (a failed send is
    // logged, never retried -- the process is about to exit either way). No
    // throttle stamp to write: staying down IS the repeat-suppression.
    const delivered = await sendTelegramAlert(
      telegramConfigForBootAlert(),
      `🔁🛑 <b>Crash loop detected; staying down.</b> ${decision.prunedHistory.length} boots within 1 hour (limit ${CRASH_LOOP_MAX_BOOTS}). The process will NOT restart on its own (guardrail 9) -- investigate, then restart deliberately. Positions remain broker-protected by their bracket orders.`,
    );
    if (!delivered) {
      console.error("[crash-loop] Telegram alert could not be delivered (unconfigured or send failed); the log line above is the only signal.");
    }
    try {
      productionStore.appendAuditEvents([{
        id: `ae-crash-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: "config",
        actor: "crash_loop_guard",
        message: `Crash loop detected: ${decision.prunedHistory.length} boots within 1 hour (limit ${CRASH_LOOP_MAX_BOOTS}). Staying down without starting the scheduler or HTTP server.`,
        details: { bootTimestamps: decision.prunedHistory },
      }]);
    } catch (err) {
      console.error("[crash-loop] Failed to append the crash-loop audit event.", err);
    }
  }

  return { stayDown: decision.crashLoopDetected };
}

// Test-visible manual trigger (same rationale as runScheduledSyncTickForTests
// above): runs exactly the real boot-time crash-loop check on demand, without
// run() (which NODE_ENV=test never calls, and which would process.exit).
async function runCrashLoopBootCheckForTests(): Promise<{ stayDown: boolean }> {
  return performCrashLoopBootCheck();
}

// Test-visible manual trigger for the missed-cycle watchdog check (Phase 2
// Task 12): runs exactly one watchdog check directly, without waiting for the
// real WATCHDOG_CHECK_INTERVAL_MS timer (which only start() arms).
async function runWatchdogCheckForTests(): Promise<void> {
  await scheduler.checkWatchdogNow();
}

// Dev support or vite mounting
async function run() {
  // Phase 2 Task 12 (guardrail 9): the crash-loop check runs FIRST -- before
  // env validation, startup reconciliation, vite, the HTTP listener, the
  // scheduler. A crash-looping process must do the absolute minimum before
  // deciding whether it is allowed to keep booting (and a fatal-env crash
  // loop is still a crash loop -- each of those boots counts too, because
  // this check precedes the validateStartupEnv exit below).
  const crashLoopCheck = await performCrashLoopBootCheck();
  if (crashLoopCheck.stayDown) {
    // MUST exit 0 (CRASH_LOOP_STAY_DOWN_EXIT_CODE): docker-compose's
    // `restart: on-failure` restarts ANY non-zero exit, so a distinct
    // failure code (the brief's example 86) would be restarted forever and
    // guardrail 9 would never actually keep the process down. A clean exit
    // is the only "stay down" Docker understands under on-failure; the
    // Telegram alert sent above is the operator's signal. Full reasoning on
    // the constant in src/server/crashLoopGuard.ts.
    process.exit(CRASH_LOOP_STAY_DOWN_EXIT_CODE);
  }

  const startupIssues = validateStartupEnv(process.env);
  for (const issue of startupIssues) {
    const log = issue.level === "fatal" ? console.error : console.warn;
    log(`[startup:${issue.level}] ${issue.message}`);
  }
  if (startupIssues.some((issue) => issue.level === "fatal")) {
    console.error("[startup] Fatal configuration issues found. Refusing to start.");
    process.exit(1);
  }

  // Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
  // one-time db.json -> SQLite migration. Runs BEFORE startup reconciliation
  // (below) and everything after it -- every other boot step reads
  // config/trades/etc. through appStore, which must already reflect
  // migrated (or clean-default) state by the time anything else runs.
  // Idempotent (marker-gated); a no-op on every boot after the first.
  performDbJsonMigration();

  // Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation.
  // Runs BEFORE the HTTP server starts accepting connections and BEFORE
  // scheduler.start() -- store is already open (productionStore, module
  // scope, above) at this point. Skipped only implicitly: run() itself is
  // never called under NODE_ENV=test (see the bottom of this file), and
  // performStartupReconciliation's own runStartupReconciliation call treats
  // an unconfigured broker as "nothing to reconcile, ready immediately".
  await performStartupReconciliation();

  // Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): once at boot, post-
  // reconciliation -- see backupEngine.ts's doc comment for why this never
  // blocks/crashes startup even on failure.
  await runBackupIfDue("boot");

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
    // Phase 2 Task 12 (guardrail 9): a graceful SIGTERM/SIGINT shutdown
    // stamps the clean-shutdown marker so the NEXT boot's crash-loop check
    // (performCrashLoopBootCheck above) knows it wasn't a crash-recovery
    // boot. Synchronous SQLite write -- safe inside the shutdown path. NOT
    // written on uncaughtException/unhandledRejection (processGuards.ts
    // never calls this dep from those handlers): crashes must keep counting.
    markCleanShutdown: () => {
      try {
        productionStore.setAppState(CLEAN_SHUTDOWN_APP_STATE_KEY, new Date().toISOString());
      } catch (err) {
        // Fail toward "counts as a crash": the next boot will add to the
        // crash window unnecessarily, which at worst makes the breaker MORE
        // eager -- never less. Log so an operator can explain a surprising
        // stay-down after repeated clean restarts.
        console.error("[shutdown] Failed to persist the clean-shutdown marker; the next boot will count toward the crash-loop window.", err);
      }
    },
  });
}

export { app, appStore, productionStore, handleTelegramCommand, runScheduledSyncTickForTests, runStartupReconciliationForTests, runCrashLoopBootCheckForTests, runWatchdogCheckForTests, runBackupForTests, runDbJsonMigrationForTests };

if (process.env.NODE_ENV !== "test") {
  run();
}
