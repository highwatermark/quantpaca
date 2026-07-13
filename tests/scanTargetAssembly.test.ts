import test from "node:test";
import assert from "node:assert/strict";
import { assembleScanTargets, EmailScanTarget } from "../src/server/scanTargetAssembly";

// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4, signal-source registry):
// EmailScanTarget now carries the registry-stamped `source` id (e.g.
// "ziptrader" instead of a generic "email"), plus the additive `trustTier`/
// `maxAgeHours` fields threaded through from the source's registry entry.
// `kind` is the discriminant that replaces the old literal-typed `source`
// field for telling an email target apart from the (unchanged) YouTube
// target.
function emailTarget(overrides: Partial<EmailScanTarget> = {}): EmailScanTarget {
  return {
    kind: "email",
    source: "ziptrader",
    title: "Real ZipTrader Newsletter",
    content: "Real newsletter body.",
    sourceTimestamp: "2026-07-12T13:00:00.000Z",
    trustTier: "high",
    maxAgeHours: 72,
    ...overrides,
  };
}

test("both sources failing yields zero scan-targets -- no fabricated fallback content", () => {
  const targets = assembleScanTargets([], { ok: false, reason: "Claude web search failed." });
  assert.deepEqual(targets, []);
});

test("a failed YouTube sentiment call never contributes a scan-target, even with real emails present", () => {
  const email = emailTarget();
  const targets = assembleScanTargets([email], { ok: false, reason: "no ANTHROPIC_API_KEY configured" });
  assert.deepEqual(targets, [email]);
});

test("a successful YouTube sentiment call contributes exactly one youtube target with the real sentiment text", () => {
  const targets = assembleScanTargets([], { ok: true, sentiment: "Real web-search derived sentiment." }, () => "2026-07-12T14:00:00.000Z");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, "youtube");
  assert.equal(targets[0].source, "youtube");
  assert.equal(targets[0].content, "Real web-search derived sentiment.");
  assert.equal(targets[0].sourceTimestamp, "2026-07-12T14:00:00.000Z");
});

test("real emails plus successful YouTube sentiment combine, with no fabricated content mixed in", () => {
  const email = emailTarget();
  const targets = assembleScanTargets([email], { ok: true, sentiment: "Real sentiment." }, () => "2026-07-12T14:00:00.000Z");
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], email);
  assert.equal(targets[1].kind, "youtube");
  assert.equal(targets[1].content, "Real sentiment.");
});

test("multiple email scan-targets keep their own distinct registry source ids", () => {
  const zip = emailTarget({ source: "ziptrader", title: "ZipTrader thesis" });
  const fool = emailTarget({ source: "motleyfool", title: "Motley Fool thesis", trustTier: "medium", maxAgeHours: 48 });
  const targets = assembleScanTargets([zip, fool], { ok: false, reason: "no content" });
  assert.equal(targets.length, 2);
  assert.equal(targets[0].source, "ziptrader");
  assert.equal(targets[1].source, "motleyfool");
});
