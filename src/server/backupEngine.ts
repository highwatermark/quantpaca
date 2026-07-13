// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backups. Same
// design as heartbeat.ts / scheduler.ts -- pure decision logic + a fully
// dependency-injected orchestration function (`runBackup`), fs/SQLite I/O
// owned by server.ts (see the `BackupDeps` it constructs). This keeps the
// retention/alert-throttle math unit-testable without a real filesystem, and
// keeps the module itself free of node:fs/node:sqlite imports.
//
// Binding constraints from the task brief: backups NEVER block or crash a
// trading cycle (every I/O call below is wrapped so a throw anywhere becomes
// a logged+audited failure, never a rethrow) and db.json (interim scope --
// see the next task for consolidating it into SQLite) rides along as a
// best-effort file copy alongside each backup run, not a hard dependency of
// success.

// ~half a day at the default 15-minute scheduler interval (48 * 15min = 12h).
export const BACKUP_EVERY_N_CYCLES = 48;

// Keep the newest 14 backup sets (sqlite + db.json pair), delete older ones.
export const BACKUP_RETENTION_COUNT = 14;

// Alert (throttled -- once per continuous failure streak) once backups have
// been failing for more than this long.
export const BACKUP_FAILURE_ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// app_state (persistence.ts) keys. No schema migration needed -- same
// convention as every other app_state key in this codebase.
export const BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY = "backup_last_success_at_ms";
// Set to the ms timestamp of the FIRST failure in an ongoing failure streak;
// cleared (empty string) on the next success. isBackupFailureOverdue reads
// "how long has THIS streak been going" from it.
export const BACKUP_FAILING_SINCE_APP_STATE_KEY = "backup_failing_since_ms";
// The failing-since stamp that was last actually alerted on (delivery-gated,
// same "only a DELIVERED alert advances the stamp" rule as heartbeat.ts's
// watchdog) -- lets a still-ongoing streak stay silent after the first alert,
// while a NEW streak (a different failing-since value) alerts again.
export const BACKUP_ALERTED_FAILING_SINCE_APP_STATE_KEY = "backup_alerted_failing_since_ms";

/**
 * True on every Nth completed scheduled cycle (48, 96, ...), never on cycle 0.
 * Reuses the SAME completed-cycle counter as heartbeat.ts's
 * shouldSendHeartbeat (scheduler_completed_cycle_count) -- one counter, two
 * independent cadences.
 */
export function shouldRunScheduledBackup(completedCycleCount: number, everyNCycles: number = BACKUP_EVERY_N_CYCLES): boolean {
  return completedCycleCount > 0 && completedCycleCount % everyNCycles === 0;
}

/** Filesystem-safe stamp derived from an ISO timestamp (colons/dots -> dashes). */
export function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sqliteBackupFilename(stamp: string): string {
  return `quantpaca-${stamp}.sqlite`;
}

export function dbJsonBackupFilename(stamp: string): string {
  return `db-${stamp}.json`;
}

const SQLITE_BACKUP_FILENAME_RE = /^quantpaca-(.+)\.sqlite$/;

/** Pulls backup stamps out of a directory listing, ascending (oldest first). */
export function extractBackupStamps(filenames: string[]): string[] {
  return filenames
    .map((f) => f.match(SQLITE_BACKUP_FILENAME_RE)?.[1])
    .filter((s): s is string => Boolean(s))
    .sort();
}

/** Given all known stamps, which ones (oldest first) exceed the retention count. */
export function selectStampsToDelete(stamps: string[], retentionCount: number = BACKUP_RETENTION_COUNT): string[] {
  const sorted = [...stamps].sort();
  const excess = sorted.length - retentionCount;
  return excess > 0 ? sorted.slice(0, excess) : [];
}

export function isBackupFailureOverdue(
  failingSinceMs: number | undefined,
  nowMs: number,
  thresholdMs: number = BACKUP_FAILURE_ALERT_THRESHOLD_MS,
): boolean {
  if (failingSinceMs === undefined || !Number.isFinite(failingSinceMs)) return false;
  return nowMs - failingSinceMs > thresholdMs;
}

/** Alert once per continuous failure streak (identified by its failing-since stamp). */
export function shouldAlertBackupFailure(
  failingSinceMs: number | undefined,
  nowMs: number,
  alreadyAlertedFailingSinceMs: number | undefined,
  thresholdMs: number = BACKUP_FAILURE_ALERT_THRESHOLD_MS,
): boolean {
  if (!isBackupFailureOverdue(failingSinceMs, nowMs, thresholdMs)) return false;
  return alreadyAlertedFailingSinceMs !== failingSinceMs;
}

