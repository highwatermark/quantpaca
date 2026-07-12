// Phase 2 Task 5 (docs/GO_LIVE_PLAN.md Phase 2.2): order-status polling +
// partial-fill handling.
//
// Before this module existed, a trade's broker status was read exactly ONCE,
// at submission time (tradingSafety.ts submitTradeThroughPipeline), and never
// re-checked. A bracket's take_profit/stop_loss child legs (Task 4) were
// persisted but never re-checked either -- a filled stop leg was invisible to
// the rest of the system, and a leg that had already gone terminal at the
// broker made cancelBracketLegsBeforeSell (server.ts) DELETE against it
// forever (bracket-orders review finding 2).
//
// This module is intentionally pure/I-O-light and split the same way
// exitMonitor.ts and marketDataFetcher.ts are: the DECISION logic
// (selectPollTargets, applyTradePollResult, applyLegPollResult) takes no fetch
// handle and is unit-testable in isolation; fetchBrokerOrder and the
// pollPendingOrders orchestrator are the only pieces that touch the network,
// and take an injected fetchImpl so tests can supply a mock broker exactly
// like the rest of this codebase does.
//
// Every status mapping in this module goes through tradingSafety.ts's
// mapBrokerStatusToTradeState -- there is deliberately no second/forked
// mapping here (the plan's explicit constraint; see reconciliationEngine.ts's
// pre-existing normalizeStatus for the anti-pattern this avoids repeating).
import { AuditEvent, mapBrokerStatusToTradeState, PipelineTrade, TradeState } from "./tradingSafety";
import { parseFiniteNumber } from "./numericSafety";

// Bounded per-cycle poll budget (plan requirement: "max 25 orders/cycle").
export const MAX_ORDERS_PER_POLL_CYCLE = 25;

// A PartiallyFilled trade older than this (measured from the local trade's
// own submission timestamp -- see applyTradePollResult) has its unfilled
// remainder canceled rather than left open indefinitely. Named constant per
// the brief.
export const PARTIAL_FILL_MAX_AGE_MIN = 30;

// Allowlist (NOT a blocklist) of local trade states this poller will keep
// checking against the broker. Deliberately explicit rather than "every state
// that isn't terminal": a state added to the TradeState union later (e.g. a
// new pre-broker rejection variant) must be a conscious opt-in here, not
// silently polled (or silently skipped) by construction. "BrokerSubmitted" is
// included defensively for a row that was persisted mid-submission (e.g. a
// process death between the broker call and the final state being written) --
// submitTradeThroughPipeline itself never returns a trade parked in that
// state on the happy path, but a stale one should still get picked back up
// rather than orphaned forever. UnknownBrokerState is deliberately EXCLUDED:
// it already means "the broker told us something we can't map", and without a
// documented reason to believe a re-poll would resolve to something
// different, continuing to hammer that order isn't obviously useful --
// revisit if that assumption turns out wrong.
export const POLLABLE_TRADE_STATES: ReadonlySet<TradeState> = new Set([
  "BrokerSubmitted",
  "Accepted",
  "PartiallyFilled",
]);

// States the broker will never revise further once reported. Used both to
// decide which of a trade's OWN status and which of its bracket LEGS still
// need polling, and (via isTerminalTradeState) by cancelBracketLegsBeforeSell
// (server.ts) to decide whether a leg needs a DELETE at all.
export const TERMINAL_TRADE_STATES: ReadonlySet<TradeState> = new Set([
  "Filled",
  "Rejected",
  "Canceled",
  "Expired",
]);

export function isTerminalTradeState(state: TradeState | string | undefined): boolean {
  return TERMINAL_TRADE_STATES.has(state as TradeState);
}

// ---------------------------------------------------------------------------
// Target selection (pure)
// ---------------------------------------------------------------------------

export type PollTarget = {
  kind: "trade" | "leg";
  tradeId: string;
  orderId: string;
  timestamp: string;
};

