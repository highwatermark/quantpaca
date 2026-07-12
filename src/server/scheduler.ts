// Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): the autonomous sync loop.
// Pure tick logic, fully dependency-injected (clock/timer/cycle-runner/store)
// so it is unit-testable without real timers or sleeps -- see
// tests/scheduler.test.ts. server.ts wires the real setTimeout/config-read/
// app_state/Telegram dependencies and owns the single long-lived instance.
//
// Design: a setTimeout CHAIN (re-arm only after the previous cycle finishes),
// not setInterval -- this both prevents drift and makes true overlap
// impossible from the timer alone. The `cycleInFlight` guard below is an
// extra safety net for the test-visible manual trigger (runTickNow), which a
// caller could otherwise invoke concurrently with an in-flight tick.
//
// All thresholds here are named constants, not env vars, per the plan's
// binding rule ("the human operator may tune them, the executor may not").

import { parseFiniteNumber } from "./numericSafety";

export const DEFAULT_INTERVAL_MINUTES = 15;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 240;

// Guardrail 7 (docs/GO_LIVE_PLAN.md Phase 2.1): 3 consecutive FAILED
// scheduled sync cycles auto-pause trading. Manual /api/sync failures never
// feed this counter (see the plan's "3 consecutive scheduled sync cycles"
// wording) -- only the scheduler's own runScheduledCycle result does.
export const MAX_CONSECUTIVE_FAILURES = 3;

// Guardrail 8: at most 2 new BUY orders placed per sync cycle (manual or
// scheduled -- the cap is a per-cycle safety limit, not scheduler-specific).
// Enforced inside server.ts's runSyncCycle at the order-placement chokepoint;
// re-exported from here so the threshold has exactly one definition.
export const MAX_BUYS_PER_CYCLE = 2;

/**
 * Validates and clamps a raw `system.runIntervalMins` config value. Invalid
 * (non-finite/unparsable) input fails closed to DEFAULT_INTERVAL_MINUTES;
 * valid input outside [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES] is
 * clamped. Either correction is logged -- silence would hide a misconfigured
 * interval from the operator.
 */
export function resolveIntervalMinutes(raw: unknown, log: (message: string) => void): number {
  const parsed = parseFiniteNumber(raw, "system.runIntervalMins");
  if (parsed.ok === false) {
    log(`[scheduler] runIntervalMins is invalid (${JSON.stringify(raw)}); using the default of ${DEFAULT_INTERVAL_MINUTES} minutes.`);
    return DEFAULT_INTERVAL_MINUTES;
  }
  const clamped = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, parsed.value));
  if (clamped !== parsed.value) {
    log(
      `[scheduler] runIntervalMins ${parsed.value} is outside [${MIN_INTERVAL_MINUTES}, ${MAX_INTERVAL_MINUTES}]; clamped to ${clamped} minutes.`,
    );
  }
  return clamped;
}

export type CycleOutcome = { failed: boolean };

// Opaque handle type: server.ts hands back whatever setTimeout returns;
// tests hand back whatever their fake timer implementation returns. Never
// interpreted by this module, only round-tripped to clearTimer.
export type SchedulerTimerHandle = unknown;

export type SchedulerDeps = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => SchedulerTimerHandle;
  clearTimer: (handle: SchedulerTimerHandle) => void;
  // Read fresh on every tick (not cached at start()) so a config change
  // applies without a server restart.
  getIntervalMinutesRaw: () => unknown;
  isAutoTradingOn: () => boolean;
  // Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2, startup reconciliation):
  // backed by src/server/startupReconciliation.ts's isTradingReady(). A tick
  // that finds this false skips the ENTIRE scheduled cycle (not just BUYs --
  // see the module doc comment there for why a plain "not ready" is a
  // stronger condition than "orphans found", which only blocks BUYs at the
  // executeTradeIntent chokepoint while cycles keep running normally).
  isTradingReady: () => boolean;
  // Runs exactly one scheduled sync cycle end-to-end and reports whether it
  // counts as failed (threw, or every ingestion source errored -- see
  // server.ts's runSyncCycle). Expected to never throw; if it does, the tick
  // logs and swallows the error rather than crashing the loop (defensive
  // backstop only).
  runScheduledCycle: () => Promise<CycleOutcome>;
  // Backed by app_state (persistence.ts) in production -- survives restarts.
  getConsecutiveFailureCount: () => number;
  setConsecutiveFailureCount: (count: number) => void;
  // Sets autoTrading=false (persisted), sends the (unthrottled) Telegram
  // pause alert, and appends an audit event. Runs once, at the moment of the
  // MAX_CONSECUTIVE_FAILURES-th consecutive failure.
  onAutoPause: () => Promise<void>;
  log: (message: string) => void;
};

