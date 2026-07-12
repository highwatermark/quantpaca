import test from "node:test";
import assert from "node:assert/strict";
import { assembleScanTargets } from "../src/server/scanTargetAssembly";
import { EmailScanTarget } from "../src/server/emailIngestion";

test("both sources failing yields zero scan-targets -- no fabricated fallback content", () => {
  const targets = assembleScanTargets([], { ok: false, reason: "Claude web search failed." });
  assert.deepEqual(targets, []);
});

test("a failed YouTube sentiment call never contributes a scan-target, even with real emails present", () => {
  const email: EmailScanTarget = {
    source: "email",
    title: "Real ZipTrader Newsletter",
    content: "Real newsletter body.",
    sourceTimestamp: "2026-07-12T13:00:00.000Z",
  };
  const targets = assembleScanTargets([email], { ok: false, reason: "no ANTHROPIC_API_KEY configured" });
  assert.deepEqual(targets, [email]);
});

test("a successful YouTube sentiment call contributes exactly one youtube target with the real sentiment text", () => {
  const targets = assembleScanTargets([], { ok: true, sentiment: "Real web-search derived sentiment." }, () => "2026-07-12T14:00:00.000Z");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].source, "youtube");
  assert.equal(targets[0].content, "Real web-search derived sentiment.");
  assert.equal(targets[0].sourceTimestamp, "2026-07-12T14:00:00.000Z");
});

test("real emails plus successful YouTube sentiment combine, with no fabricated content mixed in", () => {
  const email: EmailScanTarget = {
    source: "email",
    title: "Real ZipTrader Newsletter",
    content: "Real newsletter body.",
    sourceTimestamp: "2026-07-12T13:00:00.000Z",
  };
  const targets = assembleScanTargets([email], { ok: true, sentiment: "Real sentiment." }, () => "2026-07-12T14:00:00.000Z");
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], email);
  assert.equal(targets[1].source, "youtube");
  assert.equal(targets[1].content, "Real sentiment.");
});