// Enumerates every order (a trade's own entry order, or one of its bracket
// legs) that still needs a broker check this cycle, oldest-first, capped at
// `maxOrders`. Pure: no I/O, so the cap/ordering behavior is directly
// unit-testable without a mock broker.
export function selectPollTargets(
  trades: PipelineTrade[],
  maxOrders: number = MAX_ORDERS_PER_POLL_CYCLE,
): { targets: PollTarget[]; capped: boolean; totalCandidates: number } {
  const candidates: PollTarget[] = [];

  for (const trade of trades) {
    if (trade.brokerOrderId && POLLABLE_TRADE_STATES.has(trade.status)) {
      candidates.push({ kind: "trade", tradeId: trade.id, orderId: trade.brokerOrderId, timestamp: trade.timestamp });
    }
    const legIds = Array.isArray(trade.brokerLegOrderIds) ? trade.brokerLegOrderIds : [];
    if (legIds.length === 0) continue;
    const legStates = trade.brokerLegStates || {};
    for (const legId of legIds) {
      const known = legStates[legId];
      // "aren't known-terminal" (plan wording): a leg with no recorded state
      // yet, or a recorded NON-terminal state, is still a candidate. Only a
      // recorded terminal state removes it from the pollable set.
      if (known && isTerminalTradeState(known)) continue;
      candidates.push({ kind: "leg", tradeId: trade.id, orderId: legId, timestamp: trade.timestamp });
    }
  }

  candidates.sort((a, b) => sortableTime(a.timestamp) - sortableTime(b.timestamp));
  const capped = candidates.length > maxOrders;
  return { targets: candidates.slice(0, maxOrders), capped, totalCandidates: candidates.length };
}

