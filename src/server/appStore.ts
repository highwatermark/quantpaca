// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// replaces server.ts's old atomic-JSON read/write pair (db.json) with
// a Store facade backed entirely by ProductionStore/SQLite (persistence.ts).
// db.json is NOT deleted -- after the one-time migration below it becomes
// frozen legacy state (a `data/db.json.MIGRATED` sibling marker documents
// this on disk; see docs/OPS_RUNBOOK.md). Nothing in this codebase writes
// db.json anymore.
//
// Concurrency: `acquire()` is the SAME serialization primitive server.ts's
// old `dbMutex` was -- a simple queue-based lock, moved here so it lives
// next to the state it protects. `updateConfig` is the one operation that
// owns the lock ITSELF (read-modify-write, single atomic unit); every other
// method here is a single SQLite statement (already atomic at the storage
// layer) and does not touch the lock -- callers that need to compose several
// of these calls into one larger critical section (e.g. server.ts's
// runSyncCycle) acquire the lock themselves around the whole sequence, same
// as the old dbMutex acquire/read/.../write/release pattern, just
// without a final batched write (every call below persists immediately).
import fs from "node:fs";
import { AppConfig, StockAnalysis, SyncLog, Trade } from "../types";
import { ProductionStore, SYNC_LOG_RETENTION } from "./persistence";

// `positions` stays loosely typed (`any[]`) and `last_equity` is optional --
// this mirrors the old db.json-backed shape server.ts's simulated-portfolio
// code has always treated dynamically (untyped `any` throughout), including
// reviewRisk's dailyLoss fallback (server.ts), which reads
// `portfolio.last_equity` off BOTH the real-broker and simulated shapes
// uniformly. A real broker portfolio always carries last_equity; the
// simulated one has historically never set it (falls back to `equity`).
export type SimulatedPortfolio = {
  cash: string;
  buying_power: string;
  portfolio_value: string;
  equity: string;
  last_equity?: string;
  long_market_value: string;
  daytrade_count: number;
  positions: any[];
};

// Same shape defaultDB() used to seed a brand-new db.json with -- moved here
// verbatim so first-boot behavior (no migration needed, e.g. a fresh install
// with no db.json at all) is unchanged.
export const DEFAULT_CONFIG: AppConfig = {
  alpaca: { apiKeyId: "", secretKey: "", paper: true },
  notion: { token: "", databaseId: "" },
  telegram: { botToken: "", chatId: "", enabled: false },
  google: { spreadsheetId: "", enabled: false },
  system: {
    autoTrading: false,
    runIntervalMins: 15,
    maxPositionSizePercent: 10,
    stopLossPercent: 5,
    targetProfitPercent: 15,
  },
};

export const DEFAULT_SIMULATED_PORTFOLIO: SimulatedPortfolio = {
  cash: "100000.00",
  buying_power: "100000.00",
  portfolio_value: "100000.00",
  equity: "100000.00",
  long_market_value: "0.00",
  daytrade_count: 0,
  positions: [],
};

// Queue-based lock, same implementation as the old server.ts DBConcurrencyMutex
// (unchanged behavior -- see tests/telegramMutex.test.ts for the serialization
// pattern this preserves).
class ConcurrencyMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          next?.();
        } else {
          this.locked = false;
        }
      };

      if (!this.locked) {
        this.locked = true;
        resolve(release);
      } else {
        this.queue.push(() => {
          resolve(release);
        });
      }
    });
  }
}

export type AppStore = {
  acquire(): Promise<() => void>;
  getConfig(): AppConfig;
  setConfig(config: AppConfig): void;
  // Atomic read-modify-write: acquires the lock, hands the CURRENT config to
  // `updater`, persists whatever it returns, releases, and returns the new
  // config. Callers must never call this from inside a block that already
  // holds the lock (acquire() is not reentrant -- it would deadlock), same
  // rule the old dbMutex.acquire() call sites already followed.
  updateConfig(updater: (current: AppConfig) => AppConfig): Promise<AppConfig>;
  addLog(log: SyncLog): void;
  getLogs(limit?: number): SyncLog[];
  appendTrade(trade: Trade): void;
  listTrades(limit?: number): Trade[];
  appendAnalysis(analysis: StockAnalysis): void;
  listAnalyses(limit?: number): StockAnalysis[];
  getSimulatedPortfolio(): SimulatedPortfolio;
  setSimulatedPortfolio(portfolio: SimulatedPortfolio): void;
};

