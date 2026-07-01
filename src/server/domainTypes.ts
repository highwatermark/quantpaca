import { AlpacaAccount, AlpacaPosition } from "../types";

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