export type Scheduler = {
  start(): void;
  stop(): void;
  // Test-visible: runs exactly one tick's logic directly, without waiting for
  // a real timer. Also used internally by the setTimeout chain.
  runTickNow(): Promise<void>;
};

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timerHandle: SchedulerTimerHandle | null = null;
  let cycleInFlight = false;
  // Defaults to "not stopped" so a directly-invoked runTickNow() (the
  // test-visible manual trigger, used without ever calling start()) still
  // re-arms through the injected deps.setTimer -- harmless with a fake timer
  // in tests, and exactly what the real setTimeout-chain wants once start()
  // is called in production. stop() is the only thing that suppresses it.
  let stopped = false;

  function armNext(intervalMinutes: number): void {
    if (stopped) return;
    timerHandle = deps.setTimer(() => {
      void tick();
    }, intervalMinutes * 60_000);
  }

  async function tick(): Promise<void> {
    if (cycleInFlight) {
      deps.log("[scheduler] Tick skipped: a previous cycle is still running (single-flight, no backlog).");
      return;
    }

    const intervalMinutes = resolveIntervalMinutes(deps.getIntervalMinutesRaw(), deps.log);

    if (!deps.isAutoTradingOn()) {
      deps.log("[scheduler] Tick skipped: autoTrading is off.");
      armNext(intervalMinutes);
      return;
    }

    if (!deps.isTradingReady()) {
      deps.log("[scheduler] Tick skipped: startup reconciliation pending.");
      armNext(intervalMinutes);
      return;
    }

    cycleInFlight = true;
    try {
      const outcome = await deps.runScheduledCycle();
      if (outcome.failed) {
        const nextCount = deps.getConsecutiveFailureCount() + 1;
        deps.setConsecutiveFailureCount(nextCount);
        deps.log(`[scheduler] Scheduled cycle failed (${nextCount}/${MAX_CONSECUTIVE_FAILURES} consecutive failures).`);
        if (nextCount >= MAX_CONSECUTIVE_FAILURES) {
          deps.log(`[scheduler] ${MAX_CONSECUTIVE_FAILURES} consecutive scheduled cycle failures reached; auto-pausing.`);
          await deps.onAutoPause();
          // Reset so a resumed loop gets a fresh MAX_CONSECUTIVE_FAILURES-strike
          // budget instead of re-pausing after a single subsequent failure.
          deps.setConsecutiveFailureCount(0);
        }
      } else {
        deps.setConsecutiveFailureCount(0);
      }
    } catch (err) {
      // runScheduledCycle is documented to report failure via CycleOutcome,
      // not by throwing -- this is a defensive backstop only, so a bug in
      // that reporting can never crash the scheduler loop itself.
      deps.log(`[scheduler] Unexpected error running a scheduled cycle: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      cycleInFlight = false;
    }

    armNext(intervalMinutes);
  }

  return {
    start() {
      stopped = false;
      armNext(resolveIntervalMinutes(deps.getIntervalMinutesRaw(), deps.log));
    },
    stop() {
      stopped = true;
      if (timerHandle !== null) {
        deps.clearTimer(timerHandle);
        timerHandle = null;
      }
    },
    runTickNow: tick,
  };
}
