import test from "node:test";
import assert from "node:assert/strict";
import { loadRiskLimits } from "../src/server/riskLimits";

test("defaults load when env is empty", () => {
  const result = loadRiskLimits({} as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.limits.maxDailyLoss, 500);
    assert.equal(result.limits.baselineEquity, null);
    assert.equal(result.limits.maxPortfolioExposurePercent, 60);
  }
});

test("a custom valid QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT is honored", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT: "80" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.limits.maxPortfolioExposurePercent, 80);
});

test("an unparsable QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT is a startup error", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT: "lots" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors[0].includes("QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT"));
});

test("a non-positive QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT is a startup error", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT: "0" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
});

test("a QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT above 100 is a startup error", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT: "101" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors[0].includes("QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT"));
});

test("env overrides win", () => {
  const result = loadRiskLimits({
    QUANTPACA_MAX_DAILY_LOSS: "250",
    QUANTPACA_BASELINE_EQUITY: "100000",
  } as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.limits.maxDailyLoss, 250);
    assert.equal(result.limits.baselineEquity, 100000);
  }
});

test("an unparsable limit is a startup error, not a silent default", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_DAILY_LOSS: "lots" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors[0].includes("QUANTPACA_MAX_DAILY_LOSS"));
});

test("a non-positive limit is a startup error", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_OPEN_POSITIONS: "0" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
});
