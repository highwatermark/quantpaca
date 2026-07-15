// Phase 2 follow-up (docs/GO_LIVE_PLAN.md sign-off item 2): smoke tests for
// scripts/get-google-refresh-token.mjs, the one-time interactive CLI helper
// an operator runs locally to obtain GOOGLE_REFRESH_TOKEN (see docs/
// OPS_RUNBOOK.md "Connect Gmail"). The script is inherently interactive
// (it opens a real browser consent flow against Google and waits on a real
// localhost redirect) -- these tests exercise only the parts that don't
// require a live Google OAuth round-trip: --help output and the
// missing-credentials fail-closed path. Plain `node`, no test-only exports
// needed (the script has no importable surface -- it IS the CLI entry point).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(dirname, "..", "scripts", "get-google-refresh-token.mjs");

test("the script file exists and is plain Node (no npm dependencies imported)", () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `expected ${SCRIPT_PATH} to exist`);
  const content = fs.readFileSync(SCRIPT_PATH, "utf8");
  // Only Node built-ins (node: specifier) may be imported -- no bare package
  // specifiers, matching the brief's "no deps" constraint.
  const importLines = content.match(/^import .* from "([^"]+)";?$/gm) || [];
  for (const line of importLines) {
    const specifier = /from "([^"]+)"/.exec(line)?.[1];
    assert.ok(specifier && specifier.startsWith("node:"), `expected only node: built-in imports, found: ${line}`);
  }
});

test("--help prints usage instructions and exits 0 without requiring credentials", async () => {
  const { stdout } = await execFileAsync("node", [SCRIPT_PATH, "--help"], {
    env: { ...process.env, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
  });
  assert.match(stdout, /Usage/i);
  assert.match(stdout, /GOOGLE_CLIENT_ID/);
  assert.match(stdout, /GOOGLE_CLIENT_SECRET/);
  assert.match(stdout, /Gmail API/i);
  assert.match(stdout, /Desktop app/i);
});

test("missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (env and argv both empty) exits non-zero with a clear message, without starting a listener", async () => {
  const env = { ...process.env };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  await assert.rejects(
    execFileAsync("node", [SCRIPT_PATH], { env, timeout: 5000 }),
    (err: any) => {
      assert.notEqual(err.code, 0);
      assert.match(String(err.stderr), /Missing GOOGLE_CLIENT_ID/);
      return true;
    },
  );
});

test("--client-id and --client-secret flags are accepted as an alternative to env vars: the script gets past credential validation and prints a real Google consent URL on localhost:8724", async () => {
  const env = { ...process.env };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  const child = spawn("node", [SCRIPT_PATH, "--client-id=test-cid", "--client-secret=test-csecret"], { env });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for consent URL; stdout so far: ${stdout} stderr: ${stderr}`)), 4000);
      const check = setInterval(() => {
        if (stdout.includes("accounts.google.com")) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      child.on("exit", (code) => {
        clearInterval(check);
        clearTimeout(timer);
        reject(new Error(`script exited early (code ${code}) before printing a consent URL; stdout: ${stdout} stderr: ${stderr}`));
      });
    });
  } finally {
    child.kill("SIGTERM");
  }

  assert.match(stdout, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(stdout, /client_id=test-cid/);
  assert.match(stdout, /scope=.*gmail\.readonly/);
  assert.match(stdout, /access_type=offline/);
  assert.match(stdout, /prompt=consent/);
  assert.match(stdout, /localhost:8724/);
});
