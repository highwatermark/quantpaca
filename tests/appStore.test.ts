// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// the Store facade (src/server/appStore.ts) that replaces server.ts's old
// readDB()/writeDB() db.json pair, and the one-time db.json -> SQLite
// migration it exposes. Uses a real (temp-file) ProductionStore, same
// "not fakes" convention as tests/backupIntegration.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAppStore,
  migrateDbJsonIfNeeded,
  dbJsonMigratedMarkerPath,
  DBJSON_MIGRATED_AT_APP_STATE_KEY,
  DEFAULT_CONFIG,
  DEFAULT_SIMULATED_PORTFOLIO,
} from "../src/server/appStore";
import { createProductionStore, SYNC_LOG_RETENTION } from "../src/server/persistence";

function freshStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-appstore-test-"));
  const sqlitePath = path.join(dataDir, "quantpaca.sqlite");
  const dbJsonPath = path.join(dataDir, "db.json");
  const productionStore = createProductionStore(sqlitePath);
  const appStore = createAppStore(productionStore);
  return { dataDir, dbJsonPath, productionStore, appStore };
}

// --- Facade: config ---

test("getConfig defaults when nothing has ever been written", () => {
  const { appStore } = freshStore();
  assert.deepEqual(appStore.getConfig(), DEFAULT_CONFIG);
});

test("setConfig/getConfig round-trip", () => {
  const { appStore } = freshStore();
  const config = { ...DEFAULT_CONFIG, system: { ...DEFAULT_CONFIG.system, autoTrading: true } };
  appStore.setConfig(config);
  assert.deepEqual(appStore.getConfig(), config);
});

test("updateConfig applies the updater atomically and returns the new config", async () => {
  const { appStore } = freshStore();
  const next = await appStore.updateConfig((current) => ({ ...current, system: { ...current.system, runIntervalMins: 30 } }));
  assert.equal(next.system.runIntervalMins, 30);
  assert.equal(appStore.getConfig().system.runIntervalMins, 30);
});

// --- Facade: config read-modify-write serialization (mirrors
// tests/telegramMutex.test.ts's mutex pattern) ---

test("updateConfig serializes concurrent read-modify-write calls instead of racing them", async () => {
  const { appStore } = freshStore();
  await appStore.updateConfig((current) => ({ ...current, system: { ...current.system, runIntervalMins: 1 } }));

  const release = await appStore.acquire(); // simulate an in-flight update holding the lock

  const pending = appStore.updateConfig((current) => ({
    ...current,
    system: { ...current.system, runIntervalMins: current.system.runIntervalMins + 1 },
  }));

  // Give the pending update a chance to (incorrectly) run while the lock is held.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(appStore.getConfig().system.runIntervalMins, 1, "must not have applied yet while the lock is held");

  release();
  await pending;

  assert.equal(appStore.getConfig().system.runIntervalMins, 2);
});

test("updateConfig calls never interleave under concurrent load (read-then-write stays atomic)", async () => {
  const { appStore } = freshStore();
  await appStore.updateConfig((current) => ({ ...current, system: { ...current.system, runIntervalMins: 0 } }));

  const increments = Array.from({ length: 20 }, () =>
    appStore.updateConfig((current) => ({ ...current, system: { ...current.system, runIntervalMins: current.system.runIntervalMins + 1 } })),
  );
  await Promise.all(increments);

  assert.equal(appStore.getConfig().system.runIntervalMins, 20, "every increment must be observed; a race would lose some");
});

// --- Facade: logs, trades, analyses, simulated portfolio ---

test("addLog/getLogs round-trip, newest first", () => {
  const { appStore } = freshStore();
  appStore.addLog({ id: "l-1", timestamp: "2026-01-01T00:00:00.000Z", type: "sync", message: "first" });
  appStore.addLog({ id: "l-2", timestamp: "2026-01-01T00:00:01.000Z", type: "sync", message: "second" });
  const logs = appStore.getLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].id, "l-2");
  assert.equal(logs[1].id, "l-1");
});

