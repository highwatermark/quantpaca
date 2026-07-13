// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): outbound HTTP timeouts
// with bounded retry. Binding policy: NEVER retry a non-idempotent request
// (POST/PUT/PATCH/DELETE) -- orders must not double-fire. GET is retried
// exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../src/server/httpDefaults";

// A fetch stub whose FIRST call hangs until the caller's AbortSignal fires
// (simulating a slow/never-responding server), then resolves 200 on any
// subsequent call. Records the HTTP method used on each call.
function hangThenOkFetch(callLog: string[]) {
  let calls = 0;
  return async (_url: any, init: any): Promise<Response> => {
    calls += 1;
    callLog.push(String(init?.method || "GET"));
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return new Response("ok", { status: 200 });
  };
}

function alwaysHangFetch(callLog: string[]) {
  return async (_url: any, init: any): Promise<Response> => {
    callLog.push(String(init?.method || "GET"));
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
}

test("default timeout constant is 10 seconds", () => {
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 10_000);
});

test("a timed-out GET is retried exactly once and can succeed on the retry", async () => {
  const callLog: string[] = [];
  const res = await fetchWithTimeout("http://example.test/x", { method: "GET" }, 20, hangThenOkFetch(callLog) as any);
  assert.equal(res.status, 200);
  assert.deepEqual(callLog, ["GET", "GET"], "exactly 2 attempts: original + 1 retry");
});

test("a request with no explicit method (defaults to GET) is also retried", async () => {
  const callLog: string[] = [];
  const res = await fetchWithTimeout("http://example.test/x", {}, 20, hangThenOkFetch(callLog) as any);
  assert.equal(res.status, 200);
  assert.deepEqual(callLog, ["GET", "GET"]);
});

test("a timed-out POST is NEVER retried, even once -- orders must not double-fire", async () => {
  const callLog: string[] = [];
  await assert.rejects(() =>
    fetchWithTimeout("http://example.test/orders", { method: "POST" }, 20, hangThenOkFetch(callLog) as any),
  );
  assert.deepEqual(callLog, ["POST"], "only the original attempt -- no retry");
});

test("DELETE and PUT are also never retried (non-idempotent-by-policy, not just POST)", async () => {
  for (const method of ["DELETE", "PUT", "PATCH"]) {
    const callLog: string[] = [];
    await assert.rejects(() =>
      fetchWithTimeout("http://example.test/x", { method }, 20, hangThenOkFetch(callLog) as any),
    );
    assert.deepEqual(callLog, [method], `${method} must not be retried`);
  }
});

test("a GET that fails on both attempts ultimately rejects (bounded retry, not infinite)", async () => {
  const callLog: string[] = [];
  await assert.rejects(() =>
    fetchWithTimeout("http://example.test/x", { method: "GET" }, 10, alwaysHangFetch(callLog) as any),
  );
  assert.deepEqual(callLog, ["GET", "GET"], "exactly 2 attempts, then gives up");
});

test("each attempt gets its own fresh AbortSignal (a used-up signal from attempt 1 doesn't poison attempt 2)", async () => {
  const signals: AbortSignal[] = [];
  const impl = async (_url: any, init: any): Promise<Response> => {
    signals.push(init.signal);
    if (signals.length === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return new Response("ok", { status: 200 });
  };
  await fetchWithTimeout("http://example.test/x", { method: "GET" }, 15, impl as any);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1].aborted, false, "the 2nd attempt's own signal must not already be aborted");
});

test("a successful GET on the first attempt never triggers a retry", async () => {
  const callLog: string[] = [];
  const impl = async (_url: any, init: any): Promise<Response> => {
    callLog.push(String(init?.method || "GET"));
    return new Response("ok", { status: 200 });
  };
  const res = await fetchWithTimeout("http://example.test/x", { method: "GET" }, 20, impl as any);
  assert.equal(res.status, 200);
  assert.deepEqual(callLog, ["GET"]);
});
