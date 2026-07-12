import test from "node:test";
import assert from "node:assert/strict";
import { applyBreakerLatch, UNLATCHED_STATE } from "../src/server/breakerLatch";
import { BreakerState } from "../src/server/breakerEngine";

function freshState(status: BreakerState["status"], overrides: Partial<BreakerState> = {}): BreakerState {
  return {
    status,
    reasons: status === "ok" ? [] : [`${status} breach`],
    asOf: "2026-07-12T00:00:00.000Z",
    peakEquity: 100000,
    metrics: { equity: 90000, dailyLossPercent: 1, drawdownFromPeakPercent: 10, drawdownFromBaselinePercent: null },
    ...overrides,
  };
}

test("no prior latch + fresh ok -> stays unlatched", () => {
  const result = applyBreakerLatch(freshState("ok"), undefined);
  assert.equal(result.effective.status, "ok");
  assert.equal(result.latchState.latched, false);
  assert.equal(result.event, "none");
  assert.equal(result.corrupt, false);
});

test("no prior latch + fresh trips -> latches and reports a trip event", () => {
  const fresh = freshState("block_new_buys");
  const result = applyBreakerLatch(fresh, undefined);
  assert.equal(result.effective.status, "block_new_buys");
  assert.equal(result.latchState.latched, true);
  assert.equal(result.latchState.latchedStatus, "block_new_buys");
  assert.equal(result.event, "trip");
});

test("fresh-ok + latched -> stays latched (no de-escalation on recovery)", () => {
  const priorLatch = {
    latched: true as const,
    latchedStatus: "block_new_buys" as const,
    latchedAt: "2026-07-12T00:00:00.000Z",
    latchedReasons: ["drawdown from peak 12% >= limit 10%"],
  };
  const fresh = freshState("ok", { metrics: { equity: 99000, dailyLossPercent: 0, drawdownFromPeakPercent: 1, drawdownFromBaselinePercent: null } });
  const result = applyBreakerLatch(fresh, priorLatch);
  assert.equal(result.effective.status, "block_new_buys", "recovery must not silently unlatch");
  assert.equal(result.latchState.latched, true);
  assert.equal(result.latchState.latchedStatus, "block_new_buys");
  assert.equal(result.event, "none");
});

test("fresh-worse + latched block_new_buys -> escalates to close_only", () => {
  const priorLatch = {
    latched: true as const,
    latchedStatus: "block_new_buys" as const,
    latchedAt: "2026-07-12T00:00:00.000Z",
    latchedReasons: ["drawdown from peak 12% >= limit 10%"],
  };
  const fresh = freshState("close_only", { metrics: { equity: 80000, dailyLossPercent: 1, drawdownFromPeakPercent: 20, drawdownFromBaselinePercent: 20 } });
  const result = applyBreakerLatch(fresh, priorLatch);
  assert.equal(result.effective.status, "close_only");
  assert.equal(result.latchState.latchedStatus, "close_only");
  assert.equal(result.event, "escalate");
});

test("latched close_only never de-escalates even if fresh trips only to block_new_buys", () => {
  const priorLatch = {
    latched: true as const,
    latchedStatus: "close_only" as const,
    latchedAt: "2026-07-12T00:00:00.000Z",
    latchedReasons: ["baseline breach"],
  };
  const fresh = freshState("block_new_buys");
  const result = applyBreakerLatch(fresh, priorLatch);
  assert.equal(result.effective.status, "close_only");
  assert.equal(result.event, "none");
});

test("corrupt latch state fails closed to block_new_buys and is flagged corrupt", () => {
  const fresh = freshState("ok");
  for (const garbage of ["not-an-object", 42, { latched: "yes" }, { latched: true, latchedStatus: "ok", latchedAt: null, latchedReasons: [] }, { latched: true, latchedStatus: "nonsense", latchedAt: null, latchedReasons: [] }]) {
    const result = applyBreakerLatch(fresh, garbage);
    assert.equal(result.effective.status, "block_new_buys", `garbage=${JSON.stringify(garbage)}`);
    assert.equal(result.latchState.latched, true);
    assert.equal(result.latchState.latchedStatus, "block_new_buys");
    assert.equal(result.event, "trip");
    assert.equal(result.corrupt, true);
  }
});

test("corrupt latch state never reports ok even when fresh is ok", () => {
  const fresh = freshState("ok");
  const result = applyBreakerLatch(fresh, { garbage: true });
  assert.notEqual(result.effective.status, "ok");
});

test("null/undefined latch state is treated as a legitimate fresh start, not corrupt", () => {
  const fresh = freshState("ok");
  assert.equal(applyBreakerLatch(fresh, null).corrupt, false);
  assert.equal(applyBreakerLatch(fresh, undefined).corrupt, false);
});

test("UNLATCHED_STATE is exported and represents no active latch", () => {
  assert.equal(UNLATCHED_STATE.latched, false);
});
