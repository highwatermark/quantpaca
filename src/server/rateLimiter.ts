// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): a simple in-memory
// fixed-window rate limiter for /api/* (no new dependencies -- an
// intentionally minimal control, not a replacement for a real reverse proxy
// in production; see docs/OPS_RUNBOOK.md). Pure decision logic
// (checkRateLimit) is unit-tested directly (tests/rateLimiter.test.ts); the
// Express middleware factory below is the thin wiring server.ts mounts on
// `/api`.
import type { NextFunction, Request, Response } from "express";

export const RATE_LIMIT_PER_MINUTE = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

type WindowEntry = { windowStartMs: number; count: number };
// `entries` is the per-key (per-IP) window state; `lastPruneMs` throttles the
// stale-entry sweep below to at most one pass per window, keeping the
// amortized per-request cost O(1) even under a flood of distinct IPs.
export type RateLimiterState = { entries: Map<string, WindowEntry>; lastPruneMs: number };

export function createRateLimiterState(): RateLimiterState {
  return { entries: new Map(), lastPruneMs: Number.NEGATIVE_INFINITY };
}

// Unbounded-memory fix (Task 13 review): this app runs for months, and every
// distinct client IP used to keep a permanent Map entry for the process
// lifetime. An entry whose window expired more than one FULL window ago
// (i.e. older than 2x windowMs) can never influence any future decision --
// checkRateLimit resets any entry past 1x windowMs on its next hit anyway --
// so it is pure garbage and safe to evict. Swept opportunistically from
// inside checkRateLimit, throttled via lastPruneMs to one O(n) pass per
// window; between sweeps stale entries may linger up to ~one extra window,
// which is bounded and harmless.
function pruneStaleEntries(state: RateLimiterState, nowMs: number, windowMs: number): void {
  if (nowMs - state.lastPruneMs < windowMs) return;
  state.lastPruneMs = nowMs;
  for (const [key, entry] of state.entries) {
    if (nowMs - entry.windowStartMs >= 2 * windowMs) {
      state.entries.delete(key);
    }
  }
}

/**
 * Fixed-window limiter: `key` (an IP address in production) gets `limit`
 * requests per `windowMs`; the window resets (count back to 1) once `nowMs`
 * has moved past the current window's start. Mutates `state` in place, and
 * opportunistically evicts long-stale keys (see pruneStaleEntries).
 */
export function checkRateLimit(
  state: RateLimiterState,
  key: string,
  nowMs: number,
  limit: number = RATE_LIMIT_PER_MINUTE,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): { allowed: boolean; remaining: number } {
  pruneStaleEntries(state, nowMs, windowMs);
  const entry = state.entries.get(key);
  if (!entry || nowMs - entry.windowStartMs >= windowMs) {
    state.entries.set(key, { windowStartMs: nowMs, count: 1 });
    return { allowed: true, remaining: Math.max(0, limit - 1) };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - entry.count) };
}

// /api/health is exempt (Docker healthcheck + uptime monitors hit it
// frequently and unauthenticated -- see server.ts's requireReadToken, which
// exempts it for the same reason).
const EXEMPT_PATH = "/api/health";

/**
 * Express middleware factory. A fresh `RateLimiterState` is created per
 * middleware instance (one process-lifetime limiter, mounted once on `/api`
 * in server.ts) -- tests construct their own instance via this factory so
 * they never share state with each other or with the real app.
 */
export function createRateLimitMiddleware(
  deps: { now: () => number; limit?: number; windowMs?: number } = { now: () => Date.now() },
) {
  const state = createRateLimiterState();
  const limit = deps.limit ?? RATE_LIMIT_PER_MINUTE;
  const windowMs = deps.windowMs ?? RATE_LIMIT_WINDOW_MS;
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    // req.path is relative to the mount point (server.ts mounts this on
    // "/api", so req.path for a health check would be "/health", not
    // "/api/health") -- req.originalUrl always carries the full path
    // regardless of where the middleware is mounted, so the exemption check
    // is done against that instead (query string stripped).
    const fullPath = req.originalUrl.split("?")[0];
    if (fullPath === EXEMPT_PATH) {
      next();
      return;
    }
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const result = checkRateLimit(state, key, deps.now(), limit, windowMs);
    if (!result.allowed) {
      res.status(429).json({
        error: `Rate limit exceeded (${limit} requests/minute per IP). A reverse proxy should front this limiter in real deployments -- see docs/OPS_RUNBOOK.md.`,
      });
      return;
    }
    next();
  };
}
