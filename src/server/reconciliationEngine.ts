import { AlpacaAccount, AlpacaPosition } from "../types";
import { ReconciliationReport } from "./domainTypes";
import { parseFiniteNumber } from "./numericSafety";
import { BROKER_SUCCESS_TRADE_STATUSES, TradeState } from "./tradingSafety";

export type LocalTrade = {
  id: string;
  brokerOrderId?: string;
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  status: string;
  // Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3, scheduled position-level
  // reconciliation): Task 5's last-polled broker-reported fill quantity for
  // this trade's own order, when known. computeExpectedPositions below prefers
  // this over `qty` (the originally requested quantity) whenever present --
  // see that function's doc comment for why. Optional/additive: existing
  // callers of reconcileBrokerState (order-status reconciliation) never set
  // this and are unaffected.
  filledQty?: number;
};

type BrokerOrder = {
  id: string;
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  status: string;
};

export function reconcileBrokerState(input: {
  localTrades: LocalTrade[];
  brokerOrders: BrokerOrder[];
  brokerPositions: AlpacaPosition[];
  account: AlpacaAccount;
}): ReconciliationReport {
  const mismatches: ReconciliationReport["mismatches"] = [];
  const brokerOrdersById = new Map(input.brokerOrders.map((order) => [order.id, order]));

  for (const trade of input.localTrades) {
    if (!trade.brokerOrderId && isBrokerSubmittedState(trade.status)) {
      mismatches.push({ type: "missing_broker_order", localId: trade.id, symbol: trade.symbol, expected: trade.status, actual: "none" });
      continue;
    }
    if (!trade.brokerOrderId) continue;
    const brokerOrder = brokerOrdersById.get(trade.brokerOrderId);
    if (!brokerOrder) {
      mismatches.push({ type: "missing_broker_order", localId: trade.id, brokerId: trade.brokerOrderId, symbol: trade.symbol });
      continue;
    }
    const localTerminal = normalizeStatus(trade.status);
    const brokerTerminal = normalizeStatus(brokerOrder.status);
    if (localTerminal !== brokerTerminal) {
      mismatches.push({
        type: "order_status",
        localId: trade.id,
        brokerId: brokerOrder.id,
        symbol: trade.symbol,
        expected: localTerminal,
        actual: brokerTerminal,
      });
    }
  }

  return {
    id: `rec-${Date.now()}`,
    timestamp: new Date().toISOString(),
    status: mismatches.length ? "mismatch" : "matched",
    mismatches,
    account: input.account,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3, "Scheduled position-level
// reconciliation" + "Mismatch halts buys"): everything below is pure and has
// no knowledge of the breaker latch, Telegram, or persistence -- server.ts's
// sync cycle wires these into that machinery (see runSyncCycle's position
// reconciliation module). This deliberately does NOT reuse reconcileBrokerState
// above -- that function compares ORDERS (does the local trade's status match
// the broker order it produced); this compares POSITIONS (does the broker's
// actual holding match what our own successfully-placed trades imply we
// should hold), which is the previously-unused `brokerPositions` input this
// task's brief calls out. Both write into the same reconciliation_reports
// table (persistence.ts) -- they are two independent lenses on broker truth,
// not competing implementations of the same check.
// ---------------------------------------------------------------------------

// Tolerance for "does the broker's qty for a symbol match what we expect":
// the LARGER of a flat share tolerance and a percentage-of-expected tolerance
// (so a 1-share rounding wobble on a 3-share position and a 1-share wobble on
// a 3,000-share position are not held to the same absolute bar). Named
// constants per the plan's binding rule -- no env var, no config surface.
export const POSITION_QTY_ABS_TOLERANCE_SHARES = 1;
export const POSITION_QTY_PCT_TOLERANCE = 0.02; // 2%
// Floating-point guard only -- diff/tolerance are both derived from
// parseFiniteNumber'd broker/ledger quantities, and this keeps a
// representable-but-not-exact boundary value (e.g. 0.02 * 10 in IEEE-754)
// from being misclassified as "just past" the tolerance it is actually AT.
const POSITION_QTY_EPSILON = 1e-9;

export type LedgerGapMismatch = {
  type: "ledger_gap";
  tradeId: string;
  symbol?: string;
  reason: string;
};

export type PositionMismatch =
  | { type: "unexpected_position"; symbol: string; expectedQty: number; actualQty: number }
  | { type: "missing_position"; symbol: string; expectedQty: number; actualQty: number }
  | { type: "quantity_drift"; symbol: string; expectedQty: number; actualQty: number; toleranceUsed: number };

export type ExpectedPositionsResult = {
  // symbol -> net expected share count (broker-successful BUY fills minus
  // SELL fills, plus any acknowledged baseline -- see below). A symbol whose
  // net is exactly 0 (fully closed lot, never acknowledged) is omitted: "we
  // expect nothing" is the same as "the ledger never touched this symbol",
  // both mean comparePositions should not treat it specially.
  expected: Record<string, number>;
  ledgerGaps: LedgerGapMismatch[];
};

// Per-symbol sum of broker-successful (BROKER_SUCCESS_TRADE_STATUSES: Accepted,
// PartiallyFilled, Filled) BUY fills minus SELL fills -- "what our own trade
// record implies we should hold right now", independent of what Alpaca's
// live /positions actually reports (that comparison is comparePositions
// below). Prefers Task 5's polled `filledQty` over the originally requested
// `qty` whenever the trade carries one: `qty` is what was ASKED for, but a
// partial fill or a since-corrected poll means filledQty is the more current
// truth of what actually happened at the broker. A row whose chosen quantity
// field is unparsable (parseFiniteNumber fails) is skipped from the sum --
// but never silently: it is also reported as a `ledger_gap` mismatch, so a
// corrupt/malformed trade record fails closed into VISIBILITY (surfaced,
// investigated) rather than just quietly under-counting the expected
// position for that symbol.
//
// `acknowledgedBaselines` (symbol -> qty) is added ADDITIVELY on top of the
// trade-derived sum -- see POST /api/reconciliation/acknowledge (server.ts):
// an admin records the accepted qty for a position this system never traded
// (e.g. the operator's own manually-held SGOV), and that baseline is folded
// in here so it stops being reported as an unexpected_position on every
// future comparison. If the system later also trades that same symbol, the
// two contributions simply add, matching how a real brokerage position is
// actually composed.
export function computeExpectedPositions(
  trades: LocalTrade[],
  acknowledgedBaselines: Record<string, number> = {},
): ExpectedPositionsResult {
  const expected: Record<string, number> = {};
  const ledgerGaps: LedgerGapMismatch[] = [];

  for (const trade of trades) {
    if (!BROKER_SUCCESS_TRADE_STATUSES.has(trade.status as TradeState)) continue;
    const usingFilledQty = trade.filledQty !== undefined;
    const fieldName = usingFilledQty ? "filledQty" : "qty";
    const parsed = parseFiniteNumber(usingFilledQty ? trade.filledQty : trade.qty, fieldName);
    if (!parsed.ok) {
      ledgerGaps.push({
        type: "ledger_gap",
        tradeId: trade.id,
        symbol: trade.symbol,
        reason: `Trade ${trade.id}${trade.symbol ? ` (${trade.symbol})` : ""} has an unparsable ${fieldName}; skipped from the expected-position ledger.`,
      });
      continue;
    }
    const delta = trade.side === "buy" ? parsed.value : -parsed.value;
    expected[trade.symbol] = (expected[trade.symbol] || 0) + delta;
  }

  for (const [symbol, baselineQty] of Object.entries(acknowledgedBaselines)) {
    const parsedBaseline = parseFiniteNumber(baselineQty, "acknowledgedBaselineQty");
    // A corrupt/unparsable acknowledged baseline is simply ignored (never
    // subtracted, never crashes the cycle) -- admin-set data, not a trade
    // record, so it does not warrant a ledger_gap of its own; the affected
    // symbol just falls back to its trade-derived expectation alone, which
    // is the same fail-closed-into-visibility direction (an ignored baseline
    // can only make a real drift MORE visible, never less).
    if (!parsedBaseline.ok) continue;
    expected[symbol] = (expected[symbol] || 0) + parsedBaseline.value;
  }

  // Floor every symbol at 0. A negative sum means recorded SELLs outpaced
  // recorded BUYs for that symbol -- e.g. liquidating a pre-existing position
  // that predates this trade ledger (never recorded as a BUY here), or a
  // protective/emergency SELL of a synthetically-seeded position in a test.
  // That is a real gap in what the LEDGER can explain, but it is not the
  // broker's fault and must never be reported as a phantom missing_position
  // (comparePositions would otherwise see e.g. expectedQty=-10 and flag
  // "expected but missing on broker" for a position we never actually
  // expected to hold going forward). Flooring at 0 means "we hold nothing we
  // can positively account for" -- the same as a symbol the ledger never
  // touched at all.
  for (const symbol of Object.keys(expected)) {
    if (expected[symbol] < 0) expected[symbol] = 0;
  }

  for (const symbol of Object.keys(expected)) {
    if (expected[symbol] === 0) delete expected[symbol];
  }

  return { expected, ledgerGaps };
}

// Compares the expected-position ledger (computeExpectedPositions above)
// against Alpaca's live /positions response. Presence, not magnitude, decides
// unexpected_position/missing_position (a symbol either is or isn't in each
// side's map); tolerance only governs quantity_drift, the case where both
// sides agree a position exists but disagree on its size.
export function comparePositions(expected: Record<string, number>, livePositions: AlpacaPosition[]): PositionMismatch[] {
  const mismatches: PositionMismatch[] = [];

  const liveMap = new Map<string, number>();
  for (const position of livePositions) {
    const parsed = parseFiniteNumber(position.qty, "position.qty");
    // An unparsable broker-reported qty is dropped from the live side rather
    // than guessed at (never coerced to 0/NaN) -- comparePositions is pure
    // and has no logging channel of its own; the caller (server.ts) is
    // expected to have already validated/logged the raw broker response
    // before handing positions in here.
    if (parsed.ok) liveMap.set(position.symbol, parsed.value);
  }

  const expectedMap = new Map<string, number>();
  for (const [symbol, qty] of Object.entries(expected)) {
    if (qty !== 0) expectedMap.set(symbol, qty);
  }

  const symbols = new Set<string>([...expectedMap.keys(), ...liveMap.keys()]);
  for (const symbol of symbols) {
    const expectedQty = expectedMap.get(symbol);
    const actualQty = liveMap.get(symbol);

    if (expectedQty === undefined && actualQty !== undefined) {
      mismatches.push({ type: "unexpected_position", symbol, expectedQty: 0, actualQty });
      continue;
    }
    if (expectedQty !== undefined && actualQty === undefined) {
      mismatches.push({ type: "missing_position", symbol, expectedQty, actualQty: 0 });
      continue;
    }
    if (expectedQty !== undefined && actualQty !== undefined) {
      const diff = Math.abs(expectedQty - actualQty);
      const tolerance = Math.max(POSITION_QTY_ABS_TOLERANCE_SHARES, POSITION_QTY_PCT_TOLERANCE * Math.abs(expectedQty));
      if (diff > tolerance + POSITION_QTY_EPSILON) {
        mismatches.push({ type: "quantity_drift", symbol, expectedQty, actualQty, toleranceUsed: tolerance });
      }
    }
  }

  return mismatches;
}

// End-to-end pure orchestration: expected-position ledger -> comparison ->
// a ReconciliationReport in the exact persisted shape (persistence.ts's
// saveReconciliationReport), so server.ts's sync-cycle wiring is a thin
// I/O shell around this. ANY mismatch (including a ledger_gap alone, with
// zero position mismatches) marks the report "mismatch" -- per the plan's
// binding "fail closed into visibility" rule, an unparsable trade row is
// exactly as reportable as a real position discrepancy.
export function buildPositionReconciliationReport(input: {
  trades: LocalTrade[];
  livePositions: AlpacaPosition[];
  acknowledgedBaselines?: Record<string, number>;
  account?: AlpacaAccount;
}): ReconciliationReport {
  const { expected, ledgerGaps } = computeExpectedPositions(input.trades, input.acknowledgedBaselines || {});
  const positionMismatches = comparePositions(expected, input.livePositions);

  const mismatches: ReconciliationReport["mismatches"] = [
    ...ledgerGaps.map((gap) => ({
      type: "ledger_gap" as const,
      localId: gap.tradeId,
      symbol: gap.symbol,
      reason: gap.reason,
    })),
    ...positionMismatches.map((mismatch) => ({
      type: mismatch.type,
      symbol: mismatch.symbol,
      expected: String(mismatch.expectedQty),
      actual: String(mismatch.actualQty),
      ...(mismatch.type === "quantity_drift"
        ? { reason: `qty differs by ${Math.abs(mismatch.expectedQty - mismatch.actualQty)}, beyond tolerance of ${mismatch.toleranceUsed}` }
        : {}),
    })),
  ];

  return {
    id: `rec-pos-${Date.now()}`,
    timestamp: new Date().toISOString(),
    status: mismatches.length ? "mismatch" : "matched",
    mismatches,
    account: input.account,
  };
}

function isBrokerSubmittedState(status: string) {
  return ["BrokerSubmitted", "Accepted", "PartiallyFilled", "Filled"].includes(status);
}

function normalizeStatus(status: string) {
  const lower = status.toLowerCase();
  if (lower === "filled") return "filled";
  if (lower === "accepted" || lower === "new" || lower === "pending_new") return "accepted";
  if (lower === "partially_filled") return "partially_filled";
  if (lower === "rejected") return "rejected";
  if (lower === "brokerfailed") return "failed";
  return lower;
}
