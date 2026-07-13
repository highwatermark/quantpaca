import fs from "node:fs";
import path from "node:path";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { AuditEvent, BROKER_SUCCESS_TRADE_STATUSES, ExitPlan, PipelineTrade, TradeState } from "./tradingSafety";
import { ReconciliationReport, RegimeAssessment, ReviewedSignal, SizedTradeIntent } from "./domainTypes";
import { normalizeStance } from "./bearishMapping";
import { CrossSourceSignal } from "./crossSourceConfirmation";
import { AppConfig, StockAnalysis, SyncLog, Trade } from "../types";

// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// operational state that used to live in the atomic-JSON db.json file --
// config, sync logs, analyses, the legacy UI trades list, and the offline
// simulated portfolio -- now lives here, in SQLite, alongside every other
// piece of durable state this store already owns. db.json is frozen legacy
// state after the one-time migration (src/server/appStore.ts); nothing in
// this codebase writes it anymore. `SYNC_LOG_RETENTION` bounds sync_logs to
// the newest N rows, pruned opportunistically on every write (same pattern
// as saveCooldown's opportunistic DELETE above) -- the old db.json array had
// no such bound and grew forever.
export const SYNC_LOG_RETENTION = 5000;

// Single-row-table id used by both `config` and `simulated_portfolio` below --
// there is only ever one current config and one current simulated portfolio,
// same "singleton row" shape SQLite's CHECK (id = 1) enforces.
const SINGLETON_ROW_ID = 1;

type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
  close(): void;
};

