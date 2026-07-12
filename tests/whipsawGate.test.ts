import test from "node:test";
import assert from "node:assert/strict";
import { applyWhipsawGate, normalizeWhipsawVerdict } from "../src/server/whipsawGate";

// --- SELL gating -----------------------------------------------------------

test("SELL + whipsaw is downgraded to HOLD (selling into a shakeout locks in the dip)", () => {
  const result = applyWhipsawGate("SELL", "whipsaw", 80);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.downgraded, true);
  assert.ok(result.note && /whipsaw/i.test(result.note));
});

test("SELL + unclear is downgraded to HOLD (fail closed: reversal not verified)", () => {
  const result = applyWhipsawGate("SELL", "unclear", 80);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.downgraded, true);
});

test("SELL + reversal proceeds as SELL (verified trend reversal)", () => {
  const result = applyWhipsawGate("SELL", "reversal", 80);
  assert.equal(result.decision, "SELL");
  assert.equal(result.downgraded, false);
});

// --- BUY confidence haircut --------------------------------------------------

test("BUY + reversal halves confidence (riskiest entry: buying into a verified downtrend reversal)", () => {
  const result = applyWhipsawGate("BUY", "reversal", 80);
  assert.equal(result.decision, "BUY");
  assert.equal(result.aiConfidence, 40);
  assert.equal(result.downgraded, false);
});

test("BUY + unclear multiplies confidence by 0.75", () => {
  const result = applyWhipsawGate("BUY", "unclear", 80);
  assert.equal(result.decision, "BUY");
  assert.equal(result.aiConfidence, 60);
});

test("BUY + whipsaw keeps confidence unchanged (buying a shakeout dip is the strategy's core case)", () => {
  const result = applyWhipsawGate("BUY", "whipsaw", 80);
  assert.equal(result.decision, "BUY");
  assert.equal(result.aiConfidence, 80);
});

test("BUY confidence haircut clamps to the existing [0, 100] range", () => {
  const result = applyWhipsawGate("BUY", "reversal", 100);
  assert.ok(result.aiConfidence <= 100 && result.aiConfidence >= 0);
});

// --- Defensive validation ---------------------------------------------------

test("an invalid whipsawVerdict string is treated as unclear for a SELL (downgraded to HOLD)", () => {
  const result = applyWhipsawGate("SELL", "definitely-a-reversal-trust-me", 80);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.downgraded, true);
});

test("an invalid whipsawVerdict string is treated as unclear for a BUY (0.75x haircut)", () => {
  const result = applyWhipsawGate("BUY", "not-a-real-verdict", 80);
  assert.equal(result.decision, "BUY");
  assert.equal(result.aiConfidence, 60);
});

test("a missing/undefined whipsawVerdict is treated as unclear", () => {
  const result = applyWhipsawGate("SELL", undefined, 80);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.downgraded, true);
});

test("normalizeWhipsawVerdict maps any non-enum value to unclear and passes through valid values", () => {
  assert.equal(normalizeWhipsawVerdict("whipsaw"), "whipsaw");
  assert.equal(normalizeWhipsawVerdict("reversal"), "reversal");
  assert.equal(normalizeWhipsawVerdict("unclear"), "unclear");
  assert.equal(normalizeWhipsawVerdict("REVERSAL"), "unclear");
  assert.equal(normalizeWhipsawVerdict(""), "unclear");
  assert.equal(normalizeWhipsawVerdict(null), "unclear");
  assert.equal(normalizeWhipsawVerdict(123), "unclear");
});

// --- Pass-through for non-gated decisions -----------------------------------

test("HOLD passes through unchanged regardless of verdict", () => {
  const result = applyWhipsawGate("HOLD", "whipsaw", 55);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.aiConfidence, 55);
  assert.equal(result.downgraded, false);
});

test("NONE passes through unchanged regardless of verdict", () => {
  const result = applyWhipsawGate("NONE", "unclear", 10);
  assert.equal(result.decision, "NONE");
  assert.equal(result.aiConfidence, 10);
  assert.equal(result.downgraded, false);
});
