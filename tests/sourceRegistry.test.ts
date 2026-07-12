import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSourceRegistry, MAX_ENABLED_SOURCES_PER_CYCLE, GMAIL_MAX_RESULTS_PER_SOURCE } from "../src/server/sourceRegistry";

// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4): the signal-source registry
// module. Pure filesystem/JSON tests -- no Gmail/server wiring here (see
// tests/signalSourceRegistryIngestion.test.ts for the full end-to-end path).

function tmpRegistryPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-source-registry-"));
  return path.join(dir, "signal-sources.json");
}

test("Guardrail 8 constants: maxResults is 5 and the enabled-source cap is 8", () => {
  assert.equal(GMAIL_MAX_RESULTS_PER_SOURCE, 5);
  assert.equal(MAX_ENABLED_SOURCES_PER_CYCLE, 8);
});

test("first boot: an absent registry file is created with the default ZipTrader source (enabled) and the default Motley Fool source (disabled)", () => {
  const filePath = tmpRegistryPath();
  assert.equal(fs.existsSync(filePath), false);

  const result = loadSourceRegistry(filePath);

  assert.equal(result.createdDefaultFile, true);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.migratedIds, [], "the createDefaultFile path ships every known default already -- nothing to migrate");
  // Only the enabled ZipTrader source surfaces as an in-cycle source --
  // Motley Fool ships disabled by default (Phase 2 Task 9: a human reviews
  // and opts in via the file, no code change).
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0], {
    id: "ziptrader",
    gmailQuery: "from:charlie-from-ziptrader@ghost.io",
    senderAllowlist: ["charlie-from-ziptrader@ghost.io"],
    trustTier: "high",
    maxAgeHours: 72,
    enabled: true,
  });

  // Migration-safe: the file is actually written to disk, not just returned
  // in-memory, so the next process boot / cycle reads the same config back.
  assert.equal(fs.existsSync(filePath), true);
  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk[0].id, "ziptrader");
  const foolOnDisk = onDisk.find((s: any) => s.id === "motley-fool");
  assert.ok(foolOnDisk, "expected the default file to ship a motley-fool entry");
  assert.equal(foolOnDisk.enabled, false, "motley-fool ships disabled by default");
  assert.equal(foolOnDisk.gmailQuery, "from:fool@motley.fool.com");
  assert.deepEqual(foolOnDisk.senderAllowlist, ["fool@motley.fool.com"]);
  assert.equal(foolOnDisk.trustTier, "high");
  assert.equal(foolOnDisk.maxAgeHours, 96);
  assert.equal(typeof foolOnDisk.promptHint, "string");
  assert.match(foolOnDisk.promptHint, /Hidden Gems/);
  assert.match(foolOnDisk.promptHint, /PRIMARY recommendation/);
});

test("a second load against an already-created default file does not recreate it or report createdDefaultFile", () => {
  const filePath = tmpRegistryPath();
  loadSourceRegistry(filePath);
  const mtimeAfterFirstLoad = fs.statSync(filePath).mtimeMs;

  const second = loadSourceRegistry(filePath);

  assert.equal(second.createdDefaultFile, false);
  assert.equal(second.sources.length, 1);
  assert.equal(fs.statSync(filePath).mtimeMs, mtimeAfterFirstLoad);
});

test("malformed file (invalid JSON) disables ALL sources, fails closed, and reports a file-level issue", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ this is not valid json");

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.sources, []);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].scope, "file");
  assert.match(result.issues[0].message, /json/i);
});

test("malformed file (valid JSON but not an array) disables ALL sources and reports a file-level issue", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ not: "an array" }));

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.sources, []);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].scope, "file");
});

test("a malformed entry is disabled while other valid entries in the same file stay live", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { id: "good-source", gmailQuery: "from:good@example.com", senderAllowlist: ["good@example.com"], trustTier: "medium", maxAgeHours: 48, enabled: true },
      // Missing gmailQuery entirely.
      { id: "bad-source", senderAllowlist: ["bad@example.com"], trustTier: "medium", maxAgeHours: 48, enabled: true },
    ]),
  );

  const result = loadSourceRegistry(filePath);

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "good-source");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].scope, "entry");
  assert.equal(result.issues[0].id, "bad-source");
});