test("log retention prunes to the newest SYNC_LOG_RETENTION rows", () => {
  const { appStore } = freshStore();
  const total = SYNC_LOG_RETENTION + 25;
  for (let i = 0; i < total; i++) {
    appStore.addLog({
      id: `l-${i}`,
      timestamp: new Date(i * 1000).toISOString(),
      type: "sync",
      message: `line ${i}`,
    });
  }
  const logs = appStore.getLogs(total);
  assert.equal(logs.length, SYNC_LOG_RETENTION);
  // Newest-first: the survivors are the LAST SYNC_LOG_RETENTION written (highest i).
  assert.equal(logs[0].id, `l-${total - 1}`);
  assert.equal(logs[logs.length - 1].id, `l-${total - SYNC_LOG_RETENTION}`);
});

test("appendTrade/listTrades round-trip and upsert-by-id in place", () => {
  const { appStore } = freshStore();
  const trade = {
    id: "t-1", symbol: "AAPL", qty: 1, price: 100, side: "buy" as const, status: "Accepted",
    timestamp: "2026-01-01T00:00:00.000Z", reasoning: "r", notifiedTelegram: false, exportedSheets: false, loggedNotion: false,
  };
  appStore.appendTrade(trade);
  appStore.appendTrade({ ...trade, notifiedTelegram: true });
  const trades = appStore.listTrades();
  assert.equal(trades.length, 1, "same id must upsert in place, not duplicate");
  assert.equal(trades[0].notifiedTelegram, true);
});

test("appendAnalysis/listAnalyses round-trip", () => {
  const { appStore } = freshStore();
  const analysis = {
    id: "a-1", symbol: "AAPL", source: "email" as const, sourceTitle: "t", sourceContent: "c",
    growthScore: 80, sentimentScore: 50, riskProfile: "Low" as const, reasoning: "r", whipsawCheck: "w",
    decision: "BUY" as const, timestamp: "2026-01-01T00:00:00.000Z",
  };
  appStore.appendAnalysis(analysis);
  const analyses = appStore.listAnalyses();
  assert.equal(analyses.length, 1);
  assert.deepEqual(analyses[0], analysis);
});

test("simulatedPortfolio defaults, then get/set round-trips", () => {
  const { appStore } = freshStore();
  assert.deepEqual(appStore.getSimulatedPortfolio(), DEFAULT_SIMULATED_PORTFOLIO);
  const updated = { ...DEFAULT_SIMULATED_PORTFOLIO, cash: "50.00" };
  appStore.setSimulatedPortfolio(updated);
  assert.deepEqual(appStore.getSimulatedPortfolio(), updated);
});

// --- Migration ---

