// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): simple in-memory
// fixed-window rate limiter for /api/*, no new dependencies. Pure decision
// logic here (unit-testable without Express); server.ts wires the Express
// middleware via createRateLimitMiddleware -- see tests/readEndpointAuth.test.ts
// for the end-to-end 429 assertion through the real app.
import test from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS, createRateLimiterState, checkRateLimit } from "../src/server/rateLimiter";

test("named constants: 120 requests/minute", () => {
  assert.equal(RATE_LIMIT_PER_MINUTE, 120);
  assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
});

test("requests under the limit are all allowed within one window", () => {
  const state = createRateLimiterState();
  const nowMs = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
    const result = checkRateLimit(state, "1.2.3.4", nowMs + i, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
    assert.equal(result.allowed, true, `request ${i + 1} of ${RATE_LIMIT_PER_MINUTE} should be allowed`);
  }
});

test("the (limit+1)th request in the same window is rejected", () => {
  const state = createRateLimiterState();
  const nowMs = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
    checkRateLimit(state, "1.2.3.4", nowMs + i, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  }
  const overLimit = checkRateLimit(state, "1.2.3.4", nowMs + RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  assert.equal(overLimit.allowed, false);
});

test("a new window resets the count", () => {
  const state = createRateLimiterState();
  const nowMs = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
    checkRateLimit(state, "1.2.3.4", nowMs, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  }
  const stillBlocked = checkRateLimit(state, "1.2.3.4", nowMs, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  assert.equal(stillBlocked.allowed, false);

  const nextWindow = checkRateLimit(state, "1.2.3.4", nowMs + RATE_LIMIT_WINDOW_MS, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  assert.equal(nextWindow.allowed, true, "a fresh window must reset the counter");
});

test("different IPs are tracked independently", () => {
  const state = createRateLimiterState();
  const nowMs = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
    checkRateLimit(state, "1.1.1.1", nowMs, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  }
  const otherIp = checkRateLimit(state, "2.2.2.2", nowMs, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
  assert.equal(otherIp.allowed, true, "a different IP has its own budget");
});

test("respects a custom limit/window", () => {
  const state = createRateLimiterState();
  assert.equal(checkRateLimit(state, "k", 0, 2, 1000).allowed, true);
  assert.equal(checkRateLimit(state, "k", 100, 2, 1000).allowed, true);
  assert.equal(checkRateLimit(state, "k", 200, 2, 1000).allowed, false);
  assert.equal(checkRateLimit(state, "k", 1000, 2, 1000).allowed, true, "window rolled over");
});
