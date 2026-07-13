// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4): the per-source signal
// registry. Extends Gmail ingestion from a single hardcoded ZipTrader query
// (the pre-Task-8 behavior in server.ts) to a config-driven list of sources
// -- each declaring its own Gmail query, sender allowlist, trust tier, and
// freshness window. Config is DATA (a JSON file), not code and not an env
// var, so an operator can add Motley Fool / Burry-style sources (the next two
// tasks) without a deploy.
//
// Fail-closed validation, per the plan's standing rule ("never a partial
// guess"): a malformed FILE disables every source; a malformed ENTRY disables
// only that entry, leaving the rest of the file live. Both are reported back
// via `issues` so the caller (server.ts) can log them and fire a (throttled)
// Telegram alert -- this module itself has no logging/alerting side effects,
// it only decides and reports.
//
// The registry is read fresh on every call (no in-memory caching here) so an
// operator's edit to the file takes effect on the very next sync cycle,
// without a restart.

import fs from "node:fs";
import path from "node:path";
import { TrustTier } from "./domainTypes";
import { parseFiniteNumber } from "./numericSafety";

export type SourceConfig = {
  id: string;
  gmailQuery: string;
  senderAllowlist: string[];
  trustTier: TrustTier;
  maxAgeHours: number;
  enabled: boolean;
  // Phase 2 Task 9 (docs/GO_LIVE_PLAN.md Phase 2.4, Motley Fool premium
  // source): optional, additive. Threaded into the Claude analysis prompt
  // when present (server.ts) so a source whose genre differs from the
  // ZipTrader-flavored default prompt (e.g. an explicit dated BUY/SELL
  // recommendation letter, vs. a whipsaw-framed newsletter) can steer
  // extraction without a source-specific code path. Absent for every
  // pre-Task-9 source (e.g. ziptrader) -- prompt behavior for those is
  // byte-for-byte unchanged.
  promptHint?: string;
};

// Guardrail 8 (docs/GO_LIVE_PLAN.md Phase 2.1): bounds both per-source and
// aggregate Gmail ingestion volume, independent of how many sources an
// operator lists in the registry file. GMAIL_MAX_RESULTS_PER_SOURCE replaces
// the inline `maxResults=5` literal the pre-Task-8 single-source query used;
// MAX_ENABLED_SOURCES_PER_CYCLE is new -- it caps how many registry entries a
// single sync cycle will ever iterate over (and therefore how many Claude
// calls email ingestion alone can trigger).
export const GMAIL_MAX_RESULTS_PER_SOURCE = 5;
export const MAX_ENABLED_SOURCES_PER_CYCLE = 8;

// Phase 2 Task 9's Motley Fool prompt hint, verbatim from the go-live plan's
// task brief. Exported so callers/tests can reference the exact text instead
// of duplicating it.
export const MOTLEY_FOOL_PROMPT_HINT =
  "This is a Motley Fool premium recommendation newsletter. Extract the PRIMARY recommendation: the specific ticker being recommended as a new BUY, or an explicit SELL instruction. Service names (Epic Portfolio, Hidden Gems, Rule Breakers) indicate recommendation letters; ignore performance recaps and marketing copy. Multiple tickers: choose the headline recommendation only.";

// Phase 2 Task 10's Michael Burry prompt hint, verbatim from the go-live
// plan's task brief. Exported so callers/tests can reference the exact text
// instead of duplicating it.
export const MICHAEL_BURRY_PROMPT_HINT =
  "This is Michael Burry's investment newsletter. Trading Post issues contain explicit position buys/adds; Short Thoughts issues contain bearish/short theses. Extract the primary ticker and stance. A bearish or short thesis is decision SELL with direction 'bearish' — this system never opens shorts; bearish means exit or avoid. A buy/add is decision BUY.";

