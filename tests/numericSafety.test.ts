import test from "node:test";
import assert from "node:assert/strict";
import { parseFiniteNumber } from "../src/server/numericSafety";

const INVALID_VALUES: unknown[] = [NaN, Infinity, -Infinity, undefined, null, "", "garbage", {}, [1, 2]];

test("rejects every invalid numeric shape", () => {
  for (const value of INVALID_VALUES) {
    const result = parseFiniteNumber(value, "field");
    assert.equal(result.ok, false, `expected rejection for ${String(value)}`);
    if (!result.ok) assert.equal(result.fieldName, "field");
  }
});

test("accepts finite numbers and numeric strings", () => {
  for (const value of [0, -12.5, 1e6, "42", "3.14"]) {
    const result = parseFiniteNumber(value, "field");
    assert.equal(result.ok, true, `expected acceptance for ${String(value)}`);
    if (result.ok) assert.equal(Number.isFinite(result.value), true);
  }
});
