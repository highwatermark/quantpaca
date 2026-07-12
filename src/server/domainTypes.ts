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
    type: "missing_broker_order" | "order_status" | "position";
    localId?: string;
    brokerId?: string;
    symbol?: string;
    expected?: string;
    actual?: string;
  }>;
  account?: AlpacaAccount;
};
