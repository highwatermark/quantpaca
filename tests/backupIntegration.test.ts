// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backups, tested
// through the REAL server wiring (real fs, real productionStore) -- same
// convention as tests/supervisorHeartbeatIntegration.test.ts. Pure
// retention/alert-throttle decision logic is unit-tested directly in
// tests/backupEngine.test.ts; this file only proves the wiring produces a
// real, valid, on-disk SQLite backup and reaches it from both trigger paths
// (boot, and the Nth completed scheduled cycle).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-backup-integration-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const backupsDir = path.join(dataDir, "backups");
const dbJsonPath = path.join(dataDir, "db.json");

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.telegram.org")) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    return new Response(
      JSON.stringify({
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "fixture: nothing notable this cycle." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

const { runBackupForTests, runScheduledSyncTickForTests } = await import("../server");
const { CYCLE_COUNT_APP_STATE_KEY } = await import("../src/server/heartbeat");
const { BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY } = await import("../src/server/backupEngine");
const { createProductionStore } = await import("../src/server/persistence");

function setAppState(key: string, value: string) {
  const store = createProductionStore(path.join(dataDir, "quantpaca.sqlite"));
  try {
    store.setAppState(key, value);
  } finally {
    store.close();
  }
}

function getAppState(key: string): string | undefined {
  const store = createProductionStore(path.join(dataDir, "quantpaca.sqlite"));
  try {
    return store.getAppState(key);
  } finally {
    store.close();
  }
}

function writeDbJson() {
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(
    dbJsonPath,
    JSON.stringify({
      config: {
        telegram: { botToken: "", chatId: "", enabled: false },
        system: { autoTrading: true, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 5, targetProfitPercent: 15 },
      },
    }, null, 2),
    "utf8",
  );
}
writeDbJson();

function listSqliteBackups(): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter((f) => f.endsWith(".sqlite"));
}

test("boot backup: produces a real, valid, queryable SQLite file", async () => {
  const before = listSqliteBackups().length;
  const result = await runBackupForTests("boot");
  assert.equal(result.ok, true);

  const after = listSqliteBackups();
  assert.equal(after.length, before + 1, `expected exactly one new backup file, got: ${JSON.stringify(after)}`);

  const backupPath = path.join(backupsDir, after[after.length - 1]);
  // Open read-only and query a real table -- proves this is a valid,
  // structurally intact SQLite database, not just a file that happens to exist.
  const db = new DatabaseSync(backupPath, { readOnly: true } as any);
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").all();
    assert.equal(rows.length, 1, "the backup must contain the real schema (audit_events table)");
    // A simple query must succeed without throwing.
    db.prepare("SELECT COUNT(*) as n FROM app_state").get();
  } finally {
    db.close();
  }

  // A db.json backup rides alongside (interim scope).
  const jsonBackups = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".json"));
  assert.ok(jsonBackups.length >= 1, "expected at least one db.json backup alongside the sqlite one");

  const lastSuccessAt = getAppState(BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY);
  assert.ok(lastSuccessAt && Number.isFinite(Number(lastSuccessAt)));
});

test("the 48th completed scheduled cycle triggers a backup through the real onCycleCompleted wiring", async () => {
  setAppState(CYCLE_COUNT_APP_STATE_KEY, "47");
  const before = listSqliteBackups().length;

  await runScheduledSyncTickForTests(); // -> the 48th completed cycle

  assert.equal(getAppState(CYCLE_COUNT_APP_STATE_KEY), "48");
  const after = listSqliteBackups();
  assert.equal(after.length, before + 1, `expected exactly one new backup from the 48th cycle, got: ${JSON.stringify(after)}`);
});

test("the 49th completed scheduled cycle does NOT trigger another backup", async () => {
  const before = listSqliteBackups().length;
  await runScheduledSyncTickForTests(); // -> the 49th completed cycle
  assert.equal(getAppState(CYCLE_COUNT_APP_STATE_KEY), "49");
  assert.equal(listSqliteBackups().length, before, "no new backup on a non-48-multiple cycle");
});

test("a backup failure (unwritable destination) is logged, not thrown, and does not crash the caller", async () => {
  // Point the "sqlite" backup target at a path where fs.copyFileSync/VACUUM
  // INTO cannot succeed: pre-create a FILE at the backups directory's own
  // path so mkdir/exec against it fails deterministically.
  const brokenDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-backup-broken-"));
  process.env.QUANTPACA_DATA_DIR = brokenDataDir;
  const brokenBackupsDir = path.join(brokenDataDir, "backups");
  fs.writeFileSync(brokenBackupsDir, "not a directory"); // a FILE occupies the dir's path

  try {
    // A fresh server module instance is needed to pick up the new DATA_DIR
    // (module-scope constants are read once at import time) -- but this repo's
    // convention (see other integration tests) is one server import per test
    // FILE/process, not per test. Exercise the same failure mode directly
    // against backupEngine.runBackup instead, using deps that mirror
    // server.ts's real wiring shape but point at the broken directory --
    // this still proves "never throws" end-to-end against real fs calls
    // (not fakes), just without re-importing server.ts.
    const { runBackup } = await import("../src/server/backupEngine");
    const { createProductionStore: createStore } = await import("../src/server/persistence");
    const store = createStore(path.join(brokenDataDir, "quantpaca.sqlite"));
    try {
      const logs: string[] = [];
      const result = await runBackup("boot", {
        now: () => Date.now(),
        ensureBackupsDir: () => fs.mkdirSync(brokenBackupsDir, { recursive: true }),
        backupSqliteTo: (filename) => store.backupTo(path.join(brokenBackupsDir, filename)),
        dbJsonExists: () => false,
        copyDbJsonTo: () => {},
        listBackupsDir: () => {
          try {
            return fs.readdirSync(brokenBackupsDir);
          } catch {
            return [];
          }
        },
        deleteBackupFile: (filename) => fs.unlinkSync(path.join(brokenBackupsDir, filename)),
        getAppState: (key) => store.getAppState(key),
        setAppState: (key, value) => store.setAppState(key, value),
        appendAuditEvent: (message) => store.appendAuditEvents([{
          id: `ae-test-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: "backup",
          actor: "backup_engine",
          message,
        }]),
        sendAlert: async () => false,
        log: (message) => logs.push(message),
      });
      assert.equal(result.ok, false, "reported as failed");
      assert.ok(logs.some((m) => /FAILED/.test(m)), "the failure was logged");
    } finally {
      store.close();
    }
  } finally {
    process.env.QUANTPACA_DATA_DIR = dataDir;
    fs.rmSync(brokenDataDir, { recursive: true, force: true });
  }
});

after(() => {
  globalThis.fetch = realFetch;
});
