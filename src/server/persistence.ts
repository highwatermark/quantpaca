import fs from "node:fs";
import path from "node:path";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { AuditEvent, ExitPlan, PipelineTrade } from "./tradingSafety";
import { ReconciliationReport, RegimeAssessment, ReviewedSignal, SizedTradeIntent } from "./domainTypes";

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
  latestBuySideExitPlanForSymbol(symbol: string): { side: "buy" | "sell"; exitPlan: ExitPlan; tradeId: string; highWaterMark?: number; legOrderIds?: string[] } | undefined;
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
  close(): void;
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
        const tradePayload = JSON.parse(String(row.trade_payload)) as { side?: "buy" | "sell"; brokerLegOrderIds?: unknown };
        if (tradePayload.side !== "buy") continue;
        const exitPayload = JSON.parse(String(row.exit_payload)) as { exitPlan?: ExitPlan };
        if (!exitPayload.exitPlan) continue;
        const legOrderIds = Array.isArray(tradePayload.brokerLegOrderIds)
          ? tradePayload.brokerLegOrderIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : undefined;
        return {
          side: "buy" as const,
          exitPlan: exitPayload.exitPlan,
          tradeId: String(row.trade_id),
          highWaterMark: typeof row.high_water_mark === "number" ? row.high_water_mark : undefined,
          ...(legOrderIds && legOrderIds.length > 0 ? { legOrderIds } : {}),
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
    getAppState(key) {
      const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
      return row ? String(row.value) : undefined;
    },
    setAppState(key, value) {
      db.prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
        .run(key, value, new Date().toISOString());
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