test("migration: fixture db.json + empty SQLite copies all five state classes and stamps the marker", () => {
  const { dbJsonPath, productionStore, appStore } = freshStore();
  const fixture = {
    config: { ...DEFAULT_CONFIG, system: { ...DEFAULT_CONFIG.system, autoTrading: true } },
    syncLogs: [{ id: "l-1", timestamp: "2026-01-01T00:00:00.000Z", type: "sync", message: "hello" }],
    analyses: [{
      id: "a-1", symbol: "AAPL", source: "email", sourceTitle: "t", sourceContent: "c",
      growthScore: 80, sentimentScore: 50, riskProfile: "Low", reasoning: "r", whipsawCheck: "w",
      decision: "BUY", timestamp: "2026-01-01T00:00:00.000Z",
    }],
    trades: [{
      id: "t-1", symbol: "AAPL", qty: 1, price: 100, side: "buy", status: "Accepted",
      timestamp: "2026-01-01T00:00:00.000Z", reasoning: "r", notifiedTelegram: false, exportedSheets: false, loggedNotion: false,
    }],
    simulatedPortfolio: { ...DEFAULT_SIMULATED_PORTFOLIO, cash: "12345.00" },
    // Legacy field -- must NOT be migrated (SQLite audit_events is already the record).
    auditEvents: [{ id: "ae-1", timestamp: "2026-01-01T00:00:00.000Z", type: "sync", actor: "x", message: "legacy" }],
  };
  fs.writeFileSync(dbJsonPath, JSON.stringify(fixture, null, 2), "utf8");

  const result = migrateDbJsonIfNeeded(appStore, productionStore, dbJsonPath);
  assert.equal(result.ran, true);
  assert.equal(result.source, "db_json");

  assert.deepEqual(appStore.getConfig(), fixture.config);
  const logs = appStore.getLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, "l-1");
  assert.deepEqual(appStore.listAnalyses(), fixture.analyses);
  assert.deepEqual(appStore.listTrades(), fixture.trades);
  assert.deepEqual(appStore.getSimulatedPortfolio(), fixture.simulatedPortfolio);

  const marker = productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY);
  assert.ok(marker, "marker must be stamped");
  assert.ok(fs.existsSync(dbJsonMigratedMarkerPath(dbJsonPath)), "sibling .MIGRATED marker file must exist");

  const auditEvents = productionStore.listAuditEvents();
  assert.ok(auditEvents.some((e) => e.actor === "dbjson_migration"), "migration must be audited");
});

test("migration: syncLogs tail is capped at SYNC_LOG_RETENTION during migration", () => {
  const { dbJsonPath, productionStore, appStore } = freshStore();
  const total = SYNC_LOG_RETENTION + 10;
  const syncLogs = Array.from({ length: total }, (_, i) => ({
    id: `l-${i}`,
    timestamp: new Date(i * 1000).toISOString(),
    type: "sync",
    message: `line ${i}`,
  }));
  fs.writeFileSync(dbJsonPath, JSON.stringify({ config: DEFAULT_CONFIG, syncLogs }, null, 2), "utf8");

  migrateDbJsonIfNeeded(appStore, productionStore, dbJsonPath);
  assert.equal(appStore.getLogs(total).length, SYNC_LOG_RETENTION);
});

test("migration: second boot no-ops (idempotent, gated on the marker)", () => {
  const { dbJsonPath, productionStore, appStore } = freshStore();
  fs.writeFileSync(dbJsonPath, JSON.stringify({ config: { ...DEFAULT_CONFIG, system: { ...DEFAULT_CONFIG.system, autoTrading: true } } }, null, 2), "utf8");

  const first = migrateDbJsonIfNeeded(appStore, productionStore, dbJsonPath);
  assert.equal(first.ran, true);
  const markerAfterFirst = productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY);

  // Mutate config after the first migration -- a second migration run must
  // NOT overwrite it (it's gated on the marker, not on "is db.json newer").
  appStore.setConfig({ ...DEFAULT_CONFIG, system: { ...DEFAULT_CONFIG.system, runIntervalMins: 99 } });

  const second = migrateDbJsonIfNeeded(appStore, productionStore, dbJsonPath);
  assert.equal(second.ran, false);
  assert.equal(second.source, "already_migrated");
  assert.equal(appStore.getConfig().system.runIntervalMins, 99, "second run must not re-copy over the post-migration mutation");
  assert.equal(productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY), markerAfterFirst);
});

test("migration: empty/absent db.json produces clean first-boot defaults and still stamps the marker", () => {
  const { dbJsonPath, productionStore, appStore } = freshStore();
  assert.equal(fs.existsSync(dbJsonPath), false);

  const result = migrateDbJsonIfNeeded(appStore, productionStore, dbJsonPath);
  assert.equal(result.ran, true);
  assert.equal(result.source, "clean_default");
  assert.deepEqual(appStore.getConfig(), DEFAULT_CONFIG);
  assert.deepEqual(appStore.getSimulatedPortfolio(), DEFAULT_SIMULATED_PORTFOLIO);
  assert.ok(productionStore.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY), "marker must be stamped even with no db.json");
});
