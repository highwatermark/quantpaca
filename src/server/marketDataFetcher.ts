// Task 8 (docs/GO_LIVE_PLAN.md Phase 1.3): feeds detectRegime (regimeEngine.ts)
// real SPY/QQQ/BTC-proxy daily bars instead of the permanent `detectRegime({})`
// call server.ts made previously. This module is intentionally pure computation
// plus one fetch helper -- regimeEngine.ts's decision logic is untouched; this
// module only assembles its inputs.
//
// Fail-closed contract (binding, see docs/GO_LIVE_PLAN.md): every bar close is
// parsed via parseFiniteNumber. Any missing/invalid series (insufficient bars,
// a non-finite close anywhere in the series, a failed/non-OK fetch) marks that
// series "unavailable" -- its corresponding detectRegime input field is simply
// omitted (never invented/interpolated). detectRegime's own hasMarketData check
// already degrades to the conservative default when every field is missing, so
// "all three symbols failed" and "detectRegime({})" produce the identical result
// without this module needing a special case for it.
import { parseFiniteNumber } from "./numericSafety";

// -- Named constants (no env vars, per the plan's binding constraints) -------

// 30 minutes: a persisted regime assessment older than this is not reused by
// the sync wiring in server.ts -- it refetches instead. Named constant, not an
// env var, per the task brief.
export const REGIME_STALENESS_MS = 30 * 60 * 1000;

// Per-request fetch timeout (AbortSignal.timeout). There is no pre-existing
// fetch-timeout pattern elsewhere in this repo; this is a small, scoped
// addition local to this module.
export const FETCH_TIMEOUT_MS = 10_000;

// Trend: 20-day SMA vs 50-day SMA (per the brief). Realized vol: 20-day window
// (needs 21 closes to produce 20 daily returns). ~60 bars requested gives every
// computation headroom without a second page of results.
export const TREND_SHORT_WINDOW = 20;
export const TREND_LONG_WINDOW = 50;
export const VOL_WINDOW = 20;
export const TRADING_DAYS_PER_YEAR = 252;
export const BARS_LIMIT = 60;

// BTC proxy: Alpaca's stocks market-data API doesn't serve crypto, and the
// existing market-data code in server.ts only ever talks to the stocks bars
// endpoint. BITO (ProShares Bitcoin Strategy ETF) is a regular US-listed
// equity tradable through the same /v2/stocks/{symbol}/bars endpoint, host,
// and auth headers as SPY/QQQ -- no second API surface needed. See the task
// report for why this is fetched (bounded to 3 symbols) but only actually
// changes detectRegime's *reason text* for crypto-linked equities (MARA, RIOT,
// COIN, MSTR), not marketMode/tradePermission/sizeMultiplier.
export const BTC_PROXY_SYMBOL = "BITO";

export type MarketRegimeInputs = {
  spyTrendPercent?: number;
  qqqTrendPercent?: number;
  broadMarketDrawdownPercent?: number;
  volatilityProxyPercent?: number;
  btcTrendPercent?: number;
};

export type MarketRegimeFetchResult = {
  // Newest bar timestamp across every symbol that returned usable bars, or the
  // fetch time if every symbol failed. Used by server.ts to decide whether a
  // persisted assessment is still fresh enough to reuse.
  asOf: string;
  inputs: MarketRegimeInputs;
  // Human-readable reasons for every symbol/computation that came back
  // unavailable this fetch, for sync-log visibility (never thrown).
  unavailableReasons: string[];
};

// --- Pure computations -------------------------------------------------------

// Flat (non-discriminated-union) return shapes deliberately, matching the
// convention already established in exitMonitor.ts: this project's tsconfig
// does not enable `strict`, so TypeScript's control-flow narrowing of a
// boolean-literal-discriminated union across an `if (!result.ok) return; ...
// result.value` access is unreliable. Every result below always carries every
// field; the failure branch just carries a sentinel value (0/NaN/[]) alongside
// `reason` explaining why it's not meaningful.
export type CloseSeriesResult = { ok: boolean; closes: number[]; lastTimestamp?: string; reason: string };

