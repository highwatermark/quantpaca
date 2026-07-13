// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backups. Pure
// decision/orchestration logic lives here (unit-testable without a real
// filesystem or SQLite handle -- server.ts wires the real fs/productionStore
// calls through the injected BackupDeps, same DI convention as scheduler.ts
// and heartbeat.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_EVERY_N_CYCLES,
  BACKUP_RETENTION_COUNT,
  BACKUP_FAILURE_ALERT_THRESHOLD_MS,
  BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY,
  BACKUP_FAILING_SINCE_APP_STATE_KEY,
  BACKUP_ALERTED_FAILING_SINCE_APP_STATE_KEY,
  shouldRunScheduledBackup,
  backupStamp,
  sqliteBackupFilename,
  dbJsonBackupFilename,
  extractBackupStamps,
  selectStampsToDelete,
  isBackupFailureOverdue,
  shouldAlertBackupFailure,
  runBackup,
  BackupDeps,
} from "../src/server/backupEngine";

// --- Named constants ---

test("named constants: every 48 cycles, retain 14, alert after 24h", () => {
  assert.equal(BACKUP_EVERY_N_CYCLES, 48);
  assert.equal(BACKUP_RETENTION_COUNT, 14);
  assert.equal(BACKUP_FAILURE_ALERT_THRESHOLD_MS, 24 * 60 * 60 * 1000);
  assert.equal(typeof BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY, "string");
  assert.equal(typeof BACKUP_FAILING_SINCE_APP_STATE_KEY, "string");
  assert.equal(typeof BACKUP_ALERTED_FAILING_SINCE_APP_STATE_KEY, "string");
});

// --- shouldRunScheduledBackup: every Nth completed cycle ---

test("47th completed cycle: no backup", () => {
  assert.equal(shouldRunScheduledBackup(47), false);
});

test("48th completed cycle: backup", () => {
  assert.equal(shouldRunScheduledBackup(48), true);
});

test("96th completed cycle (2nd multiple of 48): backup again", () => {
  assert.equal(shouldRunScheduledBackup(96), true);
});

test("0th (no cycles yet): no backup", () => {
  assert.equal(shouldRunScheduledBackup(0), false);
});

test("custom everyNCycles is respected", () => {
  assert.equal(shouldRunScheduledBackup(5, 5), true);
  assert.equal(shouldRunScheduledBackup(4, 5), false);
});

// --- filenames ---

test("backupStamp sanitizes an ISO timestamp for filesystem safety", () => {
  const stamp = backupStamp(new Date("2026-07-12T14:30:00.123Z"));
  assert.doesNotMatch(stamp, /[:.]/);
  assert.match(stamp, /^2026-07-12T14-30-00-123Z$/);
});

test("sqliteBackupFilename / dbJsonBackupFilename share the stamp", () => {
  const stamp = "2026-07-12T14-30-00-000Z";
  assert.equal(sqliteBackupFilename(stamp), "quantpaca-2026-07-12T14-30-00-000Z.sqlite");
  assert.equal(dbJsonBackupFilename(stamp), "db-2026-07-12T14-30-00-000Z.json");
});

// --- retention ---

test("extractBackupStamps pulls stamps from sqlite backup filenames only, ignoring unrelated files", () => {
  const stamps = extractBackupStamps([
    "quantpaca-2026-07-12T00-00-00-000Z.sqlite",
    "db-2026-07-12T00-00-00-000Z.json",
    "quantpaca-2026-07-11T00-00-00-000Z.sqlite",
    ".DS_Store",
    "readme.txt",
  ]);
  assert.deepEqual(stamps.sort(), ["2026-07-11T00-00-00-000Z", "2026-07-12T00-00-00-000Z"]);
});

