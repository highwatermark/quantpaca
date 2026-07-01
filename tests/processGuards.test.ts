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

test("repeated shutdown signals are idempotent", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onShutdownSignal("SIGTERM");
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(calls.closed, true);
  assert.deepEqual(calls.exitCodes, [0]);
});
