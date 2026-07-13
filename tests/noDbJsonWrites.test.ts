// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// db.json operational state moved into SQLite (src/server/appStore.ts). The
// old atomic-JSON writer (writeDB) is gone -- this test greps the source
// (not the built output) to assert it stays gone: no `writeDB(` call site,
// and no direct db.json write path (fs.writeFileSync/fs.renameSync against
// DB_PATH), anywhere in server.ts or src/server. db.json itself is still
// read once, at boot, by the one-time migration (src/server/appStore.ts's
// migrateDbJsonIfNeeded) -- that's a READ, not a write, and is exempted
// below by name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function listSourceFiles(): string[] {
  const files: string[] = [path.join(REPO_ROOT, "server.ts")];
  const serverDir = path.join(REPO_ROOT, "src", "server");
  for (const entry of fs.readdirSync(serverDir)) {
    if (entry.endsWith(".ts")) files.push(path.join(serverDir, entry));
  }
  return files;
}

test("no writeDB( call sites remain in server.ts or src/server", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const contents = fs.readFileSync(file, "utf8");
    if (/\bwriteDB\s*\(/.test(contents)) offenders.push(file);
    // The function itself must be gone too, not just its call sites.
    if (/function\s+writeDB\s*\(/.test(contents)) offenders.push(`${file} (function definition)`);
  }
  assert.deepEqual(offenders, [], `writeDB( must not appear anywhere; found in: ${offenders.join(", ")}`);
});

test("no direct db.json WRITE path (the old atomic temp-rename sequence) remains anywhere", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const contents = fs.readFileSync(file, "utf8");
    // The old writeDB() sequence: write a `<path>.tmp` file, then
    // fs.renameSync it onto DB_PATH. copyFileSync(DB_PATH, ...) (backupEngine's
    // read-only backup copy) and fs.readFileSync(dbJsonPath, ...) (the
    // migration's one-time read) are both fine and deliberately not matched
    // here -- only a write/rename TARGETING db.json counts.
    if (/fs\.writeFileSync\(\s*tempPath/.test(contents)) offenders.push(`${file} (writeFileSync(tempPath, ...))`);
    if (/fs\.renameSync\(\s*tempPath\s*,\s*DB_PATH\s*\)/.test(contents)) offenders.push(`${file} (renameSync(tempPath, DB_PATH))`);
    if (/fs\.writeFileSync\(\s*DB_PATH\b/.test(contents)) offenders.push(`${file} (writeFileSync(DB_PATH, ...))`);
  }
  assert.deepEqual(offenders, [], `a direct db.json write path remains in: ${offenders.join(", ")}`);
});
