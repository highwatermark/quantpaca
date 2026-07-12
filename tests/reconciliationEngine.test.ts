import test from "node:test";
import assert from "node:assert/strict";
import {
  computeExpectedPositions,
  comparePositions,
  buildPositionReconciliationReport,
  POSITION_QTY_ABS_TOLERANCE_SHARES,
  POSITION_QTY_PCT_TOLERANCE,
} from "../src/server/reconciliationEngine";

// ---------------------------------------------------------------------------
// computeExpectedPositions
// ---------------------------------------------------------------------------

test("computeExpectedPositions: sums broker-successful BUY fills minus SELL fills per symbol", () => {
  const { expected, ledgerGaps } = computeExpectedPositions([
    { id: "t1", symbol: "AAPL", side: "buy", status: "Filled", qty: 10 },
    { id: "t2", symbol: "AAPL", side: "buy", status: "Filled", qty: 5 },
    { id: "t3", symbol: "AAPL", side: "sell", status: "Filled", qty: 3 },
    { id: "t4", symbol: "MSFT", side: "buy", status: "Accepted", qty: 2 },
  ]);
  assert.deepEqual(expected, { AAPL: 12, MSFT: 2 });
  assert.deepEqual(ledgerGaps, []);
});

test("computeExpectedPositions: only BROKER_SUCCESS_TRADE_STATUSES trades count (Rejected/RiskRejected excluded)", () => {
  const { expected } = computeExpectedPositions([
    { id: "t1", symbol: "AAPL", side: "buy", status: "Filled", qty: 10 },
    { id: "t2", symbol: "AAPL", side: "buy", status: "Rejected", qty: 100 },
    { id: "t3", symbol: "AAPL", side: "buy", status: "RiskRejected", qty: 100 },
    { id: "t4", symbol: "AAPL", side: "buy", status: "BrokerFailed", qty: 100 },
    { id: "t5", symbol: "AAPL", side: "buy", status: "PendingApproval", qty: 100 },
  ]);
  assert.deepEqual(expected, { AAPL: 10 });
});

test("computeExpectedPositions: prefers polled filledQty over the requested qty when present", () => {
  const { expected } = computeExpectedPositions([
    { id: "t1", symbol: "AAPL", side: "buy", status: "PartiallyFilled", qty: 10, filledQty: 4 },
  ]);
  assert.deepEqual(expected, { AAPL: 4 });
});

test("computeExpectedPositions: falls back to qty when filledQty is absent", () => {
  const { expected } = computeExpectedPositions([
    { id: "t1", symbol: "AAPL", side: "buy", status: "Accepted", qty: 7 },
  ]);
  assert.deepEqual(expected, { AAPL: 7 });
});

test("computeExpectedPositions: an unparsable qty/filledQty row is skipped from the sum AND reported as a ledger_gap", () => {
  const { expected, ledgerGaps } = computeExpectedPositions([
    { id: "t1", symbol: "AAPL", side: "buy", status: "Filled", qty: 10 },
    { id: "bad-1", symbol: "AAPL", side: "buy", status: "Filled", qty: Number.NaN as unknown as number },
    { id: "bad-2", symbol: "MSFT", side: "buy", status: "PartiallyFilled", qty: 10, filledQty: "not-a-number" as unknown as number },
  ]);
  assert.deepEqual(expected, { AAPL: 10 });
  assert.equal(ledgerGaps.length, 2);
  assert.ok(ledgerGaps.every((g) => g.type === "ledger_gap"));
  assert.deepEqual(ledgerGaps.map((g) => g.tradeId).sort(), ["bad-1", "bad-2"]);
});

test("computeExpectedPositions: acknowledged baselines are added additively into the expected position", () => {
  const { expected } = computeExpectedPositions(
    [{ id: "t1", symbol: "AAPL", side: "buy", status: "Filled", qty: 10 }],
    { SGOV: 100 },
  );
  assert.deepEqual(expected, { AAPL: 10, SGOV: 100 });
});

test("computeExpectedPositions: a SELL with no matching recorded BUY (e.g. liquidating a pre-existing position) floors at 0, never negative", () => {
  const { expected } = computeExpectedPositions([
    { id: "t1", symbol: "LEGACY", side: "sell", status: "Filled", qty: 10 },
  ]);
  assert.deepEqual(expected, {});
});

