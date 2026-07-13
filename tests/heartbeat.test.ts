import test from "node:test";
import assert from "node:assert/strict";
import {
  HEARTBEAT_EVERY_N_CYCLES,
  MISSED_CYCLE_ALERT_MULTIPLIER,
  CYCLE_COUNT_APP_STATE_KEY,
  LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY,
  WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY,
  shouldSendHeartbeat,
  isCycleOverdue,
  shouldAlertOverdueGap,
} from "../src/server/heartbeat";

// --- Named constants ---

test("named constants: heartbeat every 12 cycles, overdue at 2x interval", () => {
  assert.equal(HEARTBEAT_EVERY_N_CYCLES, 12);
  assert.equal(MISSED_CYCLE_ALERT_MULTIPLIER, 2);
  assert.equal(typeof CYCLE_COUNT_APP_STATE_KEY, "string");
  assert.equal(typeof LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY, "string");
  assert.equal(typeof WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY, "string");
});

// --- shouldSendHeartbeat: every Nth completed cycle ---

test("11th completed cycle: no heartbeat", () => {
  assert.equal(shouldSendHeartbeat(11), false);
});

test("12th completed cycle: heartbeat", () => {
  assert.equal(shouldSendHeartbeat(12), true);
});

test("13th completed cycle: no heartbeat", () => {
  assert.equal(shouldSendHeartbeat(13), false);
});

test("24th completed cycle (2nd multiple of 12): heartbeat again", () => {
  assert.equal(shouldSendHeartbeat(24), true);
});

test("0th (no cycles yet): no heartbeat", () => {
  assert.equal(shouldSendHeartbeat(0), false);
});

test("custom everyNCycles is respected", () => {
  assert.equal(shouldSendHeartbeat(5, 5), true);
  assert.equal(shouldSendHeartbeat(4, 5), false);
});

// --- isCycleOverdue ---

test("no prior cycle ever recorded (undefined): not overdue (nothing to compare against yet)", () => {
  assert.equal(isCycleOverdue(undefined, 1_000_000, 15), false);
});

test("last cycle 31 minutes ago at a 15-minute interval (2x = 30min): overdue", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 31 * 60_000;
  assert.equal(isCycleOverdue(lastCycleCompletedAtMs, nowMs, 15), true);
});

test("last cycle 29 minutes ago at a 15-minute interval: not yet overdue", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 29 * 60_000;
  assert.equal(isCycleOverdue(lastCycleCompletedAtMs, nowMs, 15), false);
});

test("exactly at the 2x boundary is not overdue (strictly greater required)", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 30 * 60_000;
  assert.equal(isCycleOverdue(lastCycleCompletedAtMs, nowMs, 15), false);
});

test("respects a custom multiplier", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 46 * 60_000;
  assert.equal(isCycleOverdue(lastCycleCompletedAtMs, nowMs, 15, 3), true, "46min > 3x15=45min");
  assert.equal(isCycleOverdue(lastCycleCompletedAtMs, nowMs, 15, 4), false, "46min < 4x15=60min");
});

// --- shouldAlertOverdueGap: alert once per gap ---

test("overdue, never alerted before: alerts", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 31 * 60_000;
  assert.equal(shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, 15, undefined), true);
});

test("overdue, already alerted for this exact gap start: does not alert again", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 31 * 60_000;
  assert.equal(shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, 15, lastCycleCompletedAtMs), false);
});

test("repeated checks during the same gap: alerts once, then stays silent", () => {
  const lastCycleCompletedAtMs = 0;
  const interval = 15;
  let alertedGapStart: number | undefined;

  // Check 1: 31 minutes after the last completed cycle -- overdue, first time.
  let nowMs = 31 * 60_000;
  let shouldAlert = shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, interval, alertedGapStart);
  assert.equal(shouldAlert, true);
  if (shouldAlert) alertedGapStart = lastCycleCompletedAtMs;

  // Check 2: 40 minutes after -- still the same gap, must not alert again.
  nowMs = 40 * 60_000;
  shouldAlert = shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, interval, alertedGapStart);
  assert.equal(shouldAlert, false);

  // Check 3: 60 minutes after -- still the same gap (no new cycle completed).
  nowMs = 60 * 60_000;
  shouldAlert = shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, interval, alertedGapStart);
  assert.equal(shouldAlert, false);
});

test("a NEW gap (a cycle completed since the last alert, then went overdue again) alerts again", () => {
  const interval = 15;
  // First gap: last cycle at t=0, alerted at t=31min for gap-start=0.
  let alertedGapStart: number | undefined = 0;
  // A new cycle completes at t=35min (last-completed-at moves forward), then
  // goes overdue again by t=70min (35min later than the new last-completed-at).
  const newLastCycleCompletedAtMs = 35 * 60_000;
  const nowMs = 70 * 60_000;
  assert.equal(shouldAlertOverdueGap(newLastCycleCompletedAtMs, nowMs, interval, alertedGapStart), true);
});

test("not overdue: never alerts regardless of prior alerted-gap state", () => {
  const nowMs = 1_000_000_000;
  const lastCycleCompletedAtMs = nowMs - 5 * 60_000;
  assert.equal(shouldAlertOverdueGap(lastCycleCompletedAtMs, nowMs, 15, undefined), false);
});

test("no prior cycle ever recorded: never alerts (isCycleOverdue's own undefined handling)", () => {
  assert.equal(shouldAlertOverdueGap(undefined, 1_000_000, 15, undefined), false);
});
