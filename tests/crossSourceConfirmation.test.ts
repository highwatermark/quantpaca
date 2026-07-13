import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCrossSource,
  CROSS_SOURCE_WINDOW_HOURS,
  CROSS_SOURCE_BOOST_MULTIPLIER,
} from "../src/server/crossSourceConfirmation";

// Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, "Cross-source confirmation
// bonus"): pure unit tests for the module's core decision logic, mirroring
// the fixture-free style of tests/bearishMapping.test.ts and
// tests/whipsawGate.test.ts. Integration coverage (real /api/sync wiring,
// boosted confidence flowing into a persisted signal, a conflict landing
// requires_human_approval via the risk engine) lives in
// tests/crossSourceConfirmationIntegration.test.ts.

const NOW = new Date("2026-07-12T12:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

test("bullish + prior bullish from another source within 72h boosts confidence by the bounded multiplier", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "michael-burry", stance: "bullish", sourceTimestamp: hoursAgo(10) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "boost", multiplier: CROSS_SOURCE_BOOST_MULTIPLIER });
  assert.equal(CROSS_SOURCE_BOOST_MULTIPLIER, 1.2);
});

test("bullish + prior bearish from another source is a conflict", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "michael-burry", stance: "bearish", sourceTimestamp: hoursAgo(10) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "conflict" });
});

test("bearish + prior bullish from another source is also a conflict (symmetric)", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "michael-burry",
    stance: "bearish",
    recentSignals: [{ source: "motley-fool", stance: "bullish", sourceTimestamp: hoursAgo(10) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "conflict" });
});

test("a single source (no recent signals) never boosts or conflicts", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "none" });
});

test("same source re-affirming (different email, same source id) never self-boosts", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "motley-fool", stance: "bullish", sourceTimestamp: hoursAgo(1) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "none" }, "a same-source repeat must be filtered out before agreement/conflict is evaluated");
});

test("a 73h-old prior signal (just outside the 72h window) does not count", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "michael-burry", stance: "bullish", sourceTimestamp: hoursAgo(73) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "none" });
  assert.equal(CROSS_SOURCE_WINDOW_HOURS, 72);
});

test("a prior signal exactly at the 72h boundary still counts", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "michael-burry", stance: "bullish", sourceTimestamp: hoursAgo(72) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "boost", multiplier: CROSS_SOURCE_BOOST_MULTIPLIER });
});

test("a neutral prior signal never boosts nor conflicts", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "michael-burry", stance: "neutral", sourceTimestamp: hoursAgo(5) }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "none" });
});

test("a neutral current stance is always inert, even with bullish/bearish corroboration present", () => {
  const bullishCorroboration = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "neutral",
    recentSignals: [{ source: "michael-burry", stance: "bullish", sourceTimestamp: hoursAgo(5) }],
    now: NOW,
  });
  assert.deepEqual(bullishCorroboration, { effect: "none" });

  const bearishCorroboration = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "neutral",
    recentSignals: [{ source: "michael-burry", stance: "bearish", sourceTimestamp: hoursAgo(5) }],
    now: NOW,
  });
  assert.deepEqual(bearishCorroboration, { effect: "none" });
});

test("multiple agreeing bullish sources still produce a single bounded boost, not a stacked one", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [
      { source: "michael-burry", stance: "bullish", sourceTimestamp: hoursAgo(10) },
      { source: "youtube-sentiment", stance: "bullish", sourceTimestamp: hoursAgo(20) },
    ],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "boost", multiplier: CROSS_SOURCE_BOOST_MULTIPLIER });
});

test("conflict takes precedence over boost when both an agreeing and a disagreeing source are present", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [
      { source: "michael-burry", stance: "bullish", sourceTimestamp: hoursAgo(10) },
      { source: "youtube-sentiment", stance: "bearish", sourceTimestamp: hoursAgo(20) },
    ],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "conflict" }, "conflicts always fail toward human review, never auto-resolution -- must win over a boost");
});

test("youtube-sentiment participates as an ordinary source (both as the current signal and as corroboration)", () => {
  const asCurrent = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "youtube-sentiment",
    stance: "bullish",
    recentSignals: [{ source: "motley-fool", stance: "bullish", sourceTimestamp: hoursAgo(5) }],
    now: NOW,
  });
  assert.deepEqual(asCurrent, { effect: "boost", multiplier: CROSS_SOURCE_BOOST_MULTIPLIER });

  const asCorroboration = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "youtube-sentiment", stance: "bullish", sourceTimestamp: hoursAgo(5) }],
    now: NOW,
  });
  assert.deepEqual(asCorroboration, { effect: "boost", multiplier: CROSS_SOURCE_BOOST_MULTIPLIER });
});

test("an unparsable prior sourceTimestamp is defensively excluded, not treated as in-window", () => {
  const result = evaluateCrossSource({
    symbol: "XYZ",
    currentSource: "motley-fool",
    stance: "bullish",
    recentSignals: [{ source: "michael-burry", stance: "bullish", sourceTimestamp: "not-a-date" }],
    now: NOW,
  });
  assert.deepEqual(result, { effect: "none" });
});
