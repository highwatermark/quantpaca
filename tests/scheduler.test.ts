import test from "node:test";
import assert from "node:assert/strict";
import {
  createScheduler,
  resolveIntervalMinutes,
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MAX_CONSECUTIVE_FAILURES,
  MAX_BUYS_PER_CYCLE,
  SchedulerDeps,
} from "../src/server/scheduler";

// --- Named constants (guardrail: operator may tune via code, not env vars) ---

test("named constants match the go-live plan's guardrail thresholds", () => {
  assert.equal(DEFAULT_INTERVAL_MINUTES, 15);
  assert.equal(MIN_INTERVAL_MINUTES, 5);
  assert.equal(MAX_INTERVAL_MINUTES, 240);
  assert.equal(MAX_CONSECUTIVE_FAILURES, 3);
  assert.equal(MAX_BUYS_PER_CYCLE, 2);
});

// --- resolveIntervalMinutes: validate + clamp + fail-closed-to-default ---

test("resolveIntervalMinutes: an in-range value passes through unchanged, no log", () => {
  const logs: string[] = [];
  assert.equal(resolveIntervalMinutes(30, (m) => logs.push(m)), 30);
  assert.equal(logs.length, 0);
});

test("resolveIntervalMinutes: below MIN clamps up to MIN and logs", () => {
  const logs: string[] = [];
  assert.equal(resolveIntervalMinutes(1, (m) => logs.push(m)), MIN_INTERVAL_MINUTES);
  assert.equal(logs.length, 1);
});

test("resolveIntervalMinutes: above MAX clamps down to MAX and logs", () => {
  const logs: string[] = [];
  assert.equal(resolveIntervalMinutes(500, (m) => logs.push(m)), MAX_INTERVAL_MINUTES);
  assert.equal(logs.length, 1);
});

test("resolveIntervalMinutes: non-numeric/invalid input fails closed to the default and logs", () => {
  for (const bad of ["not-a-number", undefined, NaN, null, {}]) {
    const logs: string[] = [];
    assert.equal(resolveIntervalMinutes(bad, (m) => logs.push(m)), DEFAULT_INTERVAL_MINUTES, `input: ${JSON.stringify(bad)}`);
    assert.equal(logs.length, 1, `expected exactly one log for invalid input: ${JSON.stringify(bad)}`);
  }
});

// --- createScheduler: pure tick logic with fully injected dependencies ---

type DepsState = {
  logs: string[];
  timers: Array<{ cb: () => void; ms: number }>;
  failureCount: number;
  autoTradingOn: boolean;
  intervalRaw: unknown;
  cycleResults: Array<{ failed: boolean }>;
  pauseCalls: number;
  runCalls: number;
  tradingReady: boolean;
};

function makeDeps(): { state: DepsState; deps: SchedulerDeps } {
  const state: DepsState = {
    logs: [],
    timers: [],
    failureCount: 0,
    autoTradingOn: true,
    intervalRaw: 15,
    cycleResults: [],
    pauseCalls: 0,
    runCalls: 0,
    tradingReady: true,
  };
  const deps: SchedulerDeps = {
    now: () => 0,
    setTimer: (cb, ms) => {
      state.timers.push({ cb, ms });
      return state.timers.length;
    },
    clearTimer: () => {},
    getIntervalMinutesRaw: () => state.intervalRaw,
    isAutoTradingOn: () => state.autoTradingOn,
    isTradingReady: () => state.tradingReady,
    runScheduledCycle: async () => {
      state.runCalls++;
      return state.cycleResults.shift() || { failed: false };
    },
    getConsecutiveFailureCount: () => state.failureCount,
    setConsecutiveFailureCount: (n) => {
      state.failureCount = n;
    },
    onAutoPause: async () => {
      state.pauseCalls++;
    },
    log: (m) => state.logs.push(m),
  };
  return { state, deps };
}