export function createAppStore(store: ProductionStore): AppStore {
  const mutex = new ConcurrencyMutex();

  // IMPORTANT: DEFAULT_CONFIG/DEFAULT_SIMULATED_PORTFOLIO are module-level
  // constants shared across every createAppStore() instance in this process
  // (e.g. multiple server.ts module instances under one test file's dynamic
  // re-imports). Callers routinely mutate the object a get* call returns in
  // place (e.g. `simulatedPortfolio.positions.push(...)`) before persisting
  // it back -- exactly like the old db.json readDB()'s fresh-parse-per-call
  // contract. Returning the shared default BY REFERENCE would let one
  // instance's mutation leak into every other instance/data-dir that also
  // happens to be on its own first (row-less) read. structuredClone here
  // gives every fallback caller its own object, matching the DB-backed path
  // (persistence.ts's getConfig/getSimulatedPortfolio already return a fresh
  // JSON.parse(...) object per call, never a shared reference).
  return {
    acquire: () => mutex.acquire(),
    getConfig: () => store.getConfig() ?? structuredClone(DEFAULT_CONFIG),
    setConfig: (config) => store.setConfig(config),
    async updateConfig(updater) {
      const release = await mutex.acquire();
      try {
        const next = updater(store.getConfig() ?? structuredClone(DEFAULT_CONFIG));
        store.setConfig(next);
        return next;
      } finally {
        release();
      }
    },
    addLog: (log) => store.addSyncLog(log),
    getLogs: (limit) => store.listSyncLogs(limit),
    appendTrade: (trade) => store.appendUiTrade(trade),
    listTrades: (limit) => store.listUiTrades(limit),
    appendAnalysis: (analysis) => store.appendAnalysis(analysis),
    listAnalyses: (limit) => store.listAnalyses(limit),
    getSimulatedPortfolio: () => (store.getSimulatedPortfolio() as SimulatedPortfolio | undefined) ?? structuredClone(DEFAULT_SIMULATED_PORTFOLIO),
    setSimulatedPortfolio: (portfolio) => store.setSimulatedPortfolio(portfolio),
  };
}

// app_state (persistence.ts) key stamped once the one-time db.json migration
// below has run (successfully OR as a clean-default first boot) -- gates
// migrateDbJsonIfNeeded so it only ever does real work once per database,
// same "no schema migration needed" app_state convention as every other
// marker key in this codebase (see crashLoopGuard.ts's CLEAN_SHUTDOWN_APP_STATE_KEY
// for the precedent).
export const DBJSON_MIGRATED_AT_APP_STATE_KEY = "dbjson_migrated_at";

// Sibling marker file documenting on disk (db.json itself is JSON -- it can't
// carry a comment) that db.json is frozen legacy state post-migration. Purely
// informational for an operator poking around `./data`; nothing in this
// codebase reads it back.
export function dbJsonMigratedMarkerPath(dbJsonPath: string): string {
  return `${dbJsonPath}.MIGRATED`;
}

export type DbJsonMigrationResult = {
  ran: boolean;
  source: "already_migrated" | "db_json" | "clean_default" | "migration_failed";
  counts?: { syncLogs: number; analyses: number; trades: number; simulatedPortfolio: boolean };
};