export type ProductionStore = {
  appendAuditEvents(events: AuditEvent[]): void;
  listAuditEvents(limit?: number): AuditEvent[];
  saveReviewedSignal(signal: ReviewedSignal, duplicateKey?: string): void;
  listReviewedSignals(limit?: number): ReviewedSignal[];
  loadRecentDuplicateKeys(limit?: number): Set<string>;
  // Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, cross-source
  // confirmation): every ACCEPTED reviewed signal for `symbol` whose
  // sourceTimestamp (the `timestamp` column -- see saveReviewedSignal, which
  // stores signal.sourceTimestamp there, not a write-time stamp) is >=
  // `sinceIso`. The caller (server.ts) is expected to pass
  // now - CROSS_SOURCE_WINDOW_HOURS as `sinceIso` for an efficient, roughly
  // bounded fetch; evaluateCrossSource (crossSourceConfirmation.ts) then
  // re-applies the EXACT window boundary itself, so a generous `sinceIso`
  // here is safe -- this method does not need to get the boundary precisely
  // right. `stance` is defensively normalized the same way
  // normalizeStance/bearishMapping.ts already does (fails closed to
  // "neutral" for any row from before this field existed, or any malformed
  // value) -- never trusted as pre-validated just because it round-tripped
  // through this store. Bounded (LIMIT 500) rather than unbounded, same
  // precedent as loadRecentDuplicateKeys above.
  recentAcceptedSignalsForSymbol(symbol: string, sinceIso: string): CrossSourceSignal[];
  saveRegimeAssessment(regime: RegimeAssessment): void;
  latestRegimeAssessment(): RegimeAssessment | undefined;
  saveTradeIntent(trade: PipelineTrade): void;
  listTradeIntents(limit?: number): PipelineTrade[];
  // Task 13 (idempotent orders): the local-trade half of the client_order_id ->
  // broker order mapping. Lets a resubmission of the same intent (same
  // client_order_id) find the trade record its earlier attempt already created,
  // so the caller can overwrite that row in place instead of inserting a second
  // local trade for what Alpaca itself will treat as one broker order.
  findTradeIntentByClientOrderId(clientOrderId: string): PipelineTrade | undefined;
  // Task 5 (order-status polling): fetch one trade_intents row by its own id,
  // full payload. Needed wherever a caller must read-modify-write the COMPLETE
  // trade record (e.g. cancelBracketLegsBeforeSell's post-422 leg re-poll,
  // server.ts) -- saveTradeIntent replaces the whole payload_json for that id,
  // so any partial reconstruction of a trade before resaving it would silently
  // drop fields. Undefined if no row exists for that id.
  getTradeIntentById(tradeId: string): PipelineTrade | undefined;
  saveRiskDecision(tradeId: string, decision: unknown): void;
  listRiskDecisions(limit?: number): unknown[];
  saveExitPlan(tradeId: string, exitPlan: unknown): void;
  listExitPlans(limit?: number): unknown[];
  // Most recent exit plan whose owning trade was a BUY on `symbol` -- the plan that
  // protects a currently-open long position. Only BUY-originated plans qualify: a
  // plan attached to a SELL trade describes closing/reducing a position, not
  // protecting one, and would carry inverted stop/take-profit multipliers if
  // reused to evaluate a still-open long. Undefined if no such plan exists (e.g.
  // a manual buy or pre-existing position that predates exit-plan persistence).
  // `tradeId` and `highWaterMark` support the trailing stop (Task 7): tradeId
  // lets the caller persist a ratcheted HWM back via updateHighWaterMark;
  // highWaterMark is the raw persisted value (undefined if never seeded/set).
  // `legOrderIds` (Task 4, broker-native brackets): the owning BUY trade's
  // persisted bracket leg order ids, if it was submitted as a bracket --
  // lets the exit monitor cancel live broker legs before a software exit
  // sell (see server.ts MODULE 2). Read straight off the same trade payload
  // already joined in here; no extra query.
  // `legStates` (Task 5, order-status polling): the same trade's persisted
  // brokerLegStates map (legId -> last known TradeState), so
  // cancelBracketLegsBeforeSell (server.ts) can skip a leg it already knows
  // is terminal without a second query.
  //
  // Task 5 / bracket-orders review finding 1: this now filters to trades
  // whose CURRENT status is in BROKER_SUCCESS_TRADE_STATUSES (Accepted,
  // PartiallyFilled, Filled) -- the same status-gating pattern Task C1 used
  // for exit-plan persistence (see server.ts executeTradeIntent), applied
  // here to the READ side. Before this fix, a BUY trade whose own order later
  // went terminal in a way that closed the lot without ever becoming a new,
  // newer-timestamped BUY (e.g. the poller discovers it was actually
  // Rejected/Canceled after this row was written) could still be picked as
  // "the" live entry, handing back a stale plan or stale/wrong bracket leg
  // ids. Filtering on the LIVE current status (trade_intents.status is
  // updated in place by every saveTradeIntent call, including the poller's)
  // keeps this answer honest as of the moment it's read.
  //
  // Single-lot assumption (documented, not fixed by this task): this method
  // still returns at most ONE row -- the most recent live BUY -- per symbol.
  // If a symbol were ever accumulated across multiple concurrently-open lots
  // (e.g. two separate BUYs before either was sold), this collapses them to
  // the newest one; the older lot's exit plan/legs would not be returned.
  // The system currently merges all positions for a symbol into one Alpaca
  // position and this codebase does not track multiple concurrent lots per
  // symbol anywhere else either, so this is consistent with the rest of the
  // system, not a regression -- but it is a real limitation or true per-lot
  // accounting, which is out of scope here.
  latestBuySideExitPlanForSymbol(symbol: string): { side: "buy" | "sell"; exitPlan: ExitPlan; tradeId: string; highWaterMark?: number; legOrderIds?: string[]; legStates?: Record<string, TradeState> } | undefined;
  // Ratchets the persisted high-water mark for the exit plan owned by `tradeId`.
  // Callers are expected to only invoke this with a value already confirmed to
  // be higher than the previous one (see exitMonitor.ts) -- this method itself
  // performs an unconditional write, it does not re-check monotonicity.
  updateHighWaterMark(tradeId: string, highWaterMark: number): void;
  saveReconciliationReport(report: ReconciliationReport): void;
  latestReconciliationReport(): ReconciliationReport | undefined;
  // `state` also carries whatever the caller wants latched/round-tripped through
  // latestBreakerState (Task 10: peakEquity high-water mark, and now `latch` --
  // the persisted BreakerLatchState from src/server/breakerLatch.ts). Payload is
  // opaque JSON here; no schema migration needed to add fields.
  saveBreakerState(state: { asOf: string; status: string }): void;
  latestBreakerState<T = unknown>(): T | undefined;
  saveCooldown(entry: { symbol: string; expiresAt: string; reason: string }): void;
  listActiveCooldownSymbols(nowIso: string): string[];
  // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
  // Burry Substack, long-only bearish mapping): a bearish/short thesis on a
  // HELD symbol marks that symbol's thesis invalidated -- this is what feeds
  // exitMonitor.ts's `thesisInvalidatedSymbols` input (evaluateOpenPositionExits),
  // which in turn feeds evaluateExitPlan's `thesisInvalidated` dimension
  // (exitEngine.ts), live for the first time since it was introduced in
  // Phase 1. Same single-row-per-symbol, filter-on-read + delete-expired-on-
  // write pattern as saveCooldown/listActiveCooldownSymbols above.
  saveThesisInvalidation(entry: { symbol: string; sourceId: string; reason: string; expiresAt: string }): void;
  listActiveThesisInvalidatedSymbols(nowIso: string): string[];
  // A bearish/short thesis on an UNHELD symbol adds it to this do-not-buy
  // list instead (no trade intent created) -- enforced at the shared order
  // chokepoint (executeTradeIntent, server.ts, same place as the cooldown),
  // so it guards EVERY buy path: sync automation and manual override alike.
  // Unlike the cooldown/thesis-invalidation lists above, callers need the
  // full record (not just the symbol) to produce an audited rejection reason
  // naming the source and expiry, and to power the admin-visibility read
  // endpoint (GET /api/do-not-buy).
  saveDoNotBuy(entry: { symbol: string; sourceId: string; reason: string; expiresAt: string }): void;
  listActiveDoNotBuy(nowIso: string): Array<{ symbol: string; sourceId: string; reason: string; expiresAt: string }>;
  // The admin escape hatch's storage half (DELETE /api/do-not-buy/:symbol,
  // server.ts): a human who genuinely wants to buy an avoided symbol removes
  // its entry first -- the chokepoint check itself is never bypassed. Returns
  // whether a row was actually deleted (false for a symbol with no entry).
  deleteDoNotBuy(symbol: string): boolean;
  // Tiny generic key-value store (Phase 2 Task 1, Item B: docs/GO_LIVE_PLAN.md
  // "Phase 1 completion report" -> "Deferred to Phase 2") for small pieces of
  // cross-restart state that don't warrant a dedicated table -- e.g. the
  // empty-sync Telegram alert throttle's last-alerted-at timestamp (see
  // src/server/alertThrottle.ts). `getAppState` returns undefined for a key
  // that was never written; callers are expected to treat that (and any read
  // failure) as the conservative default for whatever they're tracking, same
  // as every other fallible store read in this file.
  getAppState(key: string): string | undefined;
  setAppState(key: string, value: string): void;
  // Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): a consistent point-in-time
  // snapshot of the WHOLE database via SQLite's own `VACUUM INTO` -- safe to run
  // against a live, open connection (unlike a raw file copy, which could race a
  // concurrent writer under WAL mode). `destPath` is always a full path the
  // caller controls (backupEngine.ts's generated, ISO-stamped filename under
  // data/backups/), never end-user input. Throws on failure (disk full, bad
  // path, ...); the caller (backupEngine.ts's runBackup) is responsible for
  // catching it -- this method itself does not swallow errors.
  backupTo(destPath: string): void;
  close(): void;

  // Phase 2 Task 14 (store consolidation): the five db.json state classes,
  // now backed by SQLite. `getConfig`/`getSimulatedPortfolio` return
  // undefined when no row has ever been written (first boot, pre-migration)
  // -- callers (src/server/appStore.ts) are expected to substitute their own
  // conservative defaults, same "undefined means never written" contract as
  // getAppState above. `setConfig` is a full replace (versioned internally --
  // see the `config` table's `version` column -- for future schema-evolution
  // disclosure; the version is not currently read back by any caller).
  getConfig(): AppConfig | undefined;
  setConfig(config: AppConfig): void;
  // Appends one sync-log row and opportunistically prunes the table back
  // down to SYNC_LOG_RETENTION rows (newest by timestamp, ties broken by
  // insertion order) -- same "prune on the write path we already have open"
  // pattern as saveCooldown/saveThesisInvalidation/saveDoNotBuy above.
  addSyncLog(log: SyncLog): void;
  listSyncLogs(limit?: number): SyncLog[];
  // analyses/ui_trades are plain append+list JSON-payload tables (Task 14
  // brief: "mirroring current shapes") -- unbounded, same as the arrays they
  // replace; `saveTradeIntent`'s deduped SQLite trade_intents table above
  // remains the reconciliation source of truth, this is purely the legacy
  // per-attempt UI history.
  appendAnalysis(analysis: StockAnalysis): void;
  listAnalyses(limit?: number): StockAnalysis[];
  appendUiTrade(trade: Trade): void;
  listUiTrades(limit?: number): Trade[];
  getSimulatedPortfolio(): (Record<string, unknown> & { positions: unknown[] }) | undefined;
  setSimulatedPortfolio(portfolio: Record<string, unknown> & { positions: unknown[] }): void;
};

