// Phase 2 Task 3 (docs/GO_LIVE_PLAN.md Phase 2.1, "Market-hours & tradability
// guard"): per-asset tradability check for BUY orders. The market-hours half
// (GET /v2/clock) is already covered by server.ts's checkMarketOpenForScheduledCycle;
// this module covers the other half -- GET /v2/assets/{symbol} on the trading
// host -- which the clock check cannot see (a symbol can be individually
// halted/delisted while the overall market is open).
//
// BUY-only, fail-closed, matching the plan's standing asymmetry: SELLs must
// always be able to try to exit (a halt fails at the broker, which is
// recorded honestly there) -- this module is never consulted for a SELL; the
// caller (server.ts) is responsible for only invoking it on the buy path.
//
// Positive results are cached in-memory per symbol for 24h (asset status
// changes rarely; a process restart re-checks cold). Negative and failed
// checks are NEVER cached -- every subsequent BUY attempt for a
// not-yet-confirmed-tradable symbol re-checks fresh next time.
export const ASSET_TRADABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ASSET_TRADABILITY_FETCH_TIMEOUT_MS = 10_000;

type CacheEntry = { checkedAtMs: number };

// Module-level, in-memory Map (deliberately NOT app_state / the persisted
// store -- per the task brief, "keep it simple"). Process-lifetime only: a
// restart re-checks every symbol cold, which is fine since asset
// tradability/status changes rarely.
const positiveCache = new Map<string, CacheEntry>();

export type TradabilityCheckOptions = {
  baseUrl: string;
  apiKey?: string;
  secretKey?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

export type TradabilityCheckResult = {
  tradable: boolean;
  reason: string;
  fromCache: boolean;
};

// Never throws: every failure mode (non-OK response, network error, timeout,
// malformed body) is caught and returned as `{ tradable: false, reason }` so
// the caller can fail the BUY closed with an honest, audited reason.
export async function checkAssetTradable(
  symbol: string,
  options: TradabilityCheckOptions,
): Promise<TradabilityCheckResult> {
  const nowMs = options.nowMs ?? Date.now();
  const cached = positiveCache.get(symbol);
  if (cached && nowMs - cached.checkedAtMs < ASSET_TRADABILITY_CACHE_TTL_MS) {
    return { tradable: true, reason: `Tradability guard: ${symbol} served from the 24h positive cache.`, fromCache: true };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${options.baseUrl}/assets/${symbol}`, {
      headers: {
        "APCA-API-KEY-ID": options.apiKey || "",
        "APCA-API-SECRET-KEY": options.secretKey || "",
      },
      signal: AbortSignal.timeout(ASSET_TRADABILITY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        tradable: false,
        reason: `Tradability guard: asset check for ${symbol} failed with HTTP ${res.status}; failing closed (rejecting the BUY).`,
        fromCache: false,
      };
    }
    const body = await res.json().catch(() => null);
    const tradable = (body as { tradable?: unknown } | null)?.tradable === true;
    const status = (body as { status?: unknown } | null)?.status;
    if (tradable && status === "active") {
      positiveCache.set(symbol, { checkedAtMs: nowMs });
      return { tradable: true, reason: `Tradability guard: ${symbol} is tradable and active.`, fromCache: false };
    }
    return {
      tradable: false,
      reason: `Tradability guard: ${symbol} is not tradable/active (tradable=${String(tradable)}, status=${String(status)}); rejecting the BUY.`,
      fromCache: false,
    };
  } catch (err) {
    return {
      tradable: false,
      reason: `Tradability guard: asset check for ${symbol} threw (${err instanceof Error ? err.message : String(err)}); failing closed (rejecting the BUY).`,
      fromCache: false,
    };
  }
}