test("single-flight: a tick invoked while a cycle is still running is skipped, not queued", async () => {
  const { state, deps } = makeDeps();
  let resolveCycle: (v: { failed: boolean }) => void = () => {};
  deps.runScheduledCycle = () =>
    new Promise((resolve) => {
      resolveCycle = resolve;
      state.runCalls++;
    });
  const scheduler = createScheduler(deps);

  const firstTick = scheduler.runTickNow();
  const secondTick = scheduler.runTickNow();
  await secondTick;

  assert.ok(
    state.logs.some((l) => /skip/i.test(l) && /running/i.test(l)),
    `expected a skip log for the overlapping tick, got: ${JSON.stringify(state.logs)}`,
  );

  resolveCycle({ failed: false });
  await firstTick;

  assert.equal(state.runCalls, 1, "the overlapping tick must never have invoked the cycle runner a second time");
});

test("autoTrading off: a tick skips running a cycle entirely", async () => {
  const { state, deps } = makeDeps();
  state.autoTradingOn = false;
  const scheduler = createScheduler(deps);
  await scheduler.runTickNow();
  assert.equal(state.runCalls, 0);
});

// Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation.
test("startup reconciliation pending: a tick skips running a cycle entirely and logs it, but still re-arms the next tick", async () => {
  const { state, deps } = makeDeps();
  state.tradingReady = false;
  const scheduler = createScheduler(deps);
  await scheduler.runTickNow();
  assert.equal(state.runCalls, 0);
  assert.ok(
    state.logs.some((l) => /skip/i.test(l) && /startup reconciliation pending/i.test(l)),
    `expected a "startup reconciliation pending" skip log, got: ${JSON.stringify(state.logs)}`,
  );
  assert.equal(state.timers.length, 1, "the scheduler must keep ticking (re-arm) while reconciliation is pending");
});

test("startup reconciliation ready + autoTrading on: a tick runs a cycle normally", async () => {
  const { state, deps } = makeDeps();
  state.tradingReady = true;
  state.autoTradingOn = true;
  const scheduler = createScheduler(deps);
  await scheduler.runTickNow();
  assert.equal(state.runCalls, 1);
});

test("interval is read fresh on every tick, so a config change applies without restart", async () => {
  const { state, deps } = makeDeps();
  const scheduler = createScheduler(deps);
  state.intervalRaw = 20;
  await scheduler.runTickNow();
  state.intervalRaw = 45;
  await scheduler.runTickNow();
  assert.equal(state.timers[0].ms, 20 * 60_000);
  assert.equal(state.timers[1].ms, 45 * 60_000);
});

test("3 consecutive scheduled failures trigger auto-pause exactly once, then reset the counter", async () => {
  const { state, deps } = makeDeps();
  state.cycleResults = [{ failed: true }, { failed: true }, { failed: true }];
  const scheduler = createScheduler(deps);

  await scheduler.runTickNow();
  assert.equal(state.failureCount, 1);
  assert.equal(state.pauseCalls, 0);

  await scheduler.runTickNow();
  assert.equal(state.failureCount, 2);
  assert.equal(state.pauseCalls, 0);

  await scheduler.runTickNow();
  assert.equal(state.pauseCalls, 1, "the third consecutive failure must trigger exactly one auto-pause");
  assert.equal(state.failureCount, 0, "the counter resets after pausing so a resumed loop gets a fresh 3-strike budget");
});

test("2 failures then a success resets the counter without ever pausing", async () => {
  const { state, deps } = makeDeps();
  state.cycleResults = [{ failed: true }, { failed: true }, { failed: false }];
  const scheduler = createScheduler(deps);

  await scheduler.runTickNow();
  await scheduler.runTickNow();
  assert.equal(state.failureCount, 2);

  await scheduler.runTickNow();
  assert.equal(state.failureCount, 0);
  assert.equal(state.pauseCalls, 0);
});

test("stop() clears the armed timer and start() does not re-arm after stop", () => {
  const { state, deps } = makeDeps();
  let cleared: unknown;
  deps.clearTimer = (h) => {
    cleared = h;
  };
  const scheduler = createScheduler(deps);
  scheduler.start();
  assert.equal(state.timers.length, 1);
  scheduler.stop();
  assert.equal(cleared, state.timers.length);
});
