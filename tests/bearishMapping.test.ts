import test from "node:test";
import assert from "node:assert/strict";
import { DO_NOT_BUY_DAYS, evaluateBearishMapping, normalizeStance, THESIS_INVALIDATION_DAYS } from "../src/server/bearishMapping";

// Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
// Burry Substack, long-only bearish mapping). Pure unit tests for the
// decision-execution mapping layer; end-to-end acceptance tests (email
// fixture -> /api/sync -> trade/do-not-buy state) live in
// tests/michaelBurrySource.test.ts, mirroring motleyFoolSource.test.ts.

test("normalizeStance: the three valid values pass through unchanged", () => {
  assert.equal(normalizeStance("bullish"), "bullish");
  assert.equal(normalizeStance("bearish"), "bearish");
  assert.equal(normalizeStance("neutral"), "neutral");
});

test("normalizeStance: defensive parse -- anything else (including undefined/missing) fails closed to neutral, never trades", () => {
  assert.equal(normalizeStance(undefined), "neutral");
  assert.equal(normalizeStance(null), "neutral");
  assert.equal(normalizeStance(""), "neutral");
  assert.equal(normalizeStance("BEARISH"), "neutral"); // case-sensitive, no fuzzy matching
  assert.equal(normalizeStance("short"), "neutral");
  assert.equal(normalizeStance(42), "neutral");
  assert.equal(normalizeStance({}), "neutral");
});

test("named constants: do-not-buy and thesis-invalidation windows both default to 30 days", () => {
  assert.equal(DO_NOT_BUY_DAYS, 30);
  assert.equal(THESIS_INVALIDATION_DAYS, 30);
});

test("SELL + bearish + HELD + whipsaw gate approved (not downgraded) -> thesis_invalidation", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "michael-burry",
    originalDecision: "SELL",
    stance: "bearish",
    symbolHeld: true,
    whipsawDowngraded: false,
    now,
  });
  assert.equal(result.kind, "thesis_invalidation");
  if (result.kind !== "thesis_invalidation") throw new Error("unreachable");
  assert.equal(result.symbol, "NVDA");
  assert.equal(result.sourceId, "michael-burry");
  assert.equal(result.expiresAt, new Date(now.getTime() + THESIS_INVALIDATION_DAYS * 24 * 60 * 60 * 1000).toISOString());
  assert.match(result.reason, /NVDA/);
});

test("SELL + bearish + UNHELD + whipsaw gate approved -> do_not_buy", () => {
  const now = new Date("2026-07-12T00:00:00.000Z");
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "michael-burry",
    originalDecision: "SELL",
    stance: "bearish",
    symbolHeld: false,
    whipsawDowngraded: false,
    now,
  });
  assert.equal(result.kind, "do_not_buy");
  if (result.kind !== "do_not_buy") throw new Error("unreachable");
  assert.equal(result.symbol, "NVDA");
  assert.equal(result.sourceId, "michael-burry");
  assert.equal(result.expiresAt, new Date(now.getTime() + DO_NOT_BUY_DAYS * 24 * 60 * 60 * 1000).toISOString());
});

test("whipsaw-downgraded bearish SELL (verdict whipsaw) on a HELD symbol -> NO invalidation, exit not forced", () => {
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "michael-burry",
    originalDecision: "SELL",
    stance: "bearish",
    symbolHeld: true,
    whipsawDowngraded: true,
  });
  assert.equal(result.kind, "none");
});

test("whipsaw-downgraded bearish SELL on an UNHELD symbol -> still do_not_buy (avoiding a buy is cheap)", () => {
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "michael-burry",
    originalDecision: "SELL",
    stance: "bearish",
    symbolHeld: false,
    whipsawDowngraded: true,
  });
  assert.equal(result.kind, "do_not_buy");
});

test("BUY + bearish contradiction -> contradiction (caller treats as NONE + logs loudly)", () => {
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "michael-burry",
    originalDecision: "BUY",
    stance: "bearish",
    symbolHeld: false,
    whipsawDowngraded: false,
  });
  assert.equal(result.kind, "contradiction");
});

test("BUY + bearish contradiction takes precedence even when the symbol is held", () => {
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "michael-burry",
    originalDecision: "BUY",
    stance: "bearish",
    symbolHeld: true,
    whipsawDowngraded: false,
  });
  assert.equal(result.kind, "contradiction");
});

test("SELL + bullish stance -> none (an explicit SELL is bearish stance in practice, but the mapping itself is stance-driven, not decision-driven)", () => {
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "ziptrader",
    originalDecision: "SELL",
    stance: "bullish",
    symbolHeld: true,
    whipsawDowngraded: false,
  });
  assert.equal(result.kind, "none");
});

test("SELL + neutral stance (defensive-parse fallback) -> none, no trade-altering side effect", () => {
  const result = evaluateBearishMapping({
    symbol: "NVDA",
    sourceId: "ziptrader",
    originalDecision: "SELL",
    stance: undefined, // defensively normalized to neutral inside
    symbolHeld: true,
    whipsawDowngraded: false,
  });
  assert.equal(result.kind, "none");
});

test("BUY + bullish/neutral stance -> none (ordinary BUY, not a contradiction)", () => {
  assert.equal(
    evaluateBearishMapping({ symbol: "NVDA", sourceId: "s", originalDecision: "BUY", stance: "bullish", symbolHeld: false, whipsawDowngraded: false }).kind,
    "none",
  );
  assert.equal(
    evaluateBearishMapping({ symbol: "NVDA", sourceId: "s", originalDecision: "BUY", stance: "neutral", symbolHeld: false, whipsawDowngraded: false }).kind,
    "none",
  );
});

test("HOLD/NONE decisions with bearish stance -> none (bearish mapping only fires on SELL or the BUY contradiction)", () => {
  assert.equal(
    evaluateBearishMapping({ symbol: "NVDA", sourceId: "s", originalDecision: "HOLD", stance: "bearish", symbolHeld: true, whipsawDowngraded: false }).kind,
    "none",
  );
  assert.equal(
    evaluateBearishMapping({ symbol: "NVDA", sourceId: "s", originalDecision: "NONE", stance: "bearish", symbolHeld: false, whipsawDowngraded: false }).kind,
    "none",
  );
});
