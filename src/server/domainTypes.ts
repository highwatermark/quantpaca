import { AlpacaAccount, AlpacaPosition } from "../types";
import { MarketRegimeInputs } from "./marketDataFetcher";

export type SignalSource = "email" | "youtube" | "gemini" | "manual" | "telegram";

export type RawSignal = {
  id: string;
  source: SignalSource;
  sourceId: string;
  sourceTimestamp: string;
  symbol: string;
  thesis: string;
  normalizedThesisHash: string;
  url?: string;
  aiConfidence?: number;
};

export type ReviewedSignal = {
  id: string;
  rawSignalId: string;
  symbol: string;
  source: SignalSource;
  sourceTimestamp: string;
  freshnessStatus: "fresh" | "stale" | "unknown";
  confidenceScore: number;
  classification: "bullish" | "bearish" | "neutral";
  thesisSummary: string;
  invalidationConditions: string[];
  evidence: string[];
  status: "accepted" | "rejected";
  rejectionReason?: "duplicate" | "stale" | "low_confidence" | "unsupported" | "malformed";
};

export type RegimeAssessment = {
  id: string;
  timestamp: string;
  marketMode: "risk_on" | "risk_off" | "volatile" | "trend_up" | "trend_down" | "unclear";
  volatilityLevel: "low" | "normal" | "high" | "extreme";
  tradePermission: "allow" | "reduce_size" | "block_new_buys" | "close_only";
  sizeMultiplier: number;
  reason: string;
  sectorRelevance?: string;
  // Task 8 (docs/GO_LIVE_PLAN.md Phase 1.3): populated by the sync wiring in
  // server.ts (src/server/marketDataFetcher.ts), not by detectRegime itself --
  // regimeEngine.ts's decision logic is unaware of either field. `asOf` is the
  // newest market-data bar timestamp (or fetch time on total failure) that
  // produced this assessment -- used to decide whether a persisted assessment
  // is still fresh enough to reuse (see REGIME_STALENESS_MS in
  // marketDataFetcher.ts), as opposed to `timestamp` above, which is just when
  // this DB row was written. `inputs` records the raw computed inputs alongside
  // the assessment they produced, satisfying the plan's "real inputs recorded"
  // accept criterion and letting a fresh-enough row be reused without a refetch.
  asOf?: string;
  inputs?: MarketRegimeInputs;
  // Phase 2 Task 1, Item A (docs/GO_LIVE_PLAN.md "Phase 1 completion report" ->
  // "Deferred to Phase 2"): WHEN the market-data fetch that produced this
  // assessment actually happened -- this, not `asOf`, is what the sync wiring
  // in server.ts compares against REGIME_STALENESS_MS to decide whether to
  // reuse a persisted assessment. `asOf` (newest bar timestamp) is honest about
  // data freshness but is usually days old on weekends and always minutes
  // behind during the trading day, so keying reuse off it made the cache
  // effectively dead code on the happy path. Only a SUCCESSFUL fetch sets this
  // field -- a failed refetch persists its conservative-default assessment
  // (for audit) without `fetchedAt`, so the next sync always treats it as
  // stale and retries rather than suppressing retry for REGIME_STALENESS_MS.
  // Undefined on legacy rows persisted before this field existed, which parses
  // to NaN below and is therefore also always treated as stale -- migration-safe.
  fetchedAt?: string;
};

export type OpenOrder = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  notional?: string;
  status: string;
};

export type PortfolioAssessment = {
  timestamp: string;
  cash: number;
  buyingPower: number;
  equity: number;
  longMarketValue: number;
  totalLongExposurePercent: number;
  pendingOrderNotional: number;
  positions: AlpacaPosition[];
  openOrders: OpenOrder[];
  perSymbolConcentration: Record<string, number>;
  source: "alpaca" | "local_simulated_snapshot";
};

export type SizedTradeIntent = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  notional: number;
  estimatedPrice: number;
  sizingReason: string;
  capsApplied: string[];
};

export type ReconciliationReport = {
  id: string;
  timestamp: string;
  status: "matched" | "mismatch";
  mismatches: Array<{
    // Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3, scheduled position-level
    // reconciliation): four additive mismatch types produced by
    // reconciliationEngine.ts's comparePositions/computeExpectedPositions --
    // "unexpected_position" (broker holds a symbol the trade ledger doesn't
    // expect -- a manual buy or unknown fill), "missing_position" (the ledger
    // expects a symbol the broker doesn't hold -- a manual sell or unknown
    // close), "quantity_drift" (both hold the symbol but the qty differs
    // beyond tolerance), and "ledger_gap" (a local trade row's qty/filledQty
    // was unparsable and had to be skipped from the expected-position sum --
    // fails closed into visibility rather than silently understating the
    // expected position). Existing "missing_broker_order"/"order_status"
    // (order-level reconciliation, reconcileBrokerState) and "position"
    // (unused legacy placeholder) are untouched.
    type: "missing_broker_order" | "order_status" | "position" | "unexpected_position" | "missing_position" | "quantity_drift" | "ledger_gap";
    localId?: string;
    brokerId?: string;
    symbol?: string;
    expected?: string;
    actual?: string;
    // Human-readable detail, currently used by "ledger_gap" (which trade row,
    // and why it was unparsable) and "quantity_drift" (the tolerance that was
    // exceeded). Optional/additive -- every existing mismatch producer leaves
    // this undefined.
    reason?: string;
  }>;
  account?: AlpacaAccount;
};
