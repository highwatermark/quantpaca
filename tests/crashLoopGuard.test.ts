import test from "node:test";
import assert from "node:assert/strict";
import {
  CRASH_LOOP_MAX_BOOTS,
  CRASH_LOOP_WINDOW_MS,
  CRASH_LOOP_STAY_DOWN_EXIT_CODE,
  RESTART_HISTORY_APP_STATE_KEY,
  CLEAN_SHUTDOWN_APP_STATE_KEY,
  evaluateCrashLoopOnBoot,
  parseRestartHistory,
} from "../src/server/crashLoopGuard";

// --- Named constants (guardrail 9, docs/GO_LIVE_PLAN.md Phase 2.5) ---

test("named constants match guardrail 9: 3 boots within 1 hour", () => {
  assert.equal(CRASH_LOOP_MAX_BOOTS, 3);
  assert.equal(CRASH_LOOP_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(typeof RESTART_HISTORY_APP_STATE_KEY, "string");
  assert.equal(typeof CLEAN_SHUTDOWN_APP_STATE_KEY, "string");
});

test("the stay-down exit code MUST be 0: docker-compose's `restart: on-failure` restarts ANY non-zero exit, so only a clean exit stays down", () => {
  // If someone "fixes" this to a distinct non-zero code (e.g. 86), Docker
  // will happily restart the crash-looping container forever, defeating
  // guardrail 9 entirely. See crashLoopGuard.ts's comment on the constant.
  assert.equal(CRASH_LOOP_STAY_DOWN_EXIT_CODE, 0);
});

// --- parseRestartHistory: fail-safe parsing of whatever app_state hands back ---

test("parseRestartHistory: undefined (never written) parses to an empty history", () => {
  assert.deepEqual(parseRestartHistory(undefined), []);
});

test("parseRestartHistory: corrupt JSON fails open to an empty history", () => {
  assert.deepEqual(parseRestartHistory("not json"), []);
});

test("parseRestartHistory: a JSON value that isn't an array fails open to an empty history", () => {
  assert.deepEqual(parseRestartHistory(JSON.stringify({ not: "an array" })), []);
});

test("parseRestartHistory: non-numeric entries are dropped, numeric entries kept", () => {
  assert.deepEqual(parseRestartHistory(JSON.stringify([1000, "bad", null, 2000, NaN])), [1000, 2000]);
});

test("parseRestartHistory: a well-formed array round-trips", () => {
  assert.deepEqual(parseRestartHistory(JSON.stringify([1000, 2000, 3000])), [1000, 2000, 3000]);
});

// --- evaluateCrashLoopOnBoot: the pure crash-loop decision ---

test("first-ever boot (empty history, no clean-shutdown marker): not a crash loop, history now has 1 entry", () => {
  const result = evaluateCrashLoopOnBoot([], 1_000_000, false);
  assert.equal(result.crashLoopDetected, false);
  assert.deepEqual(result.prunedHistory, [1_000_000]);
});

test("3 boots within the window: crash loop detected", () => {
  const nowMs = 1_000_000;
  // Two prior boots, both well inside the 1-hour window, then this boot makes 3.
  const priorHistory = [nowMs - 10 * 60_000, nowMs - 20 * 60_000];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, false);
  assert.equal(result.crashLoopDetected, true);
  assert.equal(result.prunedHistory.length, 3);
});

test("2 boots within the window: not yet a crash loop", () => {
  const nowMs = 1_000_000;
  const priorHistory = [nowMs - 10 * 60_000];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, false);
  assert.equal(result.crashLoopDetected, false);
  assert.equal(result.prunedHistory.length, 2);
});

test("2 boots + a clean-shutdown marker + this boot: NOT counted (this boot doesn't append)", () => {
  const nowMs = 1_000_000;
  const priorHistory = [nowMs - 10 * 60_000, nowMs - 20 * 60_000];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, true);
  assert.equal(result.crashLoopDetected, false, "a boot immediately following a clean shutdown must not itself count toward the crash window");
  assert.deepEqual(result.prunedHistory, priorHistory, "the clean-shutdown boot is not appended to history");
});

test("clean-shutdown marker still prunes stale entries even though this boot isn't appended", () => {
  const nowMs = 1_000_000;
  const priorHistory = [
    nowMs - 10 * 60_000, // inside window
    nowMs - CRASH_LOOP_WINDOW_MS - 1, // outside window, must be pruned
  ];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, true);
  assert.deepEqual(result.prunedHistory, [nowMs - 10 * 60_000]);
});

test("entries older than the window are pruned on a normal (non-clean-shutdown) boot too", () => {
  const nowMs = 1_000_000;
  const priorHistory = [
    nowMs - CRASH_LOOP_WINDOW_MS - 1, // stale, must be pruned
    nowMs - 5 * 60_000, // fresh
  ];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, false);
  assert.deepEqual(result.prunedHistory, [nowMs - 5 * 60_000, nowMs]);
  assert.equal(result.crashLoopDetected, false, "only 2 entries remain within the window (one stale one pruned, one fresh, plus this boot)");
});

test("exactly at the window boundary is excluded (>= window age is stale, not fresh)", () => {
  const nowMs = 1_000_000;
  const priorHistory = [nowMs - CRASH_LOOP_WINDOW_MS];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, false);
  assert.deepEqual(result.prunedHistory, [nowMs], "the boundary-age entry must be pruned as stale");
});

test("4th+ boot within the window still reports crash loop (doesn't flip back to false)", () => {
  const nowMs = 1_000_000;
  const priorHistory = [nowMs - 5_000, nowMs - 10_000, nowMs - 15_000];
  const result = evaluateCrashLoopOnBoot(priorHistory, nowMs, false);
  assert.equal(result.crashLoopDetected, true);
  assert.equal(result.prunedHistory.length, 4);
});