// The default registry, shipped so a fresh deploy (or an upgrade from the
// pre-Task-8 hardcoded single source) keeps working with zero operator
// action. `_comment` is not part of SourceConfig -- it's tolerated by
// validateEntry (which only reads known keys) purely as an in-file note for
// a human reading the JSON; it never affects behavior.
const DEFAULT_SOURCES: (SourceConfig & { _comment?: string })[] = [
  {
    id: "ziptrader",
    gmailQuery: "from:charlie-from-ziptrader@ghost.io",
    senderAllowlist: ["charlie-from-ziptrader@ghost.io"],
    trustTier: "high",
    // Matches signalEngine.ts's prior hardcoded default.
    maxAgeHours: 72,
    enabled: true,
  },
  {
    // Phase 2 Task 9 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 1): shipped
    // DISABLED -- Motley Fool is a paid-membership source and the plan calls
    // for a human to review recommendation emails against the promptHint
    // before flipping it on. Data-driven enable: flip `enabled` to `true` in
    // this file, no code change or deploy needed.
    id: "motley-fool",
    gmailQuery: "from:fool@motley.fool.com",
    senderAllowlist: ["fool@motley.fool.com"],
    trustTier: "high",
    // Recommendation letters are weekly-cadence; 96h catches a weekend gap.
    maxAgeHours: 96,
    enabled: false,
    promptHint: MOTLEY_FOOL_PROMPT_HINT,
    _comment:
      "Disabled by default. Motley Fool is a paid membership -- review a few recommendation emails against promptHint, then set \"enabled\": true to activate. No code change needed. See docs/GO_LIVE_PLAN.md Phase 2.4.",
  },
  {
    // Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
    // Burry Substack): shipped DISABLED, same review-before-enable pattern as
    // motley-fool above. This source's bearish/short theses map to the
    // long-only bearish-mapping layer (src/server/bearishMapping.ts) via the
    // analysis schema's `stance` field -- a bearish stance on a held symbol
    // marks the thesis invalidated (forces an exit); on an unheld symbol it
    // adds the symbol to the do-not-buy list. This system never opens shorts.
    id: "michael-burry",
    gmailQuery: "from:michaeljburry@substack.com",
    senderAllowlist: ["michaeljburry@substack.com"],
    trustTier: "medium",
    // Substack issues are irregular-cadence; 96h matches motley-fool's
    // weekend-gap allowance.
    maxAgeHours: 96,
    enabled: false,
    promptHint: MICHAEL_BURRY_PROMPT_HINT,
    _comment:
      "Disabled by default. Review a few Trading Post / Short Thoughts emails against promptHint, then set \"enabled\": true to activate. No code change needed. See docs/GO_LIVE_PLAN.md Phase 2.4.",
  },
];

export type SourceRegistryIssue = {
  scope: "file" | "entry";
  // Only present for scope "entry" when the entry at least had a usable id;
  // a file-level issue, or an entry missing even an id, leaves this unset.
  id?: string;
  message: string;
};

export type SourceRegistryLoadResult = {
  // Enabled, validated sources for this cycle, already capped at
  // MAX_ENABLED_SOURCES_PER_CYCLE, in file order.
  sources: SourceConfig[];
  // True only on the call that created the default file (file was absent).
  createdDefaultFile: boolean;
  // Ids of enabled, otherwise-valid sources dropped purely by the 8-source
  // cap -- not a validation failure, so these are NOT included in `issues`.
  cappedIds: string[];
  // Malformed file/entry problems -- fail-closed, always logged and alerted
  // by the caller, never silently guessed around.
  issues: SourceRegistryIssue[];
  // Phase 2 Task 9: ids of known default sources (DEFAULT_SOURCES) that were
  // MISSING from an existing file and were appended, forced disabled, on
  // this load (additive registry migration -- general, not Fool-specific).
  // Always empty on the createDefaultFile path (that path ships every known
  // default already) and empty on a file-level failure (a malformed file is
  // never safely extendable). An id already present in the file for ANY
  // reason -- valid, malformed, enabled, or disabled -- is left completely
  // untouched; migration only ever appends, never edits.
  migratedIds: string[];
};

