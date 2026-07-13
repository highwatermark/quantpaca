import { AlpacaAccount, AlpacaPosition } from "../types";
import { MarketRegimeInputs } from "./marketDataFetcher";
import { CrossSourceResult, Stance } from "./crossSourceConfirmation";

// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4, signal-source registry):
// email sources are no longer a single hardcoded "email" literal -- each
// registry entry (src/server/sourceRegistry.ts) stamps its own id (e.g.
// "ziptrader") onto every signal it produces, so Phase 3 attribution can
// compare sources. Widened to plain `string` (with the well-known literals
// kept in the union purely for editor autocomplete via the `(string & {})`
// idiom) rather than a closed enum, since registry ids are config-driven, not
// known at compile time. Every existing call site that compares against a
// specific literal (e.g. `source === "gemini"`) keeps type-checking exactly
// as before.
export type SignalSource = "email" | "youtube" | "gemini" | "manual" | "telegram" | (string & {});

// Phase 2 Task 8: how much a source is trusted, carried through from the
// registry entry. Recorded on the raw/persisted signal only in this task --
// no tier-based gating or weighting exists yet (that arrives with the
// cross-source task per the task brief).
export type TrustTier = "high" | "medium" | "low";

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
  // Phase 2 Task 8: additive, optional -- only email sources routed through
  // the signal-source registry set this (see sourceRegistry.ts). Recorded
  // only; not read by any gating logic in this task.
  trustTier?: TrustTier;
  // Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, cross-source
  // confirmation): the source's own authoritative directional call, as
  // determined by the Claude analysis schema's `stance` field (server.ts) --
  // NOT the same as ReviewedSignal.classification below, which is a crude
  // regex guess over `thesis` text and predates this field. Additive,
  // optional -- callers outside the analysis path (tests, older callers)
  // simply omit it, and reviewSignal defaults a persisted-but-unset value to
  // "neutral" the same way normalizeStance does. This is what
  // recentAcceptedSignalsForSymbol (persistence.ts) reads back to feed
  // evaluateCrossSource (crossSourceConfirmation.ts).
  stance?: Stance;
  // Phase 2 Task 11: the cross-source effect (if any) that was computed for
  // and applied to THIS signal at review time -- boost/conflict/none.
  // Recorded for audit even when "none", so every persisted signal shows
  // what the confirmation check actually decided, not just the interesting
  // cases. Additive, optional.
  crossSource?: CrossSourceResult;
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
  // Phase 2 Task 8: carried through from RawSignal.trustTier -- additive,
  // optional, recorded only (see comment above).
  trustTier?: TrustTier;
  // Phase 2 Task 11: carried through from RawSignal.stance/crossSource --
  // additive, optional, same "carried through, recorded only" convention as
  // trustTier above. See RawSignal's doc comments for both fields.
  stance?: Stance;
  crossSource?: CrossSourceResult;
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
