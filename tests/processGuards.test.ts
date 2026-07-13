import test from "node:test";
import assert from "node:assert/strict";
import { createProcessGuardHandlers } from "../src/server/processGuards";

function makeDeps() {
  const calls: { logs: string[]; exitCodes: number[]; closed: boolean } = {
    logs: [],
    exitCodes: [],
    closed: false,
  };
  return {
    calls,
    deps: {
      log: (message: string) => calls.logs.push(message),
      exit: (code: number) => calls.exitCodes.push(code),
      closeServer: (onClosed: () => void) => {
        calls.closed = true;
        onClosed();
      },
    },
  };
}

test("uncaught exception logs and exits 1", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onUncaughtException(new Error("boom"));
  assert.deepEqual(calls.exitCodes, [1]);
  assert.ok(calls.logs.some((l) => l.includes("Uncaught exception")));
});

test("unhandled rejection logs and exits 1", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onUnhandledRejection("reason");
  assert.deepEqual(calls.exitCodes, [1]);
});

test("shutdown signal closes the server then exits 0 exactly once", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(calls.closed, true);
  assert.deepEqual(calls.exitCodes, [0]);
});

test("shutdown signal stops the scheduler (clears its timer) before closing the server", () => {
  const { calls, deps } = makeDeps();
  let schedulerStopped = false;
  let serverClosedAt = 0;
  let stoppedAt = 0;
  let counter = 0;
  const handlers = createProcessGuardHandlers({
    ...deps,
    closeServer: (onClosed) => {
      calls.closed = true;
      serverClosedAt = ++counter;
      onClosed();
    },
    stopScheduler: () => {
      schedulerStopped = true;
      stoppedAt = ++counter;
    },
  });
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(schedulerStopped, true);
  assert.ok(stoppedAt < serverClosedAt, "the scheduler must stop before the HTTP server is closed");
});

test("shutdown signal without a stopScheduler dep still shuts down normally (optional dep)", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(calls.closed, true);
  assert.deepEqual(calls.exitCodes, [0]);
});

test("repeated shutdown signals are idempotent", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onShutdownSignal("SIGTERM");
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(calls.closed, true);
  assert.deepEqual(calls.exitCodes, [0]);
});

// Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5, guardrail 9): a graceful
// shutdown must record a clean-shutdown marker so the crash-loop breaker
// (src/server/crashLoopGuard.ts) doesn't count the NEXT boot as a
// crash-recovery boot.

test("shutdown signal marks a clean shutdown before exiting", () => {
  const { calls, deps } = makeDeps();
  let marked = false;
  const handlers = createProcessGuardHandlers({
    ...deps,
    markCleanShutdown: () => {
      marked = true;
    },
  });
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(marked, true);
  assert.deepEqual(calls.exitCodes, [0]);
});

test("shutdown signal without a markCleanShutdown dep still shuts down normally (optional dep)", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(calls.closed, true);
  assert.deepEqual(calls.exitCodes, [0]);
});

test("an uncaught exception or unhandled rejection does NOT mark a clean shutdown (it is not one)", () => {
  const { deps } = makeDeps();
  let marked = false;
  const handlers = createProcessGuardHandlers({
    ...deps,
    markCleanShutdown: () => {
      marked = true;
    },
  });
  handlers.onUncaughtException(new Error("boom"));
  handlers.onUnhandledRejection("reason");
  assert.equal(marked, false, "a crash must never be recorded as a clean shutdown");
});