export function createProductionStore(dbPath = path.join(process.cwd(), "data", "quantpaca.sqlite")): ProductionStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new NodeDatabaseSync(dbPath) as DatabaseSync;
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      entity_id TEXT,
      from_state TEXT,
      to_state TEXT,
      message TEXT NOT NULL,
      details_json TEXT
    );
    CREATE TABLE IF NOT EXISTS reviewed_signals (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      duplicate_key TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS regime_assessments (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL,
      client_order_id TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS risk_decisions (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exit_plans (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reconciliation_reports (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS breaker_states (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbol_cooldowns (
      symbol TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thesis_invalidations (
      symbol TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS do_not_buy (
      symbol TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ui_trades (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS simulated_portfolio (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_logs_timestamp ON sync_logs(timestamp);
  `);

  // Backfill-safe migration: databases created before this column existed won't
  // have it, and CREATE TABLE IF NOT EXISTS above is a no-op against them.
  const reviewedSignalsColumns = db.prepare("PRAGMA table_info(reviewed_signals)").all();
  const hasDuplicateKeyColumn = reviewedSignalsColumns.some((col) => col.name === "duplicate_key");
  if (!hasDuplicateKeyColumn) {
    db.exec("ALTER TABLE reviewed_signals ADD COLUMN duplicate_key TEXT");
  }

  // Backfill-safe migration (Task 7, trailing stop): exit_plans rows created
  // before this column existed won't have it, and CREATE TABLE IF NOT EXISTS
  // above is a no-op against them.
  const exitPlansColumns = db.prepare("PRAGMA table_info(exit_plans)").all();
  const hasHighWaterMarkColumn = exitPlansColumns.some((col) => col.name === "high_water_mark");
  if (!hasHighWaterMarkColumn) {
    db.exec("ALTER TABLE exit_plans ADD COLUMN high_water_mark REAL");
  }

  // Backfill-safe migration (Task 13, idempotent orders): trade_intents rows
  // created before this column existed won't have it, and CREATE TABLE IF NOT
  // EXISTS above is a no-op against them.
  const tradeIntentsColumns = db.prepare("PRAGMA table_info(trade_intents)").all();
  const hasClientOrderIdColumn = tradeIntentsColumns.some((col) => col.name === "client_order_id");
  if (!hasClientOrderIdColumn) {
    db.exec("ALTER TABLE trade_intents ADD COLUMN client_order_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_trade_intents_client_order_id ON trade_intents(client_order_id)");

  return {
    appendAuditEvents(events) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO audit_events
        (id, timestamp, type, actor, entity_id, from_state, to_state, message, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        stmt.run(
          event.id,
          event.timestamp,
          event.type,
          event.actor,
          event.entityId || null,
          event.fromState || null,
          event.toState || null,
          event.message,
          event.details ? JSON.stringify(event.details) : null,
        );
      }
    },
    listAuditEvents(limit = 250) {
      return db.prepare("SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?").all(limit).map((row) => ({
        id: String(row.id),
        timestamp: String(row.timestamp),
        type: row.type as AuditEvent["type"],
        actor: String(row.actor),
        entityId: row.entity_id ? String(row.entity_id) : undefined,
        fromState: row.from_state as AuditEvent["fromState"],
        toState: row.to_state as AuditEvent["toState"],
        message: String(row.message),
        details: row.details_json ? JSON.parse(String(row.details_json)) : undefined,
      }));
    },
    saveReviewedSignal(signal, duplicateKey) {
      db.prepare("INSERT OR REPLACE INTO reviewed_signals (id, timestamp, duplicate_key, payload_json) VALUES (?, ?, ?, ?)")
        .run(signal.id, signal.sourceTimestamp, duplicateKey || null, JSON.stringify(signal));
    },
    listReviewedSignals(limit = 250) {
      return rowsToPayloads<ReviewedSignal>(db.prepare("SELECT payload_json FROM reviewed_signals ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    loadRecentDuplicateKeys(limit = 1000) {
      const rows = db.prepare(
        "SELECT duplicate_key FROM reviewed_signals WHERE duplicate_key IS NOT NULL ORDER BY timestamp DESC LIMIT ?",
      ).all(limit);
      return new Set(rows.map((row) => String(row.duplicate_key)));
    },
    recentAcceptedSignalsForSymbol(symbol, sinceIso) {
      const rows = db.prepare(
        "SELECT payload_json FROM reviewed_signals WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 500",
      ).all(sinceIso);
      return rowsToPayloads<ReviewedSignal>(rows)
        .filter((signal) => signal.symbol === symbol && signal.status === "accepted")
        .map((signal) => ({
          source: signal.source,
          stance: normalizeStance(signal.stance),
          sourceTimestamp: signal.sourceTimestamp,
        }));
    },
    saveRegimeAssessment(regime) {
      db.prepare("INSERT OR REPLACE INTO regime_assessments (id, timestamp, payload_json) VALUES (?, ?, ?)")
        .run(regime.id, regime.timestamp, JSON.stringify(regime));
    },
    latestRegimeAssessment() {
      return rowToPayload<RegimeAssessment>(db.prepare("SELECT payload_json FROM regime_assessments ORDER BY timestamp DESC LIMIT 1").get());
    },
    saveTradeIntent(trade) {
      db.prepare("INSERT OR REPLACE INTO trade_intents (id, timestamp, symbol, status, client_order_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(trade.id, trade.timestamp, trade.symbol, trade.status, trade.clientOrderId || null, JSON.stringify(trade));
    },
    listTradeIntents(limit = 250) {
      return rowsToPayloads<PipelineTrade>(db.prepare("SELECT payload_json FROM trade_intents ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    findTradeIntentByClientOrderId(clientOrderId) {
      return rowToPayload<PipelineTrade>(
        db.prepare("SELECT payload_json FROM trade_intents WHERE client_order_id = ? ORDER BY timestamp DESC LIMIT 1").get(clientOrderId),
      );
    },
    getTradeIntentById(tradeId) {
      return rowToPayload<PipelineTrade>(db.prepare("SELECT payload_json FROM trade_intents WHERE id = ?").get(tradeId));
    },
    saveRiskDecision(tradeId, decision) {
      db.prepare("INSERT OR REPLACE INTO risk_decisions (id, timestamp, trade_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(`risk-${tradeId}`, new Date().toISOString(), tradeId, JSON.stringify({ tradeId, decision }));
    },
    listRiskDecisions(limit = 250) {
      return rowsToPayloads(db.prepare("SELECT payload_json FROM risk_decisions ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    saveExitPlan(tradeId, exitPlan) {
      // Seed the high-water mark at the plan's entryPrice, if the plan carries
      // one (Task 7, trailing stop). This is what lets the very first
      // monitoring cycle already have a real HWM to ratchet from, rather than
      // requiring a second cycle to "discover" one. Plans without an
      // entryPrice (predating this feature, or constructed directly in tests)
      // seed NULL -- exitMonitor.ts treats that as "no trailing this cycle",
      // never as zero/garbage.
      const entryPrice = (exitPlan as { entryPrice?: unknown } | null | undefined)?.entryPrice;
      const seedHighWaterMark = typeof entryPrice === "number" && Number.isFinite(entryPrice) ? entryPrice : null;
      db.prepare("INSERT OR REPLACE INTO exit_plans (id, timestamp, trade_id, payload_json, high_water_mark) VALUES (?, ?, ?, ?, ?)")
        .run(`exit-${tradeId}`, new Date().toISOString(), tradeId, JSON.stringify({ tradeId, exitPlan }), seedHighWaterMark);
    },
    listExitPlans(limit = 250) {
      return rowsToPayloads(db.prepare("SELECT payload_json FROM exit_plans ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    latestBuySideExitPlanForSymbol(symbol) {
      // Recent-first scan over this symbol's exit plans (joined to the owning
      // trade for its symbol/side), picking the first one whose trade was a
      // BUY. Bounded scan (50) rather than a single most-recent row, since the
      // single most-recent trade for an open symbol could be a partial SELL.
      const rows = db.prepare(`
        SELECT ep.trade_id AS trade_id, ep.payload_json AS exit_payload, ep.high_water_mark AS high_water_mark, ti.payload_json AS trade_payload
        FROM exit_plans ep
        JOIN trade_intents ti ON ep.trade_id = ti.id
        WHERE ti.symbol = ?
        ORDER BY ep.timestamp DESC
        LIMIT 50
      `).all(symbol);
      for (const row of rows) {
        const tradePayload = JSON.parse(String(row.trade_payload)) as {
          side?: "buy" | "sell";
          status?: string;
          brokerLegOrderIds?: unknown;
          brokerLegStates?: Record<string, unknown>;
        };
        if (tradePayload.side !== "buy") continue;
        // Task 5 / bracket-orders review finding 1: only a trade whose CURRENT
        // status still means "reached the broker live" qualifies as the entry
        // for an open lot -- see the method's doc comment above.
        if (!tradePayload.status || !BROKER_SUCCESS_TRADE_STATUSES.has(tradePayload.status as TradeState)) continue;
        const exitPayload = JSON.parse(String(row.exit_payload)) as { exitPlan?: ExitPlan };
        if (!exitPayload.exitPlan) continue;
        const legOrderIds = Array.isArray(tradePayload.brokerLegOrderIds)
          ? tradePayload.brokerLegOrderIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : undefined;
        const legStates =
          tradePayload.brokerLegStates && typeof tradePayload.brokerLegStates === "object"
            ? (tradePayload.brokerLegStates as Record<string, TradeState>)
            : undefined;
        return {
          side: "buy" as const,
          exitPlan: exitPayload.exitPlan,
          tradeId: String(row.trade_id),
          highWaterMark: typeof row.high_water_mark === "number" ? row.high_water_mark : undefined,
          ...(legOrderIds && legOrderIds.length > 0 ? { legOrderIds } : {}),
          ...(legStates ? { legStates } : {}),
        };
      }
      return undefined;
    },
    updateHighWaterMark(tradeId, highWaterMark) {
      db.prepare("UPDATE exit_plans SET high_water_mark = ? WHERE trade_id = ?").run(highWaterMark, tradeId);
    },
    saveReconciliationReport(report) {
      db.prepare("INSERT OR REPLACE INTO reconciliation_reports (id, timestamp, status, payload_json) VALUES (?, ?, ?, ?)")
        .run(report.id, report.timestamp, report.status, JSON.stringify(report));
    },
    latestReconciliationReport() {
      return rowToPayload<ReconciliationReport>(db.prepare("SELECT payload_json FROM reconciliation_reports ORDER BY timestamp DESC LIMIT 1").get());
    },
    saveBreakerState(state) {
      db.prepare("INSERT OR REPLACE INTO breaker_states (id, timestamp, status, payload_json) VALUES (?, ?, ?, ?)")
        .run(`breaker-${state.asOf}`, state.asOf, state.status, JSON.stringify(state));
    },
    latestBreakerState() {
      return rowToPayload(db.prepare("SELECT payload_json FROM breaker_states ORDER BY timestamp DESC LIMIT 1").get());
    },
    saveCooldown(entry) {
      const now = new Date().toISOString();
      // Opportunistic cleanup: drop rows that are already expired instead of letting the
      // table grow forever. No background job needed — reads already filter by expiresAt,
      // this just keeps the table small on the write path we already have open.
      db.prepare("DELETE FROM symbol_cooldowns WHERE expires_at <= ?").run(now);
      db.prepare("INSERT OR REPLACE INTO symbol_cooldowns (symbol, expires_at, reason, updated_at) VALUES (?, ?, ?, ?)")
        .run(entry.symbol, entry.expiresAt, entry.reason, now);
    },
    listActiveCooldownSymbols(nowIso) {
      const rows = db.prepare("SELECT symbol FROM symbol_cooldowns WHERE expires_at > ?").all(nowIso);
      return rows.map((row) => String(row.symbol));
    },
    saveThesisInvalidation(entry) {
      const now = new Date().toISOString();
      // Opportunistic cleanup, same pattern as saveCooldown above.
      db.prepare("DELETE FROM thesis_invalidations WHERE expires_at <= ?").run(now);
      db.prepare("INSERT OR REPLACE INTO thesis_invalidations (symbol, source_id, reason, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.symbol, entry.sourceId, entry.reason, entry.expiresAt, now);
    },
    listActiveThesisInvalidatedSymbols(nowIso) {
      const rows = db.prepare("SELECT symbol FROM thesis_invalidations WHERE expires_at > ?").all(nowIso);
      return rows.map((row) => String(row.symbol));
    },
    saveDoNotBuy(entry) {
      const now = new Date().toISOString();
      // Opportunistic cleanup, same pattern as saveCooldown above.
      db.prepare("DELETE FROM do_not_buy WHERE expires_at <= ?").run(now);
      db.prepare("INSERT OR REPLACE INTO do_not_buy (symbol, source_id, reason, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.symbol, entry.sourceId, entry.reason, entry.expiresAt, now);
    },
    listActiveDoNotBuy(nowIso) {
      const rows = db.prepare("SELECT symbol, source_id, reason, expires_at FROM do_not_buy WHERE expires_at > ?").all(nowIso);
      return rows.map((row) => ({
        symbol: String(row.symbol),
        sourceId: String(row.source_id),
        reason: String(row.reason),
        expiresAt: String(row.expires_at),
      }));
    },
    deleteDoNotBuy(symbol) {
      // node:sqlite's StatementSync.run resolves to { changes, lastInsertRowid };
      // typed `unknown` in this file's minimal DatabaseSync facade, so narrow it here.
      const result = db.prepare("DELETE FROM do_not_buy WHERE symbol = ?").run(symbol) as { changes?: number | bigint };
      return Number(result?.changes ?? 0) > 0;
    },
    getAppState(key) {
      const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
      return row ? String(row.value) : undefined;
    },
    setAppState(key, value) {
      db.prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
        .run(key, value, new Date().toISOString());
    },
    getConfig() {
      const row = db.prepare("SELECT payload_json FROM config WHERE id = ?").get(SINGLETON_ROW_ID);
      return row ? (JSON.parse(String(row.payload_json)) as AppConfig) : undefined;
    },
    setConfig(config) {
      const existing = db.prepare("SELECT version FROM config WHERE id = ?").get(SINGLETON_ROW_ID);
      const nextVersion = existing ? Number(existing.version) + 1 : 1;
      db.prepare("INSERT OR REPLACE INTO config (id, version, payload_json, updated_at) VALUES (?, ?, ?, ?)")
        .run(SINGLETON_ROW_ID, nextVersion, JSON.stringify(config), new Date().toISOString());
    },
    addSyncLog(log) {
      db.prepare(`
        INSERT OR REPLACE INTO sync_logs (id, timestamp, level, message, details, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(log.id, log.timestamp, log.type, log.message, log.details ?? null, JSON.stringify(log));
      // Opportunistic prune (same pattern as saveCooldown's delete-on-write
      // above): keep only the newest SYNC_LOG_RETENTION rows, ordered by
      // timestamp with the implicit rowid as an insertion-order tiebreak for
      // same-millisecond writes (a single sync cycle can log several lines
      // within one JS event-loop tick). Cheap COUNT(*) guard first -- a sync
      // cycle logs a few dozen lines at a time, so most calls are well under
      // the retention cap and should skip the DELETE/subquery entirely rather
      // than re-sorting the whole table on every single log line.
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM sync_logs").get() as { count: number };
      if (Number(count) > SYNC_LOG_RETENTION) {
        db.exec(`
          DELETE FROM sync_logs WHERE id NOT IN (
            SELECT id FROM sync_logs ORDER BY timestamp DESC, rowid DESC LIMIT ${SYNC_LOG_RETENTION}
          )
        `);
      }
    },
    listSyncLogs(limit = SYNC_LOG_RETENTION) {
      return rowsToPayloads<SyncLog>(
        db.prepare("SELECT payload_json FROM sync_logs ORDER BY timestamp DESC, rowid DESC LIMIT ?").all(limit),
      );
    },
    appendAnalysis(analysis) {
      db.prepare("INSERT OR REPLACE INTO analyses (id, timestamp, payload_json) VALUES (?, ?, ?)")
        .run(analysis.id, analysis.timestamp, JSON.stringify(analysis));
    },
    listAnalyses(limit = 10000) {
      return rowsToPayloads<StockAnalysis>(
        db.prepare("SELECT payload_json FROM analyses ORDER BY timestamp DESC, rowid DESC LIMIT ?").all(limit),
      );
    },
    appendUiTrade(trade) {
      db.prepare("INSERT OR REPLACE INTO ui_trades (id, timestamp, payload_json) VALUES (?, ?, ?)")
        .run(trade.id, trade.timestamp, JSON.stringify(trade));
    },
    listUiTrades(limit = 10000) {
      return rowsToPayloads<Trade>(
        db.prepare("SELECT payload_json FROM ui_trades ORDER BY timestamp DESC, rowid DESC LIMIT ?").all(limit),
      );
    },
    getSimulatedPortfolio() {
      const row = db.prepare("SELECT payload_json FROM simulated_portfolio WHERE id = ?").get(SINGLETON_ROW_ID);
      return row ? (JSON.parse(String(row.payload_json)) as Record<string, unknown> & { positions: unknown[] }) : undefined;
    },
    setSimulatedPortfolio(portfolio) {
      db.prepare("INSERT OR REPLACE INTO simulated_portfolio (id, payload_json, updated_at) VALUES (?, ?, ?)")
        .run(SINGLETON_ROW_ID, JSON.stringify(portfolio), new Date().toISOString());
    },
    backupTo(destPath) {
      // node:sqlite's exec() takes a raw SQL string (no parameter binding for
      // VACUUM INTO's target). destPath is always our own generated filename
      // (never end-user input -- see the interface doc comment above); the
      // quote-escaping below is defense in depth, not the primary safety
      // boundary.
      db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    },
    close() {
      db.close();
    },
  };
}

function rowsToPayloads<T = unknown>(rows: Array<Record<string, unknown>>): T[] {
  return rows.map((row) => JSON.parse(String(row.payload_json)) as T);
}

function rowToPayload<T>(row: Record<string, unknown> | undefined): T | undefined {
  return row ? JSON.parse(String(row.payload_json)) as T : undefined;
}
