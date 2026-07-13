// Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5, guardrail 9): the
// in-process crash-loop breaker. Docker's own `restart: on-failure` policy
// (docker-compose.yml) will happily restart a crash-looping container
// forever -- it never "gives up" on its own. Guardrail 9's 3-restarts-in-1-
// hour cutoff is OURS to enforce, at boot, before anything else starts (env
// validation, startup reconciliation, the scheduler, the HTTP server) -- see
// server.ts's run() and its performCrashLoopCheck().
//
// Pure decision logic lives here so it is unit-testable without real
// timers/sqlite (see tests/crashLoopGuard.test.ts), mirroring the
// scheduler.ts / alertThrottle.ts pattern already used elsewhere in this
// codebase: server.ts owns the actual app_state reads/writes and the
// Telegram send, this module only decides.
//
// All thresholds here are named constants, not env vars, per the plan's
// binding rule ("the human operator may tune them, the executor may not").

export const CRASH_LOOP_MAX_BOOTS = 3;
export const CRASH_LOOP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// The exit code the crash-loop branch uses to STAY DOWN -- and it MUST be 0.
//
// This looks backwards, so read carefully (the task brief flags exactly this
// trap): docker-compose.yml uses `restart: on-failure`, and on-failure
// restarts a container on ANY non-zero exit code -- there is no per-code
// mapping ("restart on 1 but not on 86" is not expressible; on-failure's only
// variant is a max-retries CAP, which limits total attempts, not a
// 3-per-hour window). A "distinct" non-zero code like 86 would therefore be
// restarted by Docker just like any crash, defeating guardrail 9 entirely:
// the process would thrash forever, with our breaker firing an alert on
// every futile boot. Exiting 0 is the ONLY exit `restart: on-failure`
// treats as "done, leave it down".
//
// The cost: the operator cannot distinguish crash-loop-stay-down from a
// normal clean exit by exit code alone. That is deliberate and acceptable --
// the Telegram alert ("crash loop detected; staying down") plus the log line
// IS the operator's signal, per the task brief. Positions stay protected by
// broker-native bracket orders (guardrail 9's own note) while it stays down.
export const CRASH_LOOP_STAY_DOWN_EXIT_CODE = 0;

// app_state (persistence.ts) keys. No schema migration needed -- app_state is
// a generic key-value store; a key that was never written simply reads back
// undefined, which every caller here treats as its own safe default.
export const RESTART_HISTORY_APP_STATE_KEY = "restart_history";
// Presence/value of this key marks that the PRIOR run ended via a graceful
// SIGTERM/SIGINT (processGuards.ts), not a crash. Written during graceful
// shutdown, read + cleared on the very next boot (see server.ts). Falsy
// (undefined or "") means "no marker" -- both the never-written case and the
// already-cleared case.
export const CLEAN_SHUTDOWN_APP_STATE_KEY = "clean_shutdown_marker";

/**
 * Fail-safe parse of whatever `productionStore.getAppState(RESTART_HISTORY_APP_STATE_KEY)`
 * hands back. Corrupt/missing/malformed data fails OPEN to an empty history
 * (i.e. does NOT itself trigger a crash-loop verdict) -- the same fail-open
 * direction scheduler.ts's getConsecutiveFailureCount already uses for its
 * own persisted counter. A crash-loop breaker whose own state got corrupted
 * should not be the thing that stops the trading process; a REAL crash loop
 * will re-populate this history within the hour regardless.
 */
export function parseRestartHistory(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  } catch {
    return [];
  }
}

export type CrashLoopBootDecision = {
  crashLoopDetected: boolean;
  // The restart_history value to persist for THIS boot: prior entries pruned
  // to CRASH_LOOP_WINDOW_MS, plus this boot's own timestamp appended -- unless
  // this boot immediately followed a clean shutdown (see hadCleanShutdownMarker
  // below), in which case it is pruned only, never appended.
  prunedHistory: number[];
};

/**
 * The pure crash-loop decision, given everything read from app_state at boot.
 *
 * `priorHistory`: boot timestamps (ms) from previous boots, as persisted by a
 * prior call to this function (via server.ts). Order does not matter.
 *
 * `nowMs`: this boot's clock reading (injected, never `Date.now()` directly,
 * so this stays testable without real timers -- see tests/crashLoopGuard.test.ts).
 *
 * `hadCleanShutdownMarker`: true if the PRIOR run set the clean-shutdown
 * marker (processGuards.ts's graceful SIGTERM/SIGINT path) before THIS boot
 * happened. A boot that follows a clean shutdown is not itself evidence of
 * crashing -- guardrail 9 is about crash loops, not about an operator who
 * simply restarted the service on purpose -- so it is NOT appended to the
 * restart history. Stale entries are still pruned either way (item 3 of the
 * task brief: "a boot that passes the crash-loop check clears entries older
 * than the window"). The caller is responsible for clearing the marker after
 * reading it (this function is pure and never mutates app_state itself), so
 * the NEXT boot -- unless it follows another clean shutdown -- counts
 * normally again.
 */
export function evaluateCrashLoopOnBoot(
  priorHistory: number[],
  nowMs: number,
  hadCleanShutdownMarker: boolean,
): CrashLoopBootDecision {
  // Strictly "younger than the window" -- an entry exactly CRASH_LOOP_WINDOW_MS
  // old is treated as stale (>= window age, not < window age), matching the
  // 6h empty-sync throttle's own `nowMs - lastMs >= windowMs` boundary
  // convention in alertThrottle.ts.
  const withinWindow = priorHistory.filter((t) => nowMs - t < CRASH_LOOP_WINDOW_MS);
  const prunedHistory = hadCleanShutdownMarker ? withinWindow : [...withinWindow, nowMs];
  return {
    crashLoopDetected: prunedHistory.length >= CRASH_LOOP_MAX_BOOTS,
    prunedHistory,
  };
}
