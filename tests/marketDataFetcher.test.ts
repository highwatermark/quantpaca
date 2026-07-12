import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSmaTrendPercent,
  computeDrawdownPercent,
  computeRealizedVolPercent,
  parseCloseSeries,
  fetchMarketRegimeInputs,
  BTC_PROXY_SYMBOL,
  TREND_LONG_WINDOW,
  TREND_SHORT_WINDOW,
  VOL_WINDOW,
} from "../src/server/marketDataFetcher";

// --- parseCloseSeries: fail-closed bar parsing -----------------------------

test("parseCloseSeries: a NaN/non-numeric close anywhere in the series makes the whole series unavailable", () => {
  const bars = [
    { t: "2026-01-01T00:00:00Z", c: 100 },
    { t: "2026-01-02T00:00:00Z", c: "not-a-number" },
    { t: "2026-01-03T00:00:00Z", c: 102 },
  ];
  const result = parseCloseSeries(bars, "SPY");
  assert.equal(result.ok, false);
});

test("parseCloseSeries: an empty bars array is unavailable", () => {
  const result = parseCloseSeries([], "SPY");
  assert.equal(result.ok, false);
});

test("parseCloseSeries: sorts by timestamp ascending regardless of input order and extracts numeric closes", () => {
  const bars = [
    { t: "2026-01-03T00:00:00Z", c: 102 },
    { t: "2026-01-01T00:00:00Z", c: 100 },
    { t: "2026-01-02T00:00:00Z", c: "101" }, // numeric string closes are valid via parseFiniteNumber
  ];
  const result = parseCloseSeries(bars, "SPY");
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.closes, [100, 101, 102]);
    assert.equal(result.lastTimestamp, "2026-01-03T00:00:00Z");
  }
});

// --- computeSmaTrendPercent -------------------------------------------------

test("trend: exact-length series (30 closes @100 + 20 closes @110) -- hand-computed sma20=110, sma50=104, trend=(110-104)/104*100", () => {
  const closes = [...Array(30).fill(100), ...Array(20).fill(110)];
  assert.equal(closes.length, TREND_LONG_WINDOW);
  const result = computeSmaTrendPercent(closes);
  assert.ok(result.ok, JSON.stringify(result));
  if (result.ok) {
    const expected = ((110 - 104) / 104) * 100; // 5.769230769...
    assert.ok(Math.abs(result.trendPercent - expected) < 1e-9, `expected ~${expected}, got ${result.trendPercent}`);
  }
});

test("trend: insufficient bars (fewer than 50) is unavailable", () => {
  const closes = Array(TREND_LONG_WINDOW - 1).fill(100);
  const result = computeSmaTrendPercent(closes);
  assert.equal(result.ok, false);
});

test("trend: monotonic rise produces a trend_up-compatible input (> 3%)", () => {
  // 30 closes @100, then 20 closes @130 -- a clear step up, non-decreasing overall.
  const closes = [...Array(30).fill(100), ...Array(20).fill(130)];
  const result = computeSmaTrendPercent(closes);
  assert.ok(result.ok);
  if (result.ok) {
    // sma20 = 130, sma50 = (30*100 + 20*130)/50 = 112, trend = (130-112)/112*100 = 16.0714...%
    assert.ok(result.trendPercent > 3, `expected trend_up-compatible (>3%), got ${result.trendPercent}`);
  }
});

// --- computeDrawdownPercent -------------------------------------------------

test("drawdown: hand-computed -- closes [100, 110, 90] -- current 90 vs peak 110 -- (90-110)/110*100", () => {
  const result = computeDrawdownPercent([100, 110, 90]);
  assert.ok(result.ok);
  if (result.ok) {
    const expected = ((90 - 110) / 110) * 100; // -18.1818...
    assert.ok(Math.abs(result.drawdownPercent - expected) < 1e-9);
  }
});

test("drawdown: current close at the peak of the window is 0% drawdown", () => {
  const result = computeDrawdownPercent([90, 95, 100]);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.drawdownPercent, 0);
});

test("drawdown: an empty series is unavailable", () => {
  const result = computeDrawdownPercent([]);
  assert.equal(result.ok, false);
});

// --- computeRealizedVolPercent ----------------------------------------------

test("realized vol: insufficient bars (fewer than window+1) is unavailable", () => {
  const closes = Array(VOL_WINDOW).fill(100); // exactly window closes -> only window-1 returns
  const result = computeRealizedVolPercent(closes);
  assert.equal(result.ok, false);
});

