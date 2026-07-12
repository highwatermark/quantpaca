// Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation --
// boot safety so a crash mid-order can never lead to trading on unknown
// state.
//
// Before this module existed, run() (server.ts) started the HTTP server,
// Telegram poller, and scheduler immediately on boot -- nothing checked
// broker state first. An order this process accepted right before a crash
// could sit locally in a non-terminal state (or its terminal outcome be
// unknown entirely), and the scheduler could start placing NEW orders on top
// of that unknown state.
//
// This module owns two things:
//   1. A single boot-time reconciliation attempt (reusing Task 5's
//      pollPendingOrders -- see orderStatusPoller.ts -- rather than forking a
//      second polling implementation), plus a one-time orphan sweep
//      (GET /v2/orders?status=open, diffed against every locally known
//      brokerOrderId/clientOrderId/bracket-leg id). A crash-recovered fill is
//      the poller's normal job; an ORPHAN (an open broker order with no local
//      record at all -- e.g. a manual order, or a local record lost some
//      other way) is new: it is never auto-canceled (a human must decide --
//      it might be a legitimate manual order) and blocks new BUYs until an
//      admin reviews it (POST /api/reconciliation/orphans/clear).
//   2. `tradingReady`, a module-scoped flag gating order placement: false
//      until the FIRST reconciliation attempt succeeds, permanently
//      (per-process) true afterward. Sells are NEVER gated by this module --
//      de-risking always stays available, the same standing asymmetry every
//      other Phase 2 guardrail (market-hours gate, breaker, cooldown, PDT)
//      already encodes.
//
// Fail-closed on failure: a poll error or an orphan-sweep fetch failure never
// flips tradingReady true. runStartupReconciliation retries on a 5-minute
// timer (RECONCILIATION_RETRY_INTERVAL_MS) up to RECONCILIATION_MAX_RETRY_ATTEMPTS
// times, then gives up and alerts Telegram -- BUYs stay blocked until a
// restart. This module never blocks the HTTP server itself from starting:
// server.ts awaits only the FIRST attempt; every retry after that is
// scheduled via the injected setTimer and runs in the background.
import { AuditEvent, BrokerConfig, PipelineTrade } from "./tradingSafety";
import { pollPendingOrders } from "./orderStatusPoller";

// Named constant per the plan's binding rule (no env var -- the executor may
// not tune this, only the operator, via code).
export const RECONCILIATION_RETRY_INTERVAL_MS = 5 * 60_000;
// After this many consecutive failed attempts (poller error or orders-fetch
// failure), the retry loop gives up: BUYs stay blocked (sells still
// available) until the process is restarted. Named constant per the brief.
export const RECONCILIATION_MAX_RETRY_ATTEMPTS = 12;

// app_state (persistence.ts) key the persisted orphan list is stored under.
// Migration-safe: app_state is a generic key-value table, so this needs no
// schema change. The persisted copy is a record for admins/other routes to
// read across a restart; the OPERATIONAL gate (buyGateRejectionReason below)
// is driven by the in-memory module state, which a fresh boot repopulates by
// running a fresh orphan sweep -- see the module doc comment above.
export const STARTUP_ORPHANS_APP_STATE_KEY = "startup_reconciliation_orphans";

// One open broker order as returned by GET /v2/orders?status=open, narrowed
// to only the fields this module needs. `clientOrderId` is this system's own
// "qp-"-prefixed id (tradingSafety.ts's deriveClientOrderId) when the order
// was ours; undefined for a manually-placed order or one Alpaca reports
// without one.
export type OrphanOrder = {
  id: string;
  clientOrderId?: string;
  symbol?: string;
  qty?: string;
  side?: string;
  status?: string;
};

// Flat (non-discriminated-union) shape deliberately, same reasoning as
// orderStatusPoller.ts's BrokerOrderPollResult: this project's tsconfig does
// not enable strict/strictNullChecks, so a boolean-literal-discriminated
// union narrows unreliably across a branch here.
export type OpenOrdersFetchResult = {
  ok: boolean;
  orders?: OrphanOrder[];
  errorMessage?: string;
};

type AuditEventDraft = Pick<AuditEvent, "type" | "message" | "details" | "entityId">;

export type StartupReconciliationAttemptResult = {
  ok: boolean;
  polledCount: number;
  updatedCount: number;
  orphans: OrphanOrder[];
  logs: string[];
  errorLogs: string[];
  auditEvents: AuditEventDraft[];
};