// Parses raw Alpaca bar objects ({ t, c, ... }) into a chronologically-sorted
// (ascending) array of numeric closes. Fails closed: a bars array that's empty,
// or that contains even one bar whose `c` doesn't parse via parseFiniteNumber,
// makes the WHOLE series unavailable -- never drop the bad bar and continue,
// since that would silently interpolate around missing/garbage data.
export function parseCloseSeries(bars: unknown[], symbolLabel: string): CloseSeriesResult {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { ok: false, closes: [], reason: `${symbolLabel}: no bars returned` };
  }

  const sorted = [...bars].sort((a, b) => {
    const ta = typeof (a as { t?: unknown })?.t === "string" ? (a as { t: string }).t : "";
    const tb = typeof (b as { t?: unknown })?.t === "string" ? (b as { t: string }).t : "";
    return ta.localeCompare(tb);
  });

  const closes: number[] = [];
  let lastTimestamp: string | undefined;
  for (const bar of sorted) {
    const closeParsed = parseFiniteNumber((bar as { c?: unknown })?.c, "close");
    if (!closeParsed.ok) {
      return { ok: false, closes: [], reason: `${symbolLabel}: encountered a non-finite close in the bar series` };
    }
    closes.push(closeParsed.value);
    const t = (bar as { t?: unknown })?.t;
    if (typeof t === "string") lastTimestamp = t;
  }

  return { ok: true, closes, lastTimestamp, reason: "" };
}

export type TrendResult = { ok: boolean; trendPercent: number; reason: string };

// 20-day SMA vs 50-day SMA, expressed as a percent: (sma20 - sma50) / sma50 * 100.
export function computeSmaTrendPercent(
  closes: number[],
  shortWindow = TREND_SHORT_WINDOW,
  longWindow = TREND_LONG_WINDOW,
): TrendResult {
  if (closes.length < longWindow) {
    return { ok: false, trendPercent: NaN, reason: `insufficient bars for trend: need >= ${longWindow}, got ${closes.length}` };
  }
  const shortSma = average(closes.slice(closes.length - shortWindow));
  const longSma = average(closes.slice(closes.length - longWindow));
  if (longSma === 0) {
    return { ok: false, trendPercent: NaN, reason: "long SMA is zero; cannot compute trend percent" };
  }
  return { ok: true, trendPercent: ((shortSma - longSma) / longSma) * 100, reason: "" };
}

export type DrawdownResult = { ok: boolean; drawdownPercent: number; reason: string };

// Current close vs the max close over the fetched window, expressed as a
// (non-positive) percent: (current - max) / max * 100.
export function computeDrawdownPercent(closes: number[]): DrawdownResult {
  if (closes.length === 0) {
    return { ok: false, drawdownPercent: NaN, reason: "no closes available for drawdown" };
  }
  const current = closes[closes.length - 1];
  const maxClose = Math.max(...closes);
  if (maxClose === 0) {
    return { ok: false, drawdownPercent: NaN, reason: "max close is zero; cannot compute drawdown" };
  }
  return { ok: true, drawdownPercent: ((current - maxClose) / maxClose) * 100, reason: "" };
}

export type VolResult = { ok: boolean; volatilityPercent: number; reason: string };

// 20-day annualized realized vol of daily returns: sample stddev(returns) * sqrt(252) * 100.
export function computeRealizedVolPercent(closes: number[], window = VOL_WINDOW): VolResult {
  const needed = window + 1;
  if (closes.length < needed) {
    return { ok: false, volatilityPercent: NaN, reason: `insufficient bars for volatility: need >= ${needed}, got ${closes.length}` };
  }
  const recent = closes.slice(closes.length - needed);
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    if (prev === 0) {
      return { ok: false, volatilityPercent: NaN, reason: "encountered a zero close computing daily returns" };
    }
    returns.push((recent[i] - prev) / prev);
  }
  const mean = average(returns);
  const n = returns.length;
  const variance = n > 1 ? returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (n - 1) : 0;
  const dailyStdDev = Math.sqrt(variance);
  return { ok: true, volatilityPercent: dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100, reason: "" };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// --- Fetch (the one fetch helper) -------------------------------------------

type DailyBarsResult = { ok: boolean; bars: unknown[]; reason: string };

