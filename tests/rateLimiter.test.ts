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

// --- Stale-entry eviction (unbounded-memory fix): the per-IP map must not
// grow forever across a months-long process lifetime. Entries whose window
// expired more than one full window ago are evicted by the amortized sweep
// inside checkRateLimit itself (injected clock -- no real waiting).

test("entries for stale IPs are evicted after their window passes", () => {
  const state = createRateLimiterState();
  const windowMs = 1000;

  // 50 distinct IPs all seen at t=0.
  for (let i = 0; i < 50; i++) {
    checkRateLimit(state, `10.0.0.${i}`, 0, 5, windowMs);
  }
  assert.equal(state.entries.size, 50);

  // Advance past 2x the window (their windows expired more than one full
  // window ago) -- the next check from any key sweeps them out.
  const later = 2 * windowMs + 1;
  checkRateLimit(state, "fresh-ip", later, 5, windowMs);
  assert.equal(state.entries.size, 1, "all 50 stale entries evicted; only the fresh key remains");
  assert.ok(state.entries.has("fresh-ip"));
});

test("entries still inside (or within one window of) their window are NOT evicted by the sweep", () => {
  const state = createRateLimiterState();
  const windowMs = 1000;

  checkRateLimit(state, "recent-ip", 0, 5, windowMs);
  // Half a window later: recent-ip's window is still live -- a sweep
  // triggered by another key must not evict it.
  checkRateLimit(state, "other-ip", windowMs / 2, 5, windowMs);
  assert.equal(state.entries.size, 2, "a live entry survives the sweep");

  // recent-ip's count also survives (the entry was kept, not reset).
  for (let i = 0; i < 4; i++) checkRateLimit(state, "recent-ip", windowMs / 2, 5, windowMs);
  assert.equal(checkRateLimit(state, "recent-ip", windowMs / 2, 5, windowMs).allowed, false, "5 earlier hits still counted");
});

test("the sweep is amortized: throttled to at most one per window, then evicts everything stale", () => {
  const state = createRateLimiterState();
  const windowMs = 1000;

  checkRateLimit(state, "stale-ip", 0, 5, windowMs);

  // A check shortly after t=0 does not sweep (lastPruneMs throttles) --
  // stale-ip is still inside its own window anyway.
  checkRateLimit(state, "b", 10, 5, windowMs);
  assert.equal(state.entries.size, 2);

  // Well past staleness AND past the prune throttle: swept.
  checkRateLimit(state, "c", 3 * windowMs, 5, windowMs);
  assert.equal(state.entries.size, 1, "stale-ip and b evicted once the throttled sweep runs");
  assert.ok(state.entries.has("c"));
});