// Injected I/O -- server.ts supplies the real fs/productionStore-backed
// implementations; tests supply fakes. Every method here is expected to
// THROW on failure (runBackup is what turns a throw into a logged/audited,
// never-rethrown failure) except deleteBackupFile (best-effort pruning: a
// failed delete is logged inline and does not fail the whole run) and
// sendAlert (never throws -- resolves to whether delivery succeeded, same
// contract as server.ts's sendTelegramAlert).
export type BackupDeps = {
  now: () => number;
  ensureBackupsDir: () => void;
  backupSqliteTo: (filename: string) => void;
  dbJsonExists: () => boolean;
  copyDbJsonTo: (filename: string) => void;
  listBackupsDir: () => string[];
  deleteBackupFile: (filename: string) => void;
  getAppState: (key: string) => string | undefined;
  setAppState: (key: string, value: string) => void;
  appendAuditEvent: (message: string, details?: Record<string, unknown>) => void;
  sendAlert: (message: string) => Promise<boolean>;
  log: (message: string) => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readAppStateMs(deps: BackupDeps, key: string): number | undefined {
  try {
    const raw = deps.getAppState(key);
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pruneOldBackups(deps: BackupDeps): void {
  let stamps: string[];
  try {
    stamps = extractBackupStamps(deps.listBackupsDir());
  } catch (err) {
    deps.log(`[backup] Failed to list the backups directory for retention pruning: ${errorMessage(err)}`);
    return;
  }
  const toDelete = selectStampsToDelete(stamps);
  for (const stamp of toDelete) {
    for (const filename of [sqliteBackupFilename(stamp), dbJsonBackupFilename(stamp)]) {
      try {
        deps.deleteBackupFile(filename);
      } catch (err) {
        deps.log(`[backup] Failed to prune old backup file ${filename}: ${errorMessage(err)}`);
      }
    }
  }
  if (toDelete.length > 0) {
    deps.log(`[backup] Pruned ${toDelete.length} backup set(s) beyond the retention count (${BACKUP_RETENTION_COUNT}): ${toDelete.join(", ")}`);
  }
}

async function handleFailure(nowMs: number, reason: "boot" | "cycle", err: unknown, deps: BackupDeps): Promise<void> {
  const message = `[backup] ${reason} backup FAILED (never blocks the cycle): ${errorMessage(err)}`;
  deps.log(message);
  try {
    deps.appendAuditEvent(message, { reason });
  } catch (auditErr) {
    deps.log(`[backup] Also failed to write the failure audit event: ${errorMessage(auditErr)}`);
  }

  let failingSince = readAppStateMs(deps, BACKUP_FAILING_SINCE_APP_STATE_KEY);
  if (failingSince === undefined) {
    failingSince = nowMs;
    try {
      deps.setAppState(BACKUP_FAILING_SINCE_APP_STATE_KEY, String(failingSince));
    } catch (stateErr) {
      deps.log(`[backup] Failed to persist the failing-since stamp: ${errorMessage(stateErr)}`);
    }
  }

  try {
    const alreadyAlertedSince = readAppStateMs(deps, BACKUP_ALERTED_FAILING_SINCE_APP_STATE_KEY);
    if (shouldAlertBackupFailure(failingSince, nowMs, alreadyAlertedSince)) {
      const delivered = await deps.sendAlert(
        `⚠️ <b>SQLite backups have been failing for over 24h.</b> Failing since ${new Date(failingSince).toISOString()}. Investigate disk space/permissions under data/backups.`,
      );
      if (delivered) {
        deps.setAppState(BACKUP_ALERTED_FAILING_SINCE_APP_STATE_KEY, String(failingSince));
      }
    }
  } catch (alertErr) {
    // Never let a broken alert channel escalate a backup failure into a
    // crashed cycle -- log and move on, same fail-quiet direction as every
    // other alert path in this codebase.
    deps.log(`[backup] Failed to evaluate/send the backup-failure alert: ${errorMessage(alertErr)}`);
  }
}

/**
 * Runs one backup attempt end-to-end: VACUUM INTO a fresh SQLite snapshot,
 * best-effort copy db.json alongside it (interim scope -- see the module doc
 * comment), prune beyond retention, and stamp success/failure state. NEVER
 * throws -- `reason` is "boot" (once, post-startup-reconciliation) or "cycle"
 * (every BACKUP_EVERY_N_CYCLES-th completed scheduled cycle); both call
 * sites in server.ts can safely `await` this without a try/catch of their
 * own.
 */
export async function runBackup(reason: "boot" | "cycle", deps: BackupDeps): Promise<{ ok: boolean }> {
  const nowMs = deps.now();
  try {
    deps.ensureBackupsDir();
    const stamp = backupStamp(new Date(nowMs));
    deps.backupSqliteTo(sqliteBackupFilename(stamp));

    if (deps.dbJsonExists()) {
      try {
        deps.copyDbJsonTo(dbJsonBackupFilename(stamp));
      } catch (err) {
        // Interim scope (per the task brief): db.json is not yet a hard
        // dependency of "the backup succeeded" -- the SQLite snapshot is the
        // primary artifact. Log so the gap is visible, but do not fail the run.
        deps.log(`[backup] db.json copy failed (the sqlite backup itself still succeeded): ${errorMessage(err)}`);
      }
    }

    pruneOldBackups(deps);

    deps.setAppState(BACKUP_LAST_SUCCESS_AT_APP_STATE_KEY, String(nowMs));
    deps.setAppState(BACKUP_FAILING_SINCE_APP_STATE_KEY, "");
    deps.log(`[backup] ${reason} backup succeeded: ${sqliteBackupFilename(stamp)}`);
    return { ok: true };
  } catch (err) {
    await handleFailure(nowMs, reason, err, deps);
    return { ok: false };
  }
}