// ---------------------------------------------------------------------------
// comparePositions -- tolerance boundaries
// ---------------------------------------------------------------------------

test("comparePositions: broker holds a symbol with zero expected trade history -> unexpected_position", () => {
  const mismatches = comparePositions({}, [
    { symbol: "SGOV", qty: "100", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
  ]);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].type, "unexpected_position");
  assert.equal((mismatches[0] as any).symbol, "SGOV");
});

test("comparePositions: expected position absent from the broker -> missing_position", () => {
  const mismatches = comparePositions({ AAPL: 10 }, []);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].type, "missing_position");
});

test("comparePositions: exact match -> no mismatch", () => {
  const mismatches = comparePositions({ AAPL: 10 }, [
    { symbol: "AAPL", qty: "10", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
  ]);
  assert.deepEqual(mismatches, []);
});

test(`comparePositions: exactly the ${POSITION_QTY_ABS_TOLERANCE_SHARES}-share absolute tolerance boundary is NOT a mismatch (small qty, pct tolerance smaller)`, () => {
  // expected 10 -> pct tolerance = 0.2, abs tolerance = 1 -> effective tolerance = 1
  const mismatches = comparePositions({ AAPL: 10 }, [
    { symbol: "AAPL", qty: "11", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
  ]);
  assert.deepEqual(mismatches, []);
});

test("comparePositions: just past the absolute tolerance boundary IS a mismatch", () => {
  const mismatches = comparePositions({ AAPL: 10 }, [
    { symbol: "AAPL", qty: "11.5", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
  ]);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].type, "quantity_drift");
});

test(`comparePositions: exactly the ${POSITION_QTY_PCT_TOLERANCE * 100}% boundary is NOT a mismatch when pct tolerance is larger than the absolute one`, () => {
  // expected 100 -> pct tolerance = 2, abs tolerance = 1 -> effective tolerance = 2 (pct wins)
  const mismatches = comparePositions({ AAPL: 100 }, [
    { symbol: "AAPL", qty: "102", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
  ]);
  assert.deepEqual(mismatches, []);
});

test("comparePositions: just past the 2% boundary (large qty regime) IS a mismatch", () => {
  const mismatches = comparePositions({ AAPL: 100 }, [
    { symbol: "AAPL", qty: "102.5", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
  ]);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].type, "quantity_drift");
});

test("comparePositions: a net-zero expected position (fully closed lot) with nothing on the broker is not reported", () => {
  const mismatches = comparePositions({ AAPL: 0 }, []);
  assert.deepEqual(mismatches, []);
});

// ---------------------------------------------------------------------------
// buildPositionReconciliationReport -- end-to-end pure orchestration
// ---------------------------------------------------------------------------

test("buildPositionReconciliationReport: matched when trade ledger and broker positions agree", () => {
  const report = buildPositionReconciliationReport({
    trades: [{ id: "t1", symbol: "AAPL", side: "buy", status: "Filled", qty: 10 }],
    livePositions: [
      { symbol: "AAPL", qty: "10", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
    ],
  });
  assert.equal(report.status, "matched");
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.id);
  assert.ok(report.timestamp);
});

test("buildPositionReconciliationReport: injected drift (manual buy in Alpaca UI) produces a mismatch report", () => {
  const report = buildPositionReconciliationReport({
    trades: [{ id: "t1", symbol: "AAPL", side: "buy", status: "Filled", qty: 10 }],
    livePositions: [
      { symbol: "AAPL", qty: "10", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
      { symbol: "SGOV", qty: "50", market_value: "0", cost_basis: "0", unrealized_pl: "0", unrealized_plpc: "0", current_price: "0", avg_entry_price: "0" },
    ],
  });
  assert.equal(report.status, "mismatch");
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].type, "unexpected_position");
  assert.equal(report.mismatches[0].symbol, "SGOV");
});

test("buildPositionReconciliationReport: a ledger_gap alone is enough to mark the report a mismatch (fail closed into visibility)", () => {
  const report = buildPositionReconciliationReport({
    trades: [{ id: "bad-1", symbol: "AAPL", side: "buy", status: "Filled", qty: Number.NaN as unknown as number }],
    livePositions: [],
  });
  assert.equal(report.status, "mismatch");
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].type, "ledger_gap");
});
