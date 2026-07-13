// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// db.json operational state moved into SQLite (src/server/appStore.ts). The
// old atomic-JSON writer (writeDB) is gone -- this test greps the source
// (not the built output) to assert it stays gone: no `writeDB(` call site,
// and no direct db.json write path (fs.writeFileSync/fs.renameSync against
// DB_PATH), anywhere in server.ts or src/server. db.json itself is still
// read once, at boot, by the one-time migration (src/server/appStore.ts's
// migrateDbJsonIfNeeded) -- that's a READ, not a write, and is exempted
// below by name.
//
// M1 hardening (Phase 2 final review): the file scan is now RECURSIVE over
// the whole src/ tree (not just the flat src/server directory -- a write
// vector added under src/components or src/services, or a future nested
// src/server subdirectory, used to be invisible to this test entirely), and
// the write-API surface checked is broadened past writeFileSync/renameSync
// to cover every other write-capable fs API a future contributor could
// plausibly reach for (fs.promises.writeFile, appendFileSync/appendFile,
// createWriteStream). Deliberately still cheap: a small set of regexes over
// raw file contents, no AST parsing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function listSourceFiles(): string[] {
  const files: string[] = [path.join(REPO_ROOT, "server.ts")];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return files;
}

test("no writeDB( call sites remain anywhere under src/ or server.ts", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const contents = fs.readFileSync(file, "utf8");
    if (/\bwriteDB\s*\(/.test(contents)) offenders.push(file);
    // The function itself must be gone too, not just its call sites.
    if (/function\s+writeDB\s*\(/.test(contents)) offenders.push(`${file} (function definition)`);
  }
  assert.deepEqual(offenders, [], `writeDB( must not appear anywhere; found in: ${offenders.join(", ")}`);
});

test("no direct db.json WRITE path (the old atomic temp-rename sequence) remains anywhere under src/ or server.ts", () => {
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

// M1: the broadened write-API surface. Each entry is matched as
// `<api>(\s*<target>` -- the exact same "first-argument" shape the two tests
// above already use for writeFileSync/renameSync -- against three possible
// targets: the DB_PATH/tempPath identifiers server.ts's old atomic writer
// used, or a literal "db.json"/'db.json' string (a future write path that
// re-derives the path inline rather than through those constants). This
// deliberately does NOT match a bare `dbJsonPath` PARAMETER name --
// appStore.ts's one-time migration legitimately derives a sibling
// `${dbJsonPath}.MIGRATED` marker FILENAME from it via fs.writeFileSync (a
// different file, never db.json itself); matching that identifier would be a
// false positive against intentional, already-reviewed behavior.
const BROADENED_WRITE_APIS = [
  "fs.writeFileSync",
  "fs.promises.writeFile",
  "fs.appendFileSync",
  "fs.appendFile",
  "fs.createWriteStream",
];
const DB_JSON_TARGET = String.raw`\s*(?:DB_PATH\b|tempPath\b|["']db\.json["'])`;

test("no write call (writeFileSync/appendFileSync/createWriteStream/fs.promises.writeFile/...) targets db.json/DB_PATH/tempPath anywhere under src/ or server.ts", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const contents = fs.readFileSync(file, "utf8");
    for (const api of BROADENED_WRITE_APIS) {
      const escaped = api.replace(/\./g, "\\.");
      const pattern = new RegExp(`${escaped}\\(${DB_JSON_TARGET}`);
      if (pattern.test(contents)) offenders.push(`${file} (${api}(...) targeting db.json/DB_PATH/tempPath)`);
    }
  }
  assert.deepEqual(offenders, [], `a write call appears to target db.json directly; found: ${offenders.join(", ")}`);
});
