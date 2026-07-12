// Latches breakerEngine.ts's tripped status (block_new_buys / close_only) across
// evaluations, so a bounce back above threshold does not silently re-enable buys
// mid-drawdown (docs/GO_LIVE_PLAN.md Phase 1.4, "Latch the breaker"). This module is
// deliberately additive: it never touches evaluateBreaker's threshold math, it only
// wraps its output. Once latched, the effective status can only escalate
// (block_new_buys -> close_only) until an explicit admin reset clears the latch and
// re-evaluates fresh -- see applyBreakerLatch's callers in server.ts.
import { BreakerState, BreakerStatus } from "./breakerEngine";

export interface BreakerLatchState {
  latched: boolean;
  // Meaningful only when latched === true; "ok" otherwise (never persisted latched
  // with status "ok" -- see isValidLatchState).
  latchedStatus: BreakerStatus;
  latchedAt: string | null;
  latchedReasons: string[];
}

export const UNLATCHED_STATE: BreakerLatchState = {
  latched: false,
  latchedStatus: "ok",
  latchedAt: null,
  latchedReasons: [],
};

const STATUS_RANK: Record<BreakerStatus, number> = { ok: 0, block_new_buys: 1, close_only: 2 };

const VALID_STATUSES: ReadonlySet<string> = new Set(["ok", "block_new_buys", "close_only"]);

// Structural validation only -- this is the fail-closed gate for requirement 6
// ("invalid/unparsable persisted latch state -> treat as latched with
// block_new_buys, never as ok"). Anything that doesn't conform is corrupt.
export function isValidLatchState(value: unknown): value is BreakerLatchState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.latched !== "boolean") return false;
  if (typeof v.latchedStatus !== "string" || !VALID_STATUSES.has(v.latchedStatus)) return false;
  if (v.latchedAt !== null && typeof v.latchedAt !== "string") return false;
  if (!Array.isArray(v.latchedReasons) || !v.latchedReasons.every((r) => typeof r === "string")) return false;
  // A latched record must actually carry a tripped status -- "latched: true" paired
  // with "latchedStatus: ok" is an internally inconsistent (corrupt) shape.
  if (v.latched && v.latchedStatus === "ok") return false;
  return true;
}

export type LatchEvent = "none" | "trip" | "escalate";

export interface ApplyLatchResult {
  // Status/reasons reflect the latch (never de-escalates without reset); asOf,
  // peakEquity, and metrics always reflect the fresh evaluation passed in, so
  // current equity stays visible even while the status is held open by the latch.
  effective: BreakerState;
  latchState: BreakerLatchState;
  event: LatchEvent;
  corrupt: boolean;
}

// Wraps a fresh evaluateBreaker() result with persisted latch state. `rawLatchState`
// is whatever was last persisted (undefined/null on a fresh install or pre-latch
// history -- treated as "no latch yet", not corrupt).
export function applyBreakerLatch(fresh: BreakerState, rawLatchState: unknown): ApplyLatchResult {
  if (rawLatchState !== null && rawLatchState !== undefined && !isValidLatchState(rawLatchState)) {
    // Fail closed: never trust a malformed record enough to let it mean "ok". Floor
    // at block_new_buys exactly, per the plan's required behavior -- the next
    // (now-valid) evaluation is free to escalate further if still breached.
    const latchState: BreakerLatchState = {
      latched: true,
      latchedStatus: "block_new_buys",
      latchedAt: fresh.asOf,
      latchedReasons: ["corrupt_latch_state_fail_closed"],
    };
    return {
      effective: { ...fresh, status: "block_new_buys", reasons: [...fresh.reasons, "corrupt_latch_state_fail_closed"] },
      latchState,
      event: "trip",
      corrupt: true,
    };
  }

  const prior: BreakerLatchState = rawLatchState == null ? UNLATCHED_STATE : (rawLatchState as BreakerLatchState);
  const priorRank = prior.latched ? STATUS_RANK[prior.latchedStatus] : STATUS_RANK.ok;
  const freshRank = STATUS_RANK[fresh.status];

  if (freshRank > priorRank) {
    const event: LatchEvent = prior.latched ? "escalate" : "trip";
    const latchState: BreakerLatchState = {
      latched: true,
      latchedStatus: fresh.status,
      latchedAt: fresh.asOf,
      latchedReasons: fresh.reasons,
    };
    return {
      effective: { ...fresh, status: fresh.status, reasons: fresh.reasons },
      latchState,
      event,
      corrupt: false,
    };
  }

  if (prior.latched) {
    // Fresh evaluation is ok or no worse than what's already latched -- hold the
    // latch open. This is the core of the "no de-escalation without reset" rule.
    return {
      effective: {
        ...fresh,
        status: prior.latchedStatus,
        reasons: [...prior.latchedReasons, `breaker_latched_at_${prior.latchedAt}_pending_admin_reset`],
      },
      latchState: prior,
      event: "none",
      corrupt: false,
    };
  }

  // Not latched and fresh didn't trip -- nothing to do.
  return { effective: fresh, latchState: prior, event: "none", corrupt: false };
}
