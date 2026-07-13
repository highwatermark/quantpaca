// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): outbound HTTP timeouts
// with bounded retry, applied to Alpaca trading fetches, Telegram send + the
// long-polling getUpdates poller, and Gmail ingestion fetches (server.ts).
//
// marketDataFetcher.ts and tradabilityGuard.ts already use
// `AbortSignal.timeout(10s)` directly and are left as-is per the task
// brief ("existing AbortSignal.timeout call sites may stay as-is or
// migrate -- don't churn them needlessly") -- they have no retry need this
// helper would add (both already have their own bounded-retry/fail-closed
// logic one layer up).
//
// Binding policy (never relaxed): a non-idempotent request (anything other
// than GET) is NEVER retried, even once. `client_order_id` already protects
// Alpaca order submission from being double-applied broker-side, but this
// helper does not rely on that -- a network-level retry of a POST/PUT/
// PATCH/DELETE could still duplicate side effects the broker-side dedup
// doesn't cover (e.g. a Telegram send appearing twice), so the rule is
// enforced here, unconditionally, for every non-GET method.
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

// Minimal shape covering both the global `fetch` and any drop-in test stub.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * fetch() with a bounded timeout and, for GET requests only, exactly one
 * retry on failure (timeout or any other thrown error). Each attempt gets
 * its own fresh AbortSignal.timeout -- a signal that already fired on
 * attempt 1 is never reused for attempt 2.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const method = String(init.method || "GET").toUpperCase();
  const isRetryableGet = method === "GET";

  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (!isRetryableGet) throw err;
    // ONE retry, idempotent GET only -- a fresh signal, not the expired one.
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
}