test("an entry with enabled: false is silently excluded -- not an issue, not malformed", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { id: "off-source", gmailQuery: "from:off@example.com", senderAllowlist: ["off@example.com"], trustTier: "low", maxAgeHours: 24, enabled: false },
    ]),
  );

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.issues, []);
});

test("each required field is individually validated: bad trustTier, non-positive maxAgeHours, empty allowlist, non-boolean enabled all disable the entry", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { id: "bad-tier", gmailQuery: "from:a@example.com", senderAllowlist: ["a@example.com"], trustTier: "extreme", maxAgeHours: 24, enabled: true },
      { id: "bad-age", gmailQuery: "from:b@example.com", senderAllowlist: ["b@example.com"], trustTier: "low", maxAgeHours: 0, enabled: true },
      { id: "empty-allowlist", gmailQuery: "from:c@example.com", senderAllowlist: [], trustTier: "low", maxAgeHours: 24, enabled: true },
      { id: "bad-enabled", gmailQuery: "from:d@example.com", senderAllowlist: ["d@example.com"], trustTier: "low", maxAgeHours: 24, enabled: "yes" },
    ]),
  );

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.sources, []);
  assert.equal(result.issues.length, 4);
  const ids = result.issues.map((i) => i.id).sort();
  assert.deepEqual(ids, ["bad-age", "bad-enabled", "bad-tier", "empty-allowlist"]);
});

test("9 enabled sources are capped at 8 processed this cycle; the 9th is reported as capped, not as an issue", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entries = Array.from({ length: 9 }, (_, i) => ({
    id: `source-${i}`,
    gmailQuery: `from:source${i}@example.com`,
    senderAllowlist: [`source${i}@example.com`],
    trustTier: "medium",
    maxAgeHours: 48,
    enabled: true,
  }));
  fs.writeFileSync(filePath, JSON.stringify(entries));

  const result = loadSourceRegistry(filePath);

  assert.equal(result.sources.length, 8);
  assert.equal(result.issues.length, 0, "capping is not a malformed-config issue");
  assert.equal(result.cappedIds.length, 1);
  assert.equal(result.cappedIds[0], "source-8");
});

test("registry is read fresh -- a second load after the file is edited on disk reflects the new content", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([{ id: "v1", gmailQuery: "from:v1@example.com", senderAllowlist: ["v1@example.com"], trustTier: "low", maxAgeHours: 24, enabled: true }]),
  );
  const first = loadSourceRegistry(filePath);
  assert.equal(first.sources[0].id, "v1");

  fs.writeFileSync(
    filePath,
    JSON.stringify([{ id: "v2", gmailQuery: "from:v2@example.com", senderAllowlist: ["v2@example.com"], trustTier: "low", maxAgeHours: 24, enabled: true }]),
  );
  const second = loadSourceRegistry(filePath);
  assert.equal(second.sources[0].id, "v2");
});

// Phase 2 Task 9 (docs/GO_LIVE_PLAN.md Phase 2.4, Motley Fool premium source):
// the additive `promptHint` field and the general (not Fool-specific)
// registry migration that appends a missing known default source, disabled,
// to an existing file. End-to-end Fool ingestion/prompt/SELL-mapping behavior
// lives in tests/motleyFoolSource.test.ts; this file stays pure filesystem/
// JSON, matching the rest of this suite.

test("promptHint is optional -- an entry without it validates fine and the normalized source omits the key entirely", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([{ id: "no-hint", gmailQuery: "from:a@example.com", senderAllowlist: ["a@example.com"], trustTier: "low", maxAgeHours: 24, enabled: true }]),
  );

  const result = loadSourceRegistry(filePath);

  assert.equal(result.issues.length, 0);
  assert.equal(result.sources.length, 1);
  assert.equal("promptHint" in result.sources[0], false);
});

