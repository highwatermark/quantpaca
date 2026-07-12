export interface AlpacaConfig {
  apiKeyId: string;
  secretKey: string;
  paper: boolean;
}

export interface NotionConfig {
  token: string;
  databaseId: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

export interface GoogleConfig {
  spreadsheetId: string;
  enabled: boolean;
}

export interface SystemConfig {
  autoTrading: boolean;
  runIntervalMins: number;
  maxPositionSizePercent: number;
  stopLossPercent: number;
  targetProfitPercent: number;
}

export interface AppConfig {
  alpaca: AlpacaConfig;
  notion: NotionConfig;
  telegram: TelegramConfig;
  google: GoogleConfig;
  system: SystemConfig;
}

export interface StockAnalysis {
  id: string;
  symbol: string;
  source: 'email' | 'youtube';
  sourceTitle: string;
  sourceContent: string;
  growthScore: number; // 0-100
  sentimentScore: number; // -100 to 100
  riskProfile: 'Low' | 'Medium' | 'High';
  reasoning: string;
  whipsawCheck: string; // Explains whether whipsaw or genuine trend reversal
  // Structured verdict the signal engine gates SELLs on and haircuts BUY confidence
  // for (see src/server/whipsawGate.ts). Optional: rows persisted before this field
  // existed won't have it -- any code reading it back must treat a missing value as
  // "unclear" (the same fail-closed default normalizeWhipsawVerdict applies).
  whipsawVerdict?: 'whipsaw' | 'reversal' | 'unclear';
  // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
  // Burry Substack): the source's directional call, generalized across every
  // source (not Burry-specific) -- see src/server/bearishMapping.ts, which
  // gates thesis-invalidation and do-not-buy purely on this field plus
  // decision/held-state. Optional: rows persisted before this field existed
  // won't have it -- any code reading it back must treat a missing value as
  // "neutral" (see normalizeStance's fail-closed default).
  stance?: 'bullish' | 'bearish' | 'neutral';
  decision: 'BUY' | 'SELL' | 'HOLD' | 'NONE';
  timestamp: string;
}

export interface Trade {
  id: string;
  symbol: string;
  qty: number;
  price: number;
  side: 'buy' | 'sell';
  status: string;
  timestamp: string;
  reasoning: string;
  notifiedTelegram: boolean;
  exportedSheets: boolean;
  loggedNotion: boolean;
}

export interface SyncLog {
  id: string;
  timestamp: string;
  type: 'sync' | 'trade' | 'error' | 'override' | 'sentiment';
  message: string;
  details?: string;
  // Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): which caller ran this
  // cycle -- a human-initiated POST /api/sync, or the autonomous scheduler.
  // Optional: log rows persisted before this field existed (or written by
  // any other code path) simply won't have it.
  trigger?: 'manual' | 'scheduled';
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  avg_entry_price: string;
}

export interface AlpacaAccount {
  cash: string;
  buying_power: string;
  portfolio_value: string;
  equity: string;
  long_market_value: string;
  daytrade_count: number;
}