export function loadSourceRegistry(filePath: string): SourceRegistryLoadResult {
  if (!fs.existsSync(filePath)) {
    return createDefaultFile(filePath);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err: any) {
    return fileLevelFailure(`Could not read the signal source registry file (${filePath}): ${err?.message || String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return fileLevelFailure(`Signal source registry file (${filePath}) is not valid JSON: ${err?.message || String(err)}`);
  }

  if (!Array.isArray(parsed)) {
    return fileLevelFailure(`Signal source registry file (${filePath}) must contain a JSON array of source entries; got ${typeof parsed}.`);
  }

  // Phase 2 Task 9: additive registry migration, general (not Fool-specific).
  // Any DEFAULT_SOURCES id absent from this file's raw entries (regardless of
  // whether those existing entries are themselves valid) is appended, forced
  // DISABLED -- a migration must never silently turn ON a new signal source,
  // only make it visible for a human to review and enable. Reuses the normal
  // validate/cap pipeline below by simply extending `entries` before it runs,
  // rather than special-casing the appended rows.
  const existingIds = new Set<string>();
  for (const entry of parsed as any[]) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.id === "string" && entry.id.trim()) {
      existingIds.add(entry.id.trim());
    }
  }
  const missingDefaults = DEFAULT_SOURCES.filter((d) => !existingIds.has(d.id));
  const migratedIds = missingDefaults.map((d) => d.id);
  let entries: unknown[] = parsed;
  if (missingDefaults.length > 0) {
    const migratedEntries = missingDefaults.map((d) => ({ ...d, senderAllowlist: [...d.senderAllowlist], enabled: false }));
    entries = [...parsed, ...migratedEntries];
    try {
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n");
    } catch {
      // Fail open toward keeping ingestion working, same reasoning as
      // createDefaultFile below: the in-memory `entries` used for THIS load
      // already reflects the migration (disabled, so no ingestion effect
      // either way this cycle), and a failed write simply means the next
      // load retries the same migration -- idempotent, not a fail-closed
      // condition.
    }
  }

  const issues: SourceRegistryIssue[] = [];
  const valid: SourceConfig[] = [];
  entries.forEach((entry, index) => {
    const result = validateEntry(entry, index);
    // Explicit `=== true`/`=== false` (not a truthy `if`): this tsconfig
    // doesn't enable strictNullChecks, and without it TS's discriminated-
    // union narrowing only fires on an explicit literal comparison -- same
    // convention numericSafety.ts's ParsedFiniteNumber callers use throughout.
    if (result.ok === true) {
      if (result.source.enabled) valid.push(result.source);
      // enabled: false is a deliberate, well-formed off switch -- excluded
      // from `sources`, but never reported as an `issue`.
    } else if (result.ok === false) {
      issues.push({ scope: "entry", id: result.id, message: result.message });
    }
  });

  const cappedIds: string[] = [];
  let sources = valid;
  if (valid.length > MAX_ENABLED_SOURCES_PER_CYCLE) {
    sources = valid.slice(0, MAX_ENABLED_SOURCES_PER_CYCLE);
    cappedIds.push(...valid.slice(MAX_ENABLED_SOURCES_PER_CYCLE).map((s) => s.id));
  }

  return { sources, createdDefaultFile: false, cappedIds, issues, migratedIds };
}

function createDefaultFile(filePath: string): SourceRegistryLoadResult {
  let createdDefaultFile = false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_SOURCES, null, 2) + "\n");
    createdDefaultFile = true;
  } catch {
    // Fail closed toward KEEPING INGESTION WORKING, not toward the file: if
    // the default file can't be persisted (e.g. read-only filesystem), a
    // fresh deploy must not silently drop to zero email sources just because
    // it couldn't write a config file it will happily retry writing next
    // cycle. The in-memory default is still returned below either way.
  }
  // Phase 2 Task 9: only ENABLED defaults surface as this cycle's sources --
  // motley-fool ships disabled, so it's written to disk (above) but excluded
  // here, same as any other disabled entry on the normal load path.
  const enabledDefaults = DEFAULT_SOURCES.filter((s) => s.enabled).map((s) => ({ ...s, senderAllowlist: [...s.senderAllowlist] }));
  return { sources: enabledDefaults, createdDefaultFile, cappedIds: [], issues: [], migratedIds: [] };
}

function fileLevelFailure(message: string): SourceRegistryLoadResult {
  return { sources: [], createdDefaultFile: false, cappedIds: [], issues: [{ scope: "file", message }], migratedIds: [] };
}

type EntryValidation = { ok: true; source: SourceConfig } | { ok: false; id?: string; message: string };

function validateEntry(entry: unknown, index: number): EntryValidation {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { ok: false, message: `Source entry at index ${index} is not an object; disabled.` };
  }
  const e = entry as Record<string, unknown>;

  const id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : undefined;
  if (!id) {
    return { ok: false, message: `Source entry at index ${index} is missing a valid non-empty "id"; disabled.` };
  }

  if (typeof e.gmailQuery !== "string" || !e.gmailQuery.trim()) {
    return { ok: false, id, message: `Source "${id}" has an invalid or empty "gmailQuery"; disabled.` };
  }

  if (
    !Array.isArray(e.senderAllowlist) ||
    e.senderAllowlist.length === 0 ||
    !e.senderAllowlist.every((a) => typeof a === "string" && a.trim().length > 0)
  ) {
    return { ok: false, id, message: `Source "${id}" has an invalid or empty "senderAllowlist" (must be a non-empty array of non-empty strings); disabled.` };
  }

  if (e.trustTier !== "high" && e.trustTier !== "medium" && e.trustTier !== "low") {
    return { ok: false, id, message: `Source "${id}" has an invalid "trustTier" (must be "high", "medium", or "low"); disabled.` };
  }

  const maxAgeParsed = parseFiniteNumber(e.maxAgeHours, "maxAgeHours");
  if (maxAgeParsed.ok === false || maxAgeParsed.value <= 0) {
    return { ok: false, id, message: `Source "${id}" has an invalid "maxAgeHours" (must be a finite positive number); disabled.` };
  }

  if (typeof e.enabled !== "boolean") {
    return { ok: false, id, message: `Source "${id}" has an invalid "enabled" (must be a boolean); disabled.` };
  }

  // Phase 2 Task 9: optional, additive. Validated as a string WHEN PRESENT;
  // absent by default (e.g. every pre-Task-9 entry, ziptrader included).
  if (e.promptHint !== undefined && typeof e.promptHint !== "string") {
    return { ok: false, id, message: `Source "${id}" has an invalid "promptHint" (must be a string when present); disabled.` };
  }

  return {
    ok: true,
    source: {
      id,
      gmailQuery: e.gmailQuery.trim(),
      senderAllowlist: (e.senderAllowlist as string[]).map((a) => a.trim()),
      trustTier: e.trustTier,
      maxAgeHours: maxAgeParsed.value,
      enabled: e.enabled,
      // Conditionally spread rather than always setting the key to `undefined`
      // -- keeps the normalized object's own-key shape identical to before
      // Task 9 when promptHint is absent (assert.deepEqual-friendly for
      // existing tests, and no key at all for the ~99% of sources without one).
      ...(typeof e.promptHint === "string" ? { promptHint: e.promptHint } : {}),
    },
  };
}