export type StartupReconciliationDeps = {
  brokerConfig: BrokerConfig;
  fetchImpl: typeof fetch;
  // Bounded window of recent trades to consider -- same convention
  // server.ts's own per-cycle poll call already uses (productionStore.listTradeIntents(250)).
  listTrades: () => PipelineTrade[];
  saveTrade: (trade: PipelineTrade) => void;
  // Handed straight to pollPendingOrders -- see that module for why a stale
  // PartiallyFilled order's remainder may be canceled during a poll.
  cancelOrder: (orderId: string) => Promise<{ ok: boolean; status?: number }>;
  appendAuditEvents: (events: AuditEventDraft[]) => void;
  persistOrphans: (orphans: OrphanOrder[]) => void;
  sendTelegramAlert: (message: string) => Promise<unknown> | unknown;
  log: (message: string) => void;
  // Real setTimeout/clearTimeout in server.ts; a capturing fake in tests
  // (same pattern as scheduler.ts's SchedulerDeps) so the 5-minute retry
  // interval never has to be waited out for real in a test.
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Module-scoped gate state.
//
// `tradingReady` defaults OPEN (true) under NODE_ENV=test and CLOSED (false)
// otherwise. This is a deliberate, documented split, not an inconsistency
// with the plan's "default false" wording: run() (server.ts) -- and
// therefore this module's production wiring -- is itself never invoked under
// NODE_ENV=test (see the `if (process.env.NODE_ENV !== "test") { run(); }`
// guard at the bottom of server.ts), so a hard "always start false" default
// would permanently block every BUY in every one of this codebase's ~40
// existing integration test files, none of which call
// runStartupReconciliation. Defaulting OPEN under NODE_ENV=test preserves
// their behavior; a test that specifically wants to exercise the
// BLOCKED/orphaned path uses the exported __setStateForTest hook below (never
// referenced by production code) to force it closed first.
let tradingReady = process.env.NODE_ENV === "test";
let orphanOrders: OrphanOrder[] = [];
let retryTimerHandle: unknown = null;

export function isTradingReady(): boolean {
  return tradingReady;
}

export function getOrphanOrders(): OrphanOrder[] {
  return orphanOrders.slice();
}

export function hasUnresolvedOrphans(): boolean {
  return orphanOrders.length > 0;
}

// The single chokepoint executeTradeIntent (server.ts) consults. Always
// undefined for a sell -- de-risking is never gated by this module. For a
// buy: undefined only once reconciliation has completed AND no unresolved
// orphan remains; otherwise an honest, specific reason string (surfaced the
// same way every other RiskDecision "rejected" reason already is, e.g. the
// market-hours gate).
export function buyGateRejectionReason(side: "buy" | "sell"): string | undefined {
  if (side !== "buy") return undefined;
  if (!tradingReady) {
    return "Startup reconciliation pending; BUY orders are blocked until it completes (sells remain available).";
  }
  if (orphanOrders.length > 0) {
    return `${orphanOrders.length} unresolved orphan broker order(s) found at startup reconciliation; BUY orders stay blocked until an admin reviews and clears them (POST /api/reconciliation/orphans/clear).`;
  }
  return undefined;
}

// POST /api/reconciliation/orphans/clear (server.ts) calls this after
// requireAdminCommand authorizes the request. Clearing means a human has
// REVIEWED the orphan broker order(s) and judged it safe to resume BUYs -- it
// does NOT cancel, modify, or otherwise resolve the underlying broker
// order(s), which are left exactly as they were (never auto-canceled, per the
// plan's binding rule: a human decides, since an orphan might be a legitimate
// manual order). If the same order is still open and still unmatched at the
// next boot, a fresh reconciliation sweep will flag it again.
export function clearOrphans(): OrphanOrder[] {
  const cleared = orphanOrders;
  orphanOrders = [];
  return cleared;
}

// Test-only hook. See the `tradingReady` doc comment above for why the
// default needs forcing in a test that wants the BLOCKED/orphaned path.
// Never called from production wiring.
export function __setStateForTest(state: { tradingReady?: boolean; orphanOrders?: OrphanOrder[] }): void {
  if (state.tradingReady !== undefined) tradingReady = state.tradingReady;
  if (state.orphanOrders !== undefined) orphanOrders = state.orphanOrders;
}

// ---------------------------------------------------------------------------
// Orphan detection (pure) + open-orders fetch (I/O, injected fetchImpl)
// ---------------------------------------------------------------------------

// Any open broker order whose id AND client_order_id both fail to match a
// known local trade (its own brokerOrderId/clientOrderId, or one of its
// bracket leg ids) is an orphan. This system's own orders always carry a
// "qp-"-prefixed client_order_id (tradingSafety.ts's deriveClientOrderId);
// an order that doesn't match by either field is orphaned regardless of
// whether its own client_order_id happens to look like one of ours.
export function detectOrphanOrders(openOrders: OrphanOrder[], localTrades: PipelineTrade[]): OrphanOrder[] {
  const knownOrderIds = new Set<string>();
  const knownClientOrderIds = new Set<string>();
  for (const trade of localTrades) {
    if (trade.brokerOrderId) knownOrderIds.add(trade.brokerOrderId);
    if (trade.clientOrderId) knownClientOrderIds.add(trade.clientOrderId);
    for (const legId of trade.brokerLegOrderIds || []) knownOrderIds.add(legId);
  }
  return openOrders.filter((order) => {
    const matchedById = order.id ? knownOrderIds.has(order.id) : false;
    const matchedByClientId = order.clientOrderId ? knownClientOrderIds.has(order.clientOrderId) : false;
    return !matchedById && !matchedByClientId;
  });
}

// GET /v2/orders?status=open. Never throws -- any network error, non-OK
// response, or a response that isn't an array resolves to `ok: false` so the
// caller can fail closed (see attemptStartupReconciliation below) instead of
// treating a malformed/absent response as "zero open orders" (which would
// silently hide real orphans).
export async function fetchOpenBrokerOrders(input: {
  brokerConfig: BrokerConfig;
  fetchImpl: typeof fetch;
}): Promise<OpenOrdersFetchResult> {
  try {
    const headers = {
      "APCA-API-KEY-ID": input.brokerConfig.apiKey || "",
      "APCA-API-SECRET-KEY": input.brokerConfig.secretKey || "",
      "Content-Type": "application/json",
    };
    const res = await input.fetchImpl(`${input.brokerConfig.baseUrl}/orders?status=open`, { headers });
    if (!res.ok) return { ok: false, errorMessage: `GET /orders?status=open responded with ${res.status}` };
    const body = await res.json();
    if (!Array.isArray(body)) return { ok: false, errorMessage: "GET /orders?status=open did not return an array" };
    return {
      ok: true,
      orders: body.map((order: any) => ({
        id: String(order.id),
        clientOrderId: typeof order.client_order_id === "string" ? order.client_order_id : undefined,
        symbol: typeof order.symbol === "string" ? order.symbol : undefined,
        qty: typeof order.qty === "string" ? order.qty : undefined,
        side: typeof order.side === "string" ? order.side : undefined,
        status: typeof order.status === "string" ? order.status : undefined,
      })),
    };
  } catch (err: any) {
    return { ok: false, errorMessage: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// A single reconciliation attempt (I/O, no module-state mutation -- purely
// returns what happened so runStartupReconciliation below can decide what to
// do with it). Directly unit-testable without touching tradingReady/orphanOrders.
// ---------------------------------------------------------------------------

export async function attemptStartupReconciliation(
  deps: Pick<StartupReconciliationDeps, "brokerConfig" | "fetchImpl" | "listTrades" | "saveTrade" | "cancelOrder" | "now">,
): Promise<StartupReconciliationAttemptResult> {
  let pollResult;
  try {
    pollResult = await pollPendingOrders({
      trades: deps.listTrades(),
      brokerConfig: deps.brokerConfig,
      fetchImpl: deps.fetchImpl,
      cancelOrder: deps.cancelOrder,
      saveTrade: deps.saveTrade,
      now: deps.now,
    });
  } catch (err: any) {
    // pollPendingOrders is documented to never throw; this is a defensive
    // backstop only (mirrors the try/catch already around every other
    // pollPendingOrders call site in server.ts).
    return {
      ok: false,
      polledCount: 0,
      updatedCount: 0,
      orphans: [],
      logs: [],
      errorLogs: [`[startup-reconciliation] Order-status poll threw unexpectedly: ${err?.message || String(err)}.`],
      auditEvents: [],
    };
  }

  const openOrdersResult = await fetchOpenBrokerOrders({ brokerConfig: deps.brokerConfig, fetchImpl: deps.fetchImpl });
  // "M updated": every trade_state transition the poll actually produced
  // (previousStatus !== mapped -- see applyTradePollResult), not merely every
  // order it looked at.
  const updatedCount = pollResult.auditEvents.filter((event) => event.type === "trade_state" && event.toState !== undefined).length;
  // Fail closed on EITHER half of this attempt: a per-order poll failure
  // (pollResult.errorLogs non-empty -- "poller error" in the brief's wording)
  // or the orphan-sweep fetch itself failing both mean this attempt could not
  // establish a trustworthy picture of broker state, so the whole attempt is
  // treated as failed -- stricter than the ONGOING per-cycle poller (which
  // tolerates an individual order's poll failure without failing the cycle),
  // deliberately: this is the ONE boot-time check trading readiness hinges
  // on, not a routine background refresh.
  const pollOk = pollResult.errorLogs.length === 0;

  if (!pollOk || !openOrdersResult.ok) {
    const errorLogs = [...pollResult.errorLogs];
    if (!openOrdersResult.ok) {
      errorLogs.push(`[startup-reconciliation] Open-orders fetch failed: ${openOrdersResult.errorMessage}.`);
    }
    return {
      ok: false,
      polledCount: pollResult.polledCount,
      updatedCount,
      orphans: [],
      logs: pollResult.logs,
      errorLogs,
      auditEvents: pollResult.auditEvents,
    };
  }

  // Re-read trades after the poll's saveTrade calls so orphan matching sees
  // the freshest known brokerOrderId/clientOrderId set (the poll itself never
  // adds a new one, but this keeps the two steps decoupled/order-independent
  // rather than relying on that fact).
  const orphans = detectOrphanOrders(openOrdersResult.orders || [], deps.listTrades());

  return {
    ok: true,
    polledCount: pollResult.polledCount,
    updatedCount,
    orphans,
    logs: pollResult.logs,
    errorLogs: [],
    auditEvents: pollResult.auditEvents,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator: one boot-time call, retries scheduled in the background.
// ---------------------------------------------------------------------------

// Called once from server.ts's run(), BEFORE the HTTP server starts
// listening and BEFORE scheduler.start(). Resolves once the FIRST attempt
// completes (success or failure) -- never blocks on the retry chain, which
// runs entirely via the injected setTimer after this promise has resolved.
export async function runStartupReconciliation(deps: StartupReconciliationDeps): Promise<void> {
  if (retryTimerHandle !== null) {
    deps.clearTimer(retryTimerHandle);
    retryTimerHandle = null;
  }

  if (!deps.brokerConfig.configured) {
    // Dry-run/simulated mode: there is no broker to reconcile against, so
    // there is nothing to be unsafe about. Matches the rest of this
    // codebase's convention for an unconfigured broker (e.g.
    // pollPendingOrders itself no-ops the same way).
    tradingReady = true;
    orphanOrders = [];
    deps.log("[startup-reconciliation] Skipped: broker not configured (dry-run/simulated mode); trading is immediately ready (nothing to reconcile against).");
    return;
  }

  await attemptWithRetry(deps, 1);
}

async function attemptWithRetry(deps: StartupReconciliationDeps, attemptNumber: number): Promise<void> {
  const result = await attemptStartupReconciliation(deps);
  for (const line of result.logs) deps.log(line);
  for (const line of result.errorLogs) deps.log(line);
  if (result.auditEvents.length) deps.appendAuditEvents(result.auditEvents);

  if (!result.ok) {
    if (attemptNumber >= RECONCILIATION_MAX_RETRY_ATTEMPTS) {
      const message = `[startup-reconciliation] Failed after ${attemptNumber} attempts; giving up -- BUY orders stay blocked until the process is restarted. Sells remain available.`;
      deps.log(message);
      deps.appendAuditEvents([{ type: "sync", message, details: { attempts: attemptNumber } }]);
      await deps.sendTelegramAlert(
        `⚠️ Startup reconciliation FAILED after ${RECONCILIATION_MAX_RETRY_ATTEMPTS} attempts. New BUY orders remain blocked (sells still available) until a restart once the broker connection is healthy.`,
      );
      return;
    }
    const retryMinutes = RECONCILIATION_RETRY_INTERVAL_MS / 60_000;
    deps.log(
      `[startup-reconciliation] Attempt ${attemptNumber}/${RECONCILIATION_MAX_RETRY_ATTEMPTS} failed; retrying in ${retryMinutes} minutes.`,
    );
    retryTimerHandle = deps.setTimer(() => {
      void attemptWithRetry(deps, attemptNumber + 1);
    }, RECONCILIATION_RETRY_INTERVAL_MS);
    return;
  }

  orphanOrders = result.orphans;
  deps.persistOrphans(result.orphans);
  tradingReady = true;

  const summary = `startup reconciliation complete: ${result.polledCount} orders polled, ${result.updatedCount} updated, ${result.orphans.length} orphans.`;
  deps.log(`[startup-reconciliation] ${summary}`);
  deps.appendAuditEvents([
    {
      type: "sync",
      message: summary,
      details: { polledCount: result.polledCount, updatedCount: result.updatedCount, orphanCount: result.orphans.length },
    },
  ]);

  if (result.orphans.length > 0) {
    deps.appendAuditEvents(
      result.orphans.map((orphan) => ({
        type: "broker" as const,
        message: `Orphan broker order detected at startup: ${orphan.id}${orphan.symbol ? ` (${orphan.symbol})` : ""} -- no matching local trade record. BUY orders are blocked until an admin reviews and clears it.`,
        details: {
          orphanOrderId: orphan.id,
          clientOrderId: orphan.clientOrderId,
          symbol: orphan.symbol,
          qty: orphan.qty,
          side: orphan.side,
          status: orphan.status,
        },
      })),
    );
    await deps.sendTelegramAlert(
      `⚠️ Startup reconciliation found ${result.orphans.length} orphan broker order(s) with no matching local trade record. New BUY orders are blocked until an admin reviews and runs POST /api/reconciliation/orphans/clear.`,
    );
  }
}