// One-time migration, called from run() BEFORE startup reconciliation (see
// server.ts). Idempotent: gated on DBJSON_MIGRATED_AT_APP_STATE_KEY, so a
// second boot (or a retry after a partial failure) is a pure no-op. Never
// throws -- a migration failure degrades to clean defaults (fail toward "the
// process still boots with a usable, empty config") rather than blocking
// startup; the failure is logged and audited either way.
export function migrateDbJsonIfNeeded(
  appStore: AppStore,
  productionStore: ProductionStore,
  dbJsonPath: string,
): DbJsonMigrationResult {
  const alreadyMigrated = productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY);
  if (alreadyMigrated) {
    return { ran: false, source: "already_migrated" };
  }

  const configIsEmpty = productionStore.getConfig() === undefined;
  let result: DbJsonMigrationResult;

  if (configIsEmpty && fs.existsSync(dbJsonPath)) {
    try {
      const raw = fs.readFileSync(dbJsonPath, "utf8");
      const parsed = JSON.parse(raw) as {
        config?: Partial<AppConfig>;
        syncLogs?: SyncLog[];
        analyses?: StockAnalysis[];
        trades?: Trade[];
        simulatedPortfolio?: SimulatedPortfolio;
      };

      appStore.setConfig({ ...DEFAULT_CONFIG, ...(parsed.config || {}) });

      const syncLogs = Array.isArray(parsed.syncLogs) ? parsed.syncLogs.slice(0, SYNC_LOG_RETENTION) : [];
      for (const log of syncLogs) appStore.addLog(log);

      const analyses = Array.isArray(parsed.analyses) ? parsed.analyses : [];
      for (const analysis of analyses) appStore.appendAnalysis(analysis);

      const trades = Array.isArray(parsed.trades) ? parsed.trades : [];
      for (const trade of trades) appStore.appendTrade(trade);

      const hadSimulatedPortfolio = Boolean(parsed.simulatedPortfolio);
      if (parsed.simulatedPortfolio) appStore.setSimulatedPortfolio(parsed.simulatedPortfolio);

      const counts = { syncLogs: syncLogs.length, analyses: analyses.length, trades: trades.length, simulatedPortfolio: hadSimulatedPortfolio };
      console.log(
        `[migration] db.json migrated into SQLite: config, ${counts.syncLogs} sync log(s), ${counts.analyses} analysis/es, ${counts.trades} legacy trade(s), simulated portfolio ${hadSimulatedPortfolio ? "present" : "absent"}.`,
      );
      productionStore.appendAuditEvents([{
        id: `ae-dbjson-migration-${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: "config",
        actor: "dbjson_migration",
        message: "One-time db.json -> SQLite migration completed (config, sync logs, analyses, trades, simulated portfolio). db.json is now frozen legacy state.",
        details: counts,
      }]);
      // Sibling marker file (see dbJsonMigratedMarkerPath's doc comment above)
      // -- best-effort; a failure here never fails the migration itself (the
      // app_state marker below is the real, load-bearing idempotency gate).
      try {
        fs.writeFileSync(
          dbJsonMigratedMarkerPath(dbJsonPath),
          `db.json was migrated into SQLite at ${new Date().toISOString()}. It is frozen legacy state -- nothing in this codebase writes to it anymore. See docs/OPS_RUNBOOK.md.\n`,
          "utf8",
        );
      } catch (markerErr) {
        console.error("[migration] Failed to write the db.json.MIGRATED marker file (informational only; the app_state marker is authoritative).", markerErr);
      }
      result = { ran: true, source: "db_json", counts };
    } catch (err) {
      console.error("[migration] Failed to migrate db.json; falling back to clean defaults so the process still boots with a usable configuration.", err);
      appStore.setConfig(DEFAULT_CONFIG);
      productionStore.appendAuditEvents([{
        id: `ae-dbjson-migration-failed-${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: "config",
        actor: "dbjson_migration",
        message: `db.json migration failed; falling back to clean defaults. Error: ${err instanceof Error ? err.message : String(err)}`,
      }]);
      result = { ran: true, source: "migration_failed" };
    }
  } else if (configIsEmpty) {
    // No db.json at all (fresh install) -- clean first-boot defaults.
    appStore.setConfig(DEFAULT_CONFIG);
    productionStore.appendAuditEvents([{
      id: `ae-dbjson-migration-clean-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "config",
      actor: "dbjson_migration",
      message: "No db.json found; initialized SQLite config with clean first-boot defaults.",
    }]);
    result = { ran: true, source: "clean_default" };
  } else {
    // Config already present for some other reason (e.g. a prior partial run
    // that wrote config but crashed before stamping the marker) -- nothing to
    // copy; stamp the marker below so this never re-runs.
    result = { ran: true, source: "clean_default" };
  }

  productionStore.setAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY, new Date().toISOString());
  return result;
}