test("selectStampsToDelete keeps the newest N, deletes the rest (bounded)", () => {
  const stamps = Array.from({ length: 16 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`);
  const toDelete = selectStampsToDelete(stamps, 14);
  assert.equal(toDelete.length, 2, "16 stamps, retain 14 -> delete 2 oldest");
  assert.deepEqual(toDelete, ["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z"]);
});

test("selectStampsToDelete: at or under retention deletes nothing", () => {
  const stamps = Array.from({ length: 14 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z`);
  assert.deepEqual(selectStampsToDelete(stamps, 14), []);
  assert.deepEqual(selectStampsToDelete(stamps.slice(0, 3), 14), []);
});

// --- 24h failure alert ---

test("isBackupFailureOverdue: no failing-since stamp -> not overdue", () => {
  assert.equal(isBackupFailureOverdue(undefined, 1_000_000), false);
});

test("isBackupFailureOverdue: over 24h since failing began -> overdue", () => {
  const nowMs = 1_000_000_000;
  const failingSinceMs = nowMs - 25 * 60 * 60 * 1000;
  assert.equal(isBackupFailureOverdue(failingSinceMs, nowMs), true);
});

test("isBackupFailureOverdue: under 24h -> not yet overdue", () => {
  const nowMs = 1_000_000_000;
  const failingSinceMs = nowMs - 23 * 60 * 60 * 1000;
  assert.equal(isBackupFailureOverdue(failingSinceMs, nowMs), false);
});

test("shouldAlertBackupFailure: overdue, never alerted -> alerts; same failing-since again -> silent; new failing-since -> alerts again", () => {
  const nowMs = 1_000_000_000;
  const failingSinceMs = nowMs - 25 * 60 * 60 * 1000;
  assert.equal(shouldAlertBackupFailure(failingSinceMs, nowMs, undefined), true);
  assert.equal(shouldAlertBackupFailure(failingSinceMs, nowMs, failingSinceMs), false, "already alerted for this exact failing-since stamp");
  const newFailingSinceMs = nowMs - 26 * 60 * 60 * 1000;
  assert.equal(shouldAlertBackupFailure(newFailingSinceMs, nowMs, failingSinceMs), true, "a different failing-since stamp is a new streak");
});

// --- runBackup orchestration (fully injected; no real fs/sqlite) ---

function makeFakeDeps(overrides: Partial<BackupDeps> = {}): { deps: BackupDeps; state: Map<string, string>; log: string[]; alerts: string[]; audits: string[]; dirFiles: string[] } {
  const state = new Map<string, string>();
  const log: string[] = [];
  const alerts: string[] = [];
  const audits: string[] = [];
  const dirFiles: string[] = [];
  const deps: BackupDeps = {
    now: () => 1_000_000,
    ensureBackupsDir: () => {},
    backupSqliteTo: (filename) => {
      dirFiles.push(filename);
    },
    dbJsonExists: () => true,
    copyDbJsonTo: (filename) => {
      dirFiles.push(filename);
    },
    listBackupsDir: () => dirFiles.slice(),
    deleteBackupFile: (filename) => {
      const idx = dirFiles.indexOf(filename);
      if (idx >= 0) dirFiles.splice(idx, 1);
    },
    getAppState: (key) => state.get(key),
    setAppState: (key, value) => {
      state.set(key, value);
    },
    appendAuditEvent: (message) => {
      audits.push(message);
    },
    sendAlert: async (message) => {
      alerts.push(message);
      return true;
    },
    log: (message) => {
      log.push(message);
    },
    ...overrides,
  };
  return { deps, state, log, alerts, audits, dirFiles };
}

test("runBackup success: writes sqlite + db.json backups, stamps last-success, clears failing-since", async () => {
  const { deps, state, dirFiles } = makeFakeDeps();
  const result = await runBackup("boot", deps);
  assert.equal(result.ok, true);
  assert.equal(dirFiles.some((f) => /^quantpaca-.*\.sqlite$/.test(f)), true);
  assert.equal(dirFiles.some((f) => /^db-.*\.json$/.test(f)), true);
  assert.equal(state.get(BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY), "1000000");
  assert.equal(state.get(BACKUP_FAILING_SINCE_APP_STATE_KEY), "");
});

test("runBackup failure: never throws, logs + audits, stamps failing-since", async () => {
  const { deps, state, log, audits } = makeFakeDeps({
    backupSqliteTo: () => {
      throw new Error("disk full");
    },
  });
  const result = await runBackup("cycle", deps);
  assert.equal(result.ok, false, "reported as failed, not thrown");
  assert.ok(log.some((m) => /disk full/.test(m)), "failure is logged");
  assert.ok(audits.some((m) => /disk full/.test(m)), "failure is audited");
  assert.equal(state.get(BACKUP_FAILING_SINCE_APP_STATE_KEY), "1000000");
});

test("runBackup: repeated failures within 24h do not alert; crossing the 24h threshold alerts once", async () => {
  let nowMs = 0;
  const { deps, alerts } = makeFakeDeps({
    now: () => nowMs,
    backupSqliteTo: () => {
      throw new Error("still down");
    },
  });

  nowMs = 0;
  await runBackup("cycle", deps);
  assert.equal(alerts.length, 0, "first failure: not yet 24h");

  nowMs = 10 * 60 * 60 * 1000; // 10h later, still failing
  await runBackup("cycle", deps);
  assert.equal(alerts.length, 0, "still under 24h since the first failure");

  nowMs = 25 * 60 * 60 * 1000; // 25h since the first failure
  await runBackup("cycle", deps);
  assert.equal(alerts.length, 1, "24h+ of continuous failure alerts exactly once");
  assert.match(alerts[0], /24h/);

  nowMs = 26 * 60 * 60 * 1000; // still the same failing streak
  await runBackup("cycle", deps);
  assert.equal(alerts.length, 1, "does not re-alert for the same ongoing streak");
});

test("runBackup: a success after failures clears the streak so a later failure re-alerts fresh", async () => {
  let nowMs = 0;
  let shouldFail = true;
  const { deps, alerts } = makeFakeDeps({
    now: () => nowMs,
    backupSqliteTo: (filename) => {
      if (shouldFail) throw new Error("down");
    },
  });

  await runBackup("cycle", deps); // fails at t=0, failing-since=0
  nowMs = 25 * 60 * 60 * 1000;
  await runBackup("cycle", deps); // still failing at 25h -> alerts
  assert.equal(alerts.length, 1);

  shouldFail = false;
  nowMs += 1000;
  const recovered = await runBackup("cycle", deps);
  assert.equal(recovered.ok, true, "recovers");

  shouldFail = true;
  nowMs += 25 * 60 * 60 * 1000; // a fresh 25h failure window after recovery
  await runBackup("cycle", deps);
  assert.equal(alerts.length, 1, "the fresh failure hasn't been failing for 24h yet (streak was reset by the recovery)");
});

test("runBackup: retention prunes both sqlite and db.json files for pruned stamps", async () => {
  const dirFiles: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const stamp = `2026-01-${String(i).padStart(2, "0")}T00-00-00-000Z`;
    dirFiles.push(sqliteBackupFilename(stamp), dbJsonBackupFilename(stamp));
  }
  const { deps } = makeFakeDeps({
    now: () => new Date("2026-01-16T00:00:00.000Z").getTime(),
    listBackupsDir: () => dirFiles.slice(),
    backupSqliteTo: (filename) => {
      dirFiles.push(filename);
    },
    copyDbJsonTo: (filename) => {
      dirFiles.push(filename);
    },
    deleteBackupFile: (filename) => {
      const idx = dirFiles.indexOf(filename);
      if (idx >= 0) dirFiles.splice(idx, 1);
    },
  });
  await runBackup("cycle", deps);
  // 15 pre-existing + 1 new = 16 sets; retain 14 -> the 2 oldest sets pruned.
  const remainingSqlite = dirFiles.filter((f) => f.endsWith(".sqlite"));
  const remainingJson = dirFiles.filter((f) => f.endsWith(".json"));
  assert.equal(remainingSqlite.length, 14, JSON.stringify(remainingSqlite));
  assert.equal(remainingJson.length, 14, JSON.stringify(remainingJson));
  assert.ok(!dirFiles.some((f) => f.includes("2026-01-01T")), "oldest stamp pruned");
  assert.ok(!dirFiles.some((f) => f.includes("2026-01-02T")), "2nd oldest stamp pruned");
});

test("runBackup: a db.json copy failure does not fail the whole backup (interim scope, sqlite is primary)", async () => {
  const { deps, log, state } = makeFakeDeps({
    copyDbJsonTo: () => {
      throw new Error("db.json missing");
    },
  });
  const result = await runBackup("boot", deps);
  assert.equal(result.ok, true, "sqlite backup still counts as success");
  assert.ok(log.some((m) => /db\.json/.test(m)));
  assert.equal(state.get(BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY), "1000000");
});
