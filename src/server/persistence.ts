import fs from "node:fs";
import path from "node:path";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { AuditEvent, PipelineTrade } from "./tradingSafety";
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
  saveReviewedSignal(signal: ReviewedSignal): void;
  listReviewedSignals(limit?: number): ReviewedSignal[];
  saveRegimeAssessment(regime: RegimeAssessment): void;
  latestRegimeAssessment(): RegimeAssessment | undefined;
  saveTradeIntent(trade: PipelineTrade): void;
  listTradeIntents(limit?: number): PipelineTrade[];
  saveRiskDecision(tradeId: string, decision: unknown): void;
  listRiskDecisions(limit?: number): unknown[];
  saveExitPlan(tradeId: string, exitPlan: unknown): void;
  listExitPlans(limit?: number): unknown[];
  saveReconciliationReport(report: ReconciliationReport): void;
  latestReconciliationReport(): ReconciliationReport | undefined;
  close(): void;
};

export function createProductionStore(dbPath = path.join(process.cwd(), "data", "quantpaca.sqlite")): ProductionStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new NodeDatabaseSync(dbPath) as DatabaseSync;
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
  `);

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
    saveReviewedSignal(signal) {
      db.prepare("INSERT OR REPLACE INTO reviewed_signals (id, timestamp, payload_json) VALUES (?, ?, ?)")
        .run(signal.id, signal.sourceTimestamp, JSON.stringify(signal));
    },
    listReviewedSignals(limit = 250) {
      return rowsToPayloads<ReviewedSignal>(db.prepare("SELECT payload_json FROM reviewed_signals ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    saveRegimeAssessment(regime) {
      db.prepare("INSERT OR REPLACE INTO regime_assessments (id, timestamp, payload_json) VALUES (?, ?, ?)")
        .run(regime.id, regime.timestamp, JSON.stringify(regime));
    },
    latestRegimeAssessment() {
      return rowToPayload<RegimeAssessment>(db.prepare("SELECT payload_json FROM regime_assessments ORDER BY timestamp DESC LIMIT 1").get());
    },
    saveTradeIntent(trade) {
      db.prepare("INSERT OR REPLACE INTO trade_intents (id, timestamp, symbol, status, payload_json) VALUES (?, ?, ?, ?, ?)")
        .run(trade.id, trade.timestamp, trade.symbol, trade.status, JSON.stringify(trade));
    },
    listTradeIntents(limit = 250) {
      return rowsToPayloads<PipelineTrade>(db.prepare("SELECT payload_json FROM trade_intents ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    saveRiskDecision(tradeId, decision) {
      db.prepare("INSERT OR REPLACE INTO risk_decisions (id, timestamp, trade_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(`risk-${tradeId}`, new Date().toISOString(), tradeId, JSON.stringify({ tradeId, decision }));
    },
    listRiskDecisions(limit = 250) {
      return rowsToPayloads(db.prepare("SELECT payload_json FROM risk_decisions ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    saveExitPlan(tradeId, exitPlan) {
      db.prepare("INSERT OR REPLACE INTO exit_plans (id, timestamp, trade_id, payload_json) VALUES (?, ?, ?, ?)")
        .run(`exit-${tradeId}`, new Date().toISOString(), tradeId, JSON.stringify({ tradeId, exitPlan }));
    },
    listExitPlans(limit = 250) {
      return rowsToPayloads(db.prepare("SELECT payload_json FROM exit_plans ORDER BY timestamp DESC LIMIT ?").all(limit));
    },
    saveReconciliationReport(report) {
      db.prepare("INSERT OR REPLACE INTO reconciliation_reports (id, timestamp, status, payload_json) VALUES (?, ?, ?, ?)")
        .run(report.id, report.timestamp, report.status, JSON.stringify(report));
    },
    latestReconciliationReport() {
      return rowToPayload<ReconciliationReport>(db.prepare("SELECT payload_json FROM reconciliation_reports ORDER BY timestamp DESC LIMIT 1").get());
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