// The single fetch helper: bars for one symbol from Alpaca's market-data API.
// Follows the existing host/auth pattern already used in server.ts's price
// lookup (data.alpaca.markets, APCA-API-KEY-ID / APCA-API-SECRET-KEY headers) --
// NOT the trading host. Never throws: every failure mode (network error,
// timeout, non-OK response, malformed body) is caught and returned as
// `{ ok: false, reason }` so a single symbol's failure can't take down the
// other two fetches or the caller's control flow.
async function fetchDailyBars(
  symbol: string,
  options: { dataBaseUrl: string; apiKey?: string; secretKey?: string; fetchImpl: typeof fetch },
): Promise<DailyBarsResult> {
  try {
    const res = await options.fetchImpl(
      `${options.dataBaseUrl}/v2/stocks/${symbol}/bars?timeframe=1Day&limit=${BARS_LIMIT}`,
      {
        headers: {
          "APCA-API-KEY-ID": options.apiKey || "",
          "APCA-API-SECRET-KEY": options.secretKey || "",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      return { ok: false, bars: [], reason: `${symbol} bars request failed with status ${res.status}` };
    }
    const body = await res.json();
    const bars = Array.isArray((body as { bars?: unknown })?.bars) ? (body as { bars: unknown[] }).bars : null;
    if (!bars) {
      return { ok: false, bars: [], reason: `${symbol} bars response was missing a bars array` };
    }
    return { ok: true, bars, reason: "" };
  } catch (err) {
    return { ok: false, bars: [], reason: `${symbol} bars fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type FetchMarketRegimeInputsOptions = {
  brokerConfig: { configured: boolean; apiKey?: string; secretKey?: string };
  dataBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

// Fetches SPY, QQQ, and the BTC proxy daily bars (bounded: 3 symbols, 1 request
// each) and assembles detectRegime's input contract. Never throws -- every
// per-symbol/per-computation failure degrades that field to "absent" rather
// than aborting the whole assessment (partial-but-honest inputs; detectRegime's
// own hasMarketData check degrades further to the conservative default if
// nothing at all came back).
export async function fetchMarketRegimeInputs(options: FetchMarketRegimeInputsOptions): Promise<MarketRegimeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const unavailableReasons: string[] = [];
  const inputs: MarketRegimeInputs = {};

  if (!options.brokerConfig.configured) {
    return {
      asOf: now().toISOString(),
      inputs,
      unavailableReasons: ["Broker not configured (no Alpaca API credentials); skipping market-data fetch for regime inputs."],
    };
  }

  const fetchOne = (symbol: string) =>
    fetchDailyBars(symbol, {
      dataBaseUrl: options.dataBaseUrl,
      apiKey: options.brokerConfig.apiKey,
      secretKey: options.brokerConfig.secretKey,
      fetchImpl,
    });

  const [spy, qqq, btc] = await Promise.all([fetchOne("SPY"), fetchOne("QQQ"), fetchOne(BTC_PROXY_SYMBOL)]);

  let newestTimestamp: string | undefined;
  const noteNewest = (t?: string) => {
    if (t && (!newestTimestamp || t > newestTimestamp)) newestTimestamp = t;
  };

  // SPY: trend + broad-market drawdown + volatility proxy.
  if (!spy.ok) {
    unavailableReasons.push(spy.reason);
  } else {
    const series = parseCloseSeries(spy.bars, "SPY");
    if (!series.ok) {
      unavailableReasons.push(series.reason);
    } else {
      noteNewest(series.lastTimestamp);
      const trend = computeSmaTrendPercent(series.closes);
      if (trend.ok) inputs.spyTrendPercent = trend.trendPercent;
      else unavailableReasons.push(`SPY trend: ${trend.reason}`);

      const drawdown = computeDrawdownPercent(series.closes);
      if (drawdown.ok) inputs.broadMarketDrawdownPercent = drawdown.drawdownPercent;
      else unavailableReasons.push(`SPY drawdown: ${drawdown.reason}`);

      const vol = computeRealizedVolPercent(series.closes);
      if (vol.ok) inputs.volatilityProxyPercent = vol.volatilityPercent;
      else unavailableReasons.push(`SPY volatility: ${vol.reason}`);
    }
  }

  // QQQ: trend only.
  if (!qqq.ok) {
    unavailableReasons.push(qqq.reason);
  } else {
    const series = parseCloseSeries(qqq.bars, "QQQ");
    if (!series.ok) {
      unavailableReasons.push(series.reason);
    } else {
      noteNewest(series.lastTimestamp);
      const trend = computeSmaTrendPercent(series.closes);
      if (trend.ok) inputs.qqqTrendPercent = trend.trendPercent;
      else unavailableReasons.push(`QQQ trend: ${trend.reason}`);
    }
  }

  // BTC proxy: trend only (detectRegime only consumes btcTrendPercent for the
  // reason text of crypto-linked equities -- see the module comment above).
  if (!btc.ok) {
    unavailableReasons.push(btc.reason);
  } else {
    const series = parseCloseSeries(btc.bars, BTC_PROXY_SYMBOL);
    if (!series.ok) {
      unavailableReasons.push(series.reason);
    } else {
      noteNewest(series.lastTimestamp);
      const trend = computeSmaTrendPercent(series.closes);
      if (trend.ok) inputs.btcTrendPercent = trend.trendPercent;
      else unavailableReasons.push(`${BTC_PROXY_SYMBOL} trend: ${trend.reason}`);
    }
  }

  return { asOf: newestTimestamp || now().toISOString(), inputs, unavailableReasons };
}