test("promptHint, when present, is validated as a string and carried through onto the normalized source", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      {
        id: "with-hint",
        gmailQuery: "from:b@example.com",
        senderAllowlist: ["b@example.com"],
        trustTier: "low",
        maxAgeHours: 24,
        enabled: true,
        promptHint: "Focus on the headline ticker only.",
      },
    ]),
  );

  const result = loadSourceRegistry(filePath);

  assert.equal(result.issues.length, 0);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].promptHint, "Focus on the headline ticker only.");
});

test("an invalid promptHint type (non-string) disables the entry, fail-closed -- other entries stay live", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { id: "good-source", gmailQuery: "from:good@example.com", senderAllowlist: ["good@example.com"], trustTier: "medium", maxAgeHours: 48, enabled: true },
      { id: "bad-hint", gmailQuery: "from:c@example.com", senderAllowlist: ["c@example.com"], trustTier: "low", maxAgeHours: 24, enabled: true, promptHint: 12345 },
    ]),
  );

  const result = loadSourceRegistry(filePath);

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "good-source");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].id, "bad-hint");
  assert.match(result.issues[0].message, /promptHint/i);
});

test("registry migration: an existing file without motley-fool gets it appended, disabled, on load, and reports the migrated id", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { id: "ziptrader", gmailQuery: "from:charlie-from-ziptrader@ghost.io", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
    ]),
  );

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.migratedIds, ["motley-fool"]);
  assert.equal(result.sources.length, 1, "the migrated entry is appended DISABLED, so it does not join this cycle's sources");
  assert.equal(result.sources[0].id, "ziptrader");
  assert.equal(result.issues.length, 0, "a migration is not a malformed-config issue");

  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.equal(onDisk.length, 2);
  const foolOnDisk = onDisk.find((s: any) => s.id === "motley-fool");
  assert.ok(foolOnDisk, "expected motley-fool to have been appended to the file on disk");
  assert.equal(foolOnDisk.enabled, false);
});

test("registry migration: a second load after the migration writes the file does not re-migrate or rewrite it", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { id: "ziptrader", gmailQuery: "from:charlie-from-ziptrader@ghost.io", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
    ]),
  );
  const first = loadSourceRegistry(filePath);
  assert.deepEqual(first.migratedIds, ["motley-fool"]);
  const mtimeAfterMigration = fs.statSync(filePath).mtimeMs;

  const second = loadSourceRegistry(filePath);

  assert.deepEqual(second.migratedIds, []);
  assert.equal(fs.statSync(filePath).mtimeMs, mtimeAfterMigration);
});

test("registry migration: an existing file that already has a user-modified motley-fool entry is left completely untouched", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const customEntries = [
    { id: "ziptrader", gmailQuery: "from:charlie-from-ziptrader@ghost.io", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
    { id: "motley-fool", gmailQuery: "from:fool@motley.fool.com", senderAllowlist: ["fool@motley.fool.com"], trustTier: "high", maxAgeHours: 48, enabled: true },
  ];
  fs.writeFileSync(filePath, JSON.stringify(customEntries));
  const mtimeBefore = fs.statSync(filePath).mtimeMs;

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.migratedIds, []);
  assert.equal(fs.statSync(filePath).mtimeMs, mtimeBefore, "an already-present id must never trigger a rewrite");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf-8")), customEntries);
  assert.equal(result.sources.length, 2);
  const fool = result.sources.find((s) => s.id === "motley-fool");
  assert.ok(fool);
  assert.equal(fool!.maxAgeHours, 48, "the user's own override must be preserved, not overwritten by the shipped default (96)");
});

test("registry migration: a malformed file never triggers migration -- it stays a file-level failure", () => {
  const filePath = tmpRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ this is not valid json");

  const result = loadSourceRegistry(filePath);

  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.migratedIds, []);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].scope, "file");
});
