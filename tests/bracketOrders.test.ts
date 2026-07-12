import test from "node:test";
import assert from "node:assert/strict";
import { roundDownToTick, buildBracketLegs, BRACKET_TIME_IN_FORCE, PLAIN_TIME_IN_FORCE } from "../src/server/bracketOrders";

// --- roundDownToTick: tick rounding, both regimes, exact-tick passthrough ---

test("roundDownToTick: >= $1.00 rounds DOWN to the nearest cent", () => {
  assert.equal(roundDownToTick(123.456), 123.45);
  assert.equal(roundDownToTick(1.999), 1.99);
});

test("roundDownToTick: >= $1.00 exact-tick value passes through unchanged", () => {
  assert.equal(roundDownToTick(100.3), 100.3);
  assert.equal(roundDownToTick(1.0), 1.0);
  assert.equal(roundDownToTick(250.5), 250.5);
});

test("roundDownToTick: below $1.00 rounds DOWN to the nearest $0.0001", () => {
  assert.equal(roundDownToTick(0.12345), 0.1234);
  assert.equal(roundDownToTick(0.99999), 0.9999);
});

test("roundDownToTick: below $1.00 exact-tick value passes through unchanged", () => {
  assert.equal(roundDownToTick(0.5678), 0.5678);
  assert.equal(roundDownToTick(0.0001), 0.0001);
});

test("roundDownToTick: the $1.00 boundary itself uses the cent tick (>= $1.00 rule)", () => {
  assert.equal(roundDownToTick(1.0001), 1.0);
});

// --- buildBracketLegs: validation, rounding application, degenerate detection ---

test("buildBracketLegs: a valid buy-side plan returns rounded take-profit/stop-loss legs", () => {
  const result = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: 94.999,
    takeProfitPrice: 114.999,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.legs.stopLossStopPrice, 94.99);
    assert.equal(result.legs.takeProfitLimitPrice, 114.99);
  }
});

test("buildBracketLegs: sub-$1 entry rounds legs to the four-decimal tick", () => {
  const result = buildBracketLegs({
    side: "buy",
    entryEstimate: 0.5,
    stopLossPrice: 0.47501,
    takeProfitPrice: 0.57501,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.legs.stopLossStopPrice, 0.475);
    assert.equal(result.legs.takeProfitLimitPrice, 0.575);
  }
});

test("buildBracketLegs: sell side is never eligible for a bracket (brackets only wrap BUY entries)", () => {
  const result = buildBracketLegs({
    side: "sell",
    entryEstimate: 100,
    stopLossPrice: 105,
    takeProfitPrice: 90,
  });
  assert.equal(result.ok, false);
});

test("buildBracketLegs: degenerate plan (stop >= take-profit) fails validation instead of fabricating prices", () => {
  const result = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: 110,
    takeProfitPrice: 105, // stop above take-profit: inverted/degenerate
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /degenerate|stop|take.?profit/i);
});

test("buildBracketLegs: take-profit equal to entry is degenerate (not strictly > entry)", () => {
  const result = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: 100,
    takeProfitPrice: 100,
  });
  assert.equal(result.ok, false);
});

test("buildBracketLegs: stop-loss above entry is degenerate", () => {
  const result = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: 101,
    takeProfitPrice: 110,
  });
  assert.equal(result.ok, false);
});

test("buildBracketLegs: non-finite/garbage stop or take-profit fails closed (no fabricated prices)", () => {
  const badStop = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: "not-a-number" as unknown as number,
    takeProfitPrice: 110,
  });
  assert.equal(badStop.ok, false);

  const badTp = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: 90,
    takeProfitPrice: undefined,
  });
  assert.equal(badTp.ok, false);

  const badEntry = buildBracketLegs({
    side: "buy",
    entryEstimate: Number.NaN,
    stopLossPrice: 90,
    takeProfitPrice: 110,
  });
  assert.equal(badEntry.ok, false);
});

test("buildBracketLegs: rounding a would-be-valid plan down to the tick can itself create a degenerate collision, and that is still rejected", () => {
  // stop and take-profit both round down into the same tick (extremely tight plan).
  const result = buildBracketLegs({
    side: "buy",
    entryEstimate: 100,
    stopLossPrice: 99.994,
    takeProfitPrice: 99.996,
  });
  assert.equal(result.ok, false);
});

// --- time-in-force constants (disclosed bracket behavior change) ---

test("time-in-force constants: bracket orders use gtc (whole-bracket shared value), plain orders keep day", () => {
  assert.equal(BRACKET_TIME_IN_FORCE, "gtc");
  assert.equal(PLAIN_TIME_IN_FORCE, "day");
});