function sortableTime(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  // An unparsable timestamp sorts as "oldest" (0) rather than crashing the
  // sort or landing unpredictably -- fail toward polling it sooner, not later.
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Broker fetch (I/O, injected fetchImpl)
// ---------------------------------------------------------------------------

// Flat (non-discriminated-union) shape deliberately -- this project's
// tsconfig does not enable strict/strictNullChecks, and TypeScript's
// control-flow narrowing of a boolean-literal-discriminated union (`ok: true`
// vs `ok: false`) across a branch is unreliable without it (same pitfall
// documented on bracketOrders.ts's BracketLegsResult and exitMonitor.ts's
// PlanValidation -- this sidesteps it the same way). `errorMessage` is only
// ever populated when `ok` is false; every field is present-or-undefined
// regardless of `ok`, so callers narrow via an early return/continue on `ok`
// and then just read whichever fields they need.
export type BrokerOrderPollResult = {
  ok: boolean;
  status?: string;
  filledQty?: number;
  filledAvgPrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  orderType?: string;
  errorMessage?: string;
};

type BrokerConfigLike = {
  configured: boolean;
  baseUrl: string;
  apiKey?: string;
  secretKey?: string;
};

// GET /v2/orders/{id}. Never throws -- any network error, non-OK response, or
// a response that doesn't even look like a single order object (e.g. an
// array -- some list endpoints share the `/orders` path prefix) resolves to
// `ok: false` so the caller can fail closed ("never invent a fill") instead of
// mapping garbage into a TradeState.
export async function fetchBrokerOrder(input: {
  brokerConfig: BrokerConfigLike;
  orderId: string;
  fetchImpl: typeof fetch;
}): Promise<BrokerOrderPollResult> {
  try {
    const headers = {
      "APCA-API-KEY-ID": input.brokerConfig.apiKey || "",
      "APCA-API-SECRET-KEY": input.brokerConfig.secretKey || "",
      "Content-Type": "application/json",
    };
    const res = await input.fetchImpl(`${input.brokerConfig.baseUrl}/orders/${encodeURIComponent(input.orderId)}`, { headers });
    if (!res.ok) return { ok: false, errorMessage: `GET /orders/${input.orderId} responded with ${res.status}` };
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, errorMessage: `GET /orders/${input.orderId} did not return a single order object` };
    }
    const filledQtyParsed = parseFiniteNumber((body as any).filled_qty, "filled_qty");
    const filledAvgPriceParsed = parseFiniteNumber((body as any).filled_avg_price, "filled_avg_price");
    const limitPriceParsed = parseFiniteNumber((body as any).limit_price, "limit_price");
    const stopPriceParsed = parseFiniteNumber((body as any).stop_price, "stop_price");
    return {
      ok: true,
      status: typeof (body as any).status === "string" ? (body as any).status : undefined,
      filledQty: filledQtyParsed.ok ? filledQtyParsed.value : undefined,
      filledAvgPrice: filledAvgPriceParsed.ok ? filledAvgPriceParsed.value : undefined,
      limitPrice: limitPriceParsed.ok ? limitPriceParsed.value : undefined,
      stopPrice: stopPriceParsed.ok ? stopPriceParsed.value : undefined,
      orderType: typeof (body as any).type === "string" ? (body as any).type : undefined,
    };
  } catch (err: any) {
    return { ok: false, errorMessage: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Apply a poll result to a trade (pure -- returns a new trade + audit facts,
// mutates nothing in place)
// ---------------------------------------------------------------------------

type PartialAuditEvent = Pick<AuditEvent, "type" | "message" | "details" | "entityId" | "fromState" | "toState">;

export type TradePollOutcome = {
  trade: PipelineTrade;
  auditEvents: PartialAuditEvent[];
  // True when this poll found the trade still PartiallyFilled and old enough
  // (PARTIAL_FILL_MAX_AGE_MIN) that its remainder should be canceled. The
  // caller (pollPendingOrders below, or a direct unit test) is responsible for
  // actually issuing the cancel -- this function performs no I/O.
  shouldCancelStalePartial: boolean;
};

// Callers are expected to only invoke this once `poll.ok` has been confirmed
// true (see pollPendingOrders below) -- a fetch failure/timeout never reaches
// here, so a non-fill can never be invented. State only ever advances via a
// value that came straight from the broker.
export function applyTradePollResult(
  trade: PipelineTrade,
  poll: BrokerOrderPollResult,
  now: () => Date,
): TradePollOutcome {
  const mapped = mapBrokerStatusToTradeState(poll.status);
  const previousStatus = trade.status;
  const updated: PipelineTrade = { ...trade, status: mapped, brokerStatus: poll.status, lastPollError: undefined };
  const auditEvents: PartialAuditEvent[] = [];

  if (mapped === "PartiallyFilled" || mapped === "Filled") {
    const filledQty = poll.filledQty ?? 0;
    const requestedQty = typeof trade.qty === "number" ? trade.qty : 0;
    const remainingQty = Math.max(0, requestedQty - filledQty);
    const quantitiesChanged = trade.filledQty !== filledQty || trade.remainingQty !== remainingQty;
    updated.filledQty = filledQty;
    updated.remainingQty = remainingQty;

    if (mapped === "PartiallyFilled" && (previousStatus !== mapped || quantitiesChanged)) {
      auditEvents.push({
        type: "trade_state",
        entityId: trade.id,
        message: `Partial fill for ${trade.symbol}: ${filledQty}/${requestedQty} filled, ${remainingQty} remaining.`,
        details: { symbol: trade.symbol, tradeId: trade.id, filledQty, remainingQty, requestedQty },
      });
    }
  }

  if (previousStatus !== mapped) {
    auditEvents.push({
      type: "trade_state",
      entityId: trade.id,
      fromState: previousStatus,
      toState: mapped,
      message: `Order status poll: ${trade.symbol} ${previousStatus} -> ${mapped} (broker status ${poll.status || "unknown"}).`,
      details: { symbol: trade.symbol, tradeId: trade.id, brokerOrderId: trade.brokerOrderId },
    });
  }

  let shouldCancelStalePartial = false;
  if (mapped === "PartiallyFilled") {
    const ageMs = now().getTime() - Date.parse(trade.timestamp);
    if (Number.isFinite(ageMs) && ageMs > PARTIAL_FILL_MAX_AGE_MIN * 60_000) {
      shouldCancelStalePartial = true;
    }
  }

  return { trade: updated, auditEvents, shouldCancelStalePartial };
}

export type LegPollOutcome = {
  trade: PipelineTrade;
  auditEvents: PartialAuditEvent[];
  becameTerminal: boolean;
  legMappedState: TradeState;
};

// Applies a leg's poll result onto its OWNING (entry) trade -- brokerLegStates
// is a field on the entry trade, not a separate record. Used both by the main
// poll loop below AND by cancelBracketLegsBeforeSell's (server.ts) single-leg
// re-poll after a 422 "not cancelable" response (bracket-orders review
// finding 2) -- one code path for "what does a leg poll result mean", reused
// by both callers.
export function applyLegPollResult(
  trade: PipelineTrade,
  legId: string,
  poll: BrokerOrderPollResult,
  now: () => Date,
): LegPollOutcome {
  const mapped = mapBrokerStatusToTradeState(poll.status);
  const updated: PipelineTrade = {
    ...trade,
    brokerLegStates: { ...(trade.brokerLegStates || {}), [legId]: mapped },
  };
  const auditEvents: PartialAuditEvent[] = [];

  if (mapped === "Filled") {
    // Alpaca's own leg `type` distinguishes take-profit (a limit order) from
    // stop-loss (a stop order) -- no separate persisted "which leg is which"
    // bookkeeping needed, the broker's response already carries it.
    const legType = poll.orderType === "limit" ? "take-profit" : poll.orderType === "stop" ? "stop-loss" : "leg";
    const price = poll.filledAvgPrice ?? poll.limitPrice ?? poll.stopPrice;
    updated.exitClosedBrokerSide = { legId, legType, price, at: now().toISOString() };
    auditEvents.push({
      type: "broker",
      entityId: trade.id,
      message: `broker-side exit filled: ${legType} @ ${price !== undefined ? price : "unknown price"} (${trade.symbol})`,
      details: { symbol: trade.symbol, tradeId: trade.id, legId, legType, price },
    });
  }

  return { trade: updated, auditEvents, becameTerminal: isTerminalTradeState(mapped), legMappedState: mapped };
}

// ---------------------------------------------------------------------------
// Orchestrator (I/O: fetch + injected cancel/save callbacks)
// ---------------------------------------------------------------------------

export type PollCycleResult = {
  // Informational sync-log lines (addLog("sync", ...) in server.ts).
  logs: string[];
  // Failure sync-log lines (addLog("error", ...) in server.ts).
  errorLogs: string[];
  auditEvents: PartialAuditEvent[];
  polledCount: number;
  totalCandidates: number;
  capped: boolean;
};

export async function pollPendingOrders(input: {
  trades: PipelineTrade[];
  brokerConfig: BrokerConfigLike;
  fetchImpl: typeof fetch;
  now?: () => Date;
  // Cancels one broker order (DELETE /v2/orders/{id}). Injected so this
  // module never needs to know how the broker call is authenticated/shaped --
  // server.ts passes its existing cancelAlpacaOrder here, so there is exactly
  // one cancel implementation in the codebase.
  cancelOrder: (orderId: string) => Promise<{ ok: boolean; status?: number }>;
  saveTrade: (trade: PipelineTrade) => void;
  maxOrders?: number;
}): Promise<PollCycleResult> {
  const now = input.now || (() => new Date());
  const logs: string[] = [];
  const errorLogs: string[] = [];
  const auditEvents: PartialAuditEvent[] = [];

  if (!input.brokerConfig.configured) {
    return { logs, errorLogs, auditEvents, polledCount: 0, totalCandidates: 0, capped: false };
  }

  const { targets, capped, totalCandidates } = selectPollTargets(input.trades, input.maxOrders ?? MAX_ORDERS_PER_POLL_CYCLE);
  if (targets.length === 0) {
    return { logs, errorLogs, auditEvents, polledCount: 0, totalCandidates, capped: false };
  }

  if (capped) {
    const message = `Order-status poll capped: ${totalCandidates} pending orders, ${targets.length} polled this cycle (oldest first).`;
    logs.push(message);
    auditEvents.push({ type: "broker", message, details: { totalCandidates, polled: targets.length } });
  }

  // Working set of trades, keyed by id, so multiple targets belonging to the
  // same trade (its own order AND one or more legs) accumulate onto one
  // in-memory copy before a single saveTrade call -- otherwise a later
  // saveTrade for the same trade id could clobber an earlier target's update
  // with a stale read.
  const working = new Map<string, PipelineTrade>();
  const touched = new Set<string>();
  for (const trade of input.trades) working.set(trade.id, trade);

  for (const target of targets) {
    const trade = working.get(target.tradeId);
    if (!trade) continue;

    const poll = await fetchBrokerOrder({ brokerConfig: input.brokerConfig, orderId: target.orderId, fetchImpl: input.fetchImpl });

    if (!poll.ok) {
      // "Never invent a fill": state is left exactly as it was. Only the
      // poll-error marker changes.
      const message = `Order-status poll failed for ${trade.symbol} (${target.kind} order ${target.orderId}): ${poll.errorMessage}. State unchanged (${trade.status}).`;
      errorLogs.push(message);
      working.set(trade.id, { ...trade, lastPollError: poll.errorMessage });
      touched.add(trade.id);
      continue;
    }

    if (target.kind === "trade") {
      const outcome = applyTradePollResult(trade, poll, now);
      let finalTrade = outcome.trade;
      auditEvents.push(...outcome.auditEvents);

      if (outcome.shouldCancelStalePartial && finalTrade.brokerOrderId) {
        const cancelResult = await input.cancelOrder(finalTrade.brokerOrderId);
        if (cancelResult.ok) {
          const filledQty = finalTrade.filledQty ?? 0;
          const message = `Partial fill for ${finalTrade.symbol} older than ${PARTIAL_FILL_MAX_AGE_MIN} min; remainder canceled (filled ${filledQty}/${finalTrade.qty}). Position size adjusted to ${filledQty} shares; confirmation follows on the next poll.`;
          logs.push(message);
          auditEvents.push({
            type: "broker",
            entityId: finalTrade.id,
            message,
            details: { symbol: finalTrade.symbol, tradeId: finalTrade.id, filledQty, requestedQty: finalTrade.qty },
          });
          // The filled portion keeps its exit plan; qty/remaining are adjusted
          // to the confirmed filled amount now that no more of this order
          // will ever fill (we've just requested cancellation of the rest).
          // The trade's own `status` is left as PartiallyFilled -- untouched
          // until a future poll confirms the broker's canonical Canceled
          // state ("poll confirms", never invented here).
          finalTrade = { ...finalTrade, qty: filledQty, remainingQty: 0 };
        } else {
          const message = `Failed to cancel the stale partial-fill remainder for ${finalTrade.symbol} (order ${finalTrade.brokerOrderId}${cancelResult.status ? `, broker status ${cancelResult.status}` : ""}).`;
          errorLogs.push(message);
          auditEvents.push({
            type: "broker",
            entityId: finalTrade.id,
            message,
            details: { symbol: finalTrade.symbol, tradeId: finalTrade.id, brokerOrderId: finalTrade.brokerOrderId, status: cancelResult.status },
          });
        }
      }

      working.set(finalTrade.id, finalTrade);
      touched.add(finalTrade.id);
    } else {
      const outcome = applyLegPollResult(trade, target.orderId, poll, now);
      auditEvents.push(...outcome.auditEvents);
      working.set(outcome.trade.id, outcome.trade);
      touched.add(outcome.trade.id);
    }
  }

  for (const tradeId of touched) {
    const trade = working.get(tradeId);
    if (trade) input.saveTrade(trade);
  }

  return { logs, errorLogs, auditEvents, polledCount: targets.length, totalCandidates, capped };
}