test("realized vol: exact-length series (21 closes, alternating +2%/-2% returns) matches the independently-derived sample-stdev formula", () => {
  // 20 returns alternating +2%, -2%, +2%, -2%, ... (10 of each) -> mean is exactly
  // 0 by symmetry, so sample variance simplifies to sum(r^2)/(n-1) = (20*0.02^2)/19.
  const closes = [100];
  for (let i = 0; i < VOL_WINDOW; i++) {
    const r = i % 2 === 0 ? 0.02 : -0.02;
    closes.push(closes[closes.length - 1] * (1 + r));
  }
  assert.equal(closes.length, VOL_WINDOW + 1);

  const result = computeRealizedVolPercent(closes);
  assert.ok(result.ok, JSON.stringify(result));
  if (result.ok) {
    const expectedVariance = (VOL_WINDOW * 0.02 ** 2) / (VOL_WINDOW - 1);
    const expectedVolPercent = Math.sqrt(expectedVariance) * Math.sqrt(252) * 100;
    assert.ok(
      Math.abs(result.volatilityPercent - expectedVolPercent) < 1e-6,
      `expected ~${expectedVolPercent}, got ${result.volatilityPercent}`,
    );
  }
});

test("realized vol: a constant-return series (zero variance) yields 0% realized vol", () => {
  const closes = [100];
  for (let i = 0; i < VOL_WINDOW; i++) {
    closes.push(closes[closes.length - 1] * 1.01);
  }
  const result = computeRealizedVolPercent(closes);
  assert.ok(result.ok);
  if (result.ok) assert.ok(Math.abs(result.volatilityPercent - 0) < 1e-9);
});

// --- fetchMarketRegimeInputs: orchestration (bounded fetch, partial failure) ---

function mildRiseBars(count = 60, start = 400, step = 0.05) {
  return Array.from({ length: count }, (_, i) => ({
    t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    c: start + i * step,
  }));
}

test("fetchMarketRegimeInputs: broker not configured skips the fetch entirely (zero requests)", async () => {
  let calls = 0;
  const result = await fetchMarketRegimeInputs({
    brokerConfig: { configured: false },
    dataBaseUrl: "https://data.alpaca.markets",
    fetchImpl: (async () => {
      calls++;
      throw new Error("must not be called");
    }) as unknown as typeof fetch,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.inputs, {});
  assert.ok(result.unavailableReasons.length > 0);
});

test("fetchMarketRegimeInputs: exactly 3 requests (SPY, QQQ, BTC proxy), one per symbol, bounded", async () => {
  const requestedUrls: string[] = [];
  await fetchMarketRegimeInputs({
    brokerConfig: { configured: true, apiKey: "k", secretKey: "s" },
    dataBaseUrl: "https://data.alpaca.markets",
    fetchImpl: (async (input: any) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ bars: mildRiseBars() }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  assert.equal(requestedUrls.length, 3);
  assert.ok(requestedUrls.some((u) => u.includes("/stocks/SPY/bars")));
  assert.ok(requestedUrls.some((u) => u.includes("/stocks/QQQ/bars")));
  assert.ok(requestedUrls.some((u) => u.includes(`/stocks/${BTC_PROXY_SYMBOL}/bars`)));
});

test("fetchMarketRegimeInputs: partial failure -- SPY succeeds, QQQ returns non-OK, BTC proxy throws -- yields partial-but-honest inputs, never a thrown exception", async () => {
  const result = await fetchMarketRegimeInputs({
    brokerConfig: { configured: true, apiKey: "k", secretKey: "s" },
    dataBaseUrl: "https://data.alpaca.markets",
    fetchImpl: (async (input: any) => {
      const url = String(input);
      if (url.includes("/stocks/SPY/")) {
        return new Response(JSON.stringify({ bars: mildRiseBars() }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/stocks/QQQ/")) {
        return new Response("not found", { status: 404 });
      }
      throw new Error("simulated network failure");
    }) as unknown as typeof fetch,
  });

  assert.equal(typeof result.inputs.spyTrendPercent, "number", "SPY succeeded -- its fields should be present");
  assert.equal(typeof result.inputs.broadMarketDrawdownPercent, "number");
  assert.equal(typeof result.inputs.volatilityProxyPercent, "number");
  assert.equal(result.inputs.qqqTrendPercent, undefined, "QQQ's non-OK response must not produce a value");
  assert.equal(result.inputs.btcTrendPercent, undefined, "the BTC proxy's thrown error must not produce a value");
  assert.equal(result.unavailableReasons.length, 2, `expected exactly 2 unavailable reasons, got: ${JSON.stringify(result.unavailableReasons)}`);
});
