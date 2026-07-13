// Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5): heartbeat + missed-cycle
// watchdog. Pure decision logic lives here (unit-testable without real
// timers/sqlite -- see tests/heartbeat.test.ts); server.ts owns the actual
// app_state reads/writes, the Telegram send, and wires these into
// scheduler.ts's injected `onCycleCompleted` / `checkWatchdog` deps.
//
// All thresholds here are named constants, not env vars, per the plan's
// binding rule ("the human operator may tune them, the executor may not").

// ~3 hours at the default 15-minute interval (see scheduler.ts's
// DEFAULT_INTERVAL_MINUTES). Counts COMPLETED scheduled cycles -- i.e. ticks
// that actually ran deps.runScheduledCycle() -- not every timer tick (a tick
// skipped because autoTrading is off or startup reconciliation is pending
// never reaches deps.onCycleCompleted, so it never advances this counter).
export const HEARTBEAT_EVERY_N_CYCLES = 12;

// The missed-cycle watchdog's overdue threshold, expressed as a multiple of
// the CURRENT configured runIntervalMins (read fresh on every check, same as
// the scheduler's own interval read -- a config change applies without a
// restart). Market closure needs no special-case exception here: a
// reduced/skipped-ingestion cycle during market-closed hours still calls
// deps.runScheduledCycle() and still completes (see server.ts's
// runSyncCycle -- MODULE 2 exit monitoring and MODULE 2.5 regime detection
// run unconditionally even on a `reducedCycle`), so it still advances
// last-completed-at like any other completed cycle. Only a cycle that never
// ran at all -- the scheduler loop itself stuck/dead -- goes undetected by
// anything except this watchdog.
export const MISSED_CYCLE_ALERT_MULTIPLIER = 2;

// app_state (persistence.ts) keys. No schema migration needed -- see
// crashLoopGuard.ts's identical note.
export const CYCLE_COUNT_APP_STATE_KEY = "scheduler_completed_cycle_count";
export const LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY = "scheduler_last_cycle_completed_at_ms";
// Stamped with the `lastCycleCompletedAtMs` value of the gap that was just
// alerted on -- this is what makes "alert once per gap" work: the gap's
// identity IS the last-completed-at timestamp it started from, so a repeated
// watchdog check during the same still-overdue gap reads back the same
// stamp and stays silent, while a NEW gap (a cycle has since completed,
// moving last-completed-at forward, and then gone overdue again) has a
// different identity and alerts again.
export const WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY = "scheduler_watchdog_alerted_gap_start_ms";

/**
 * True on every Nth completed cycle (12, 24, 36, ...), never on cycle 0.
 */
export function shouldSendHeartbeat(completedCycleCount: number, everyNCycles: number = HEARTBEAT_EVERY_N_CYCLES): boolean {
  return completedCycleCount > 0 && completedCycleCount % everyNCycles === 0;
}

/**
 * True if MORE than `multiplier` x `intervalMinutes` has elapsed since the
 * last completed cycle. `lastCycleCompletedAtMs` undefined means no cycle has
 * EVER completed (e.g. a genuinely fresh install with an empty app_state) --
 * that is not itself evidence of a missed cycle (there is no baseline to be
 * overdue relative to), so it reports not-overdue rather than false-alarming
 * on a boot that hasn't had time to run its first cycle yet.
 */
export function isCycleOverdue(
  lastCycleCompletedAtMs: number | undefined,
  nowMs: number,
  intervalMinutes: number,
  multiplier: number = MISSED_CYCLE_ALERT_MULTIPLIER,
): boolean {
  if (lastCycleCompletedAtMs === undefined || !Number.isFinite(lastCycleCompletedAtMs)) return false;
  const thresholdMs = intervalMinutes * 60_000 * multiplier;
  return nowMs - lastCycleCompletedAtMs > thresholdMs;
}

/**
 * The full "alert once per gap" decision: overdue AND not already alerted
 * for this exact gap. `alreadyAlertedGapStartMs` is whatever was last
 * persisted at WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY (undefined if never
 * alerted, or if the gap that was alerted on has since closed and a new one
 * opened with a different last-completed-at).
 */
export function shouldAlertOverdueGap(
  lastCycleCompletedAtMs: number | undefined,
  nowMs: number,
  intervalMinutes: number,
  alreadyAlertedGapStartMs: number | undefined,
  multiplier: number = MISSED_CYCLE_ALERT_MULTIPLIER,
): boolean {
  if (!isCycleOverdue(lastCycleCompletedAtMs, nowMs, intervalMinutes, multiplier)) return false;
  // isCycleOverdue already returned true, so lastCycleCompletedAtMs is
  // defined and finite here -- it uniquely identifies THIS gap.
  return alreadyAlertedGapStartMs !== lastCycleCompletedAtMs;
}
