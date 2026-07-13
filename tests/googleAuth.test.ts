// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): retire the mock Google
// OAuth token. Investigation (documented in src/services/googleAuth.ts):
// server.ts's Gmail ingestion + Google Sheets export forward the caller's
// `Authorization` header (authHeader) -- and this module's cached token,
// reached via App.tsx, was the ONLY source of that header (no server-side
// GOOGLE_ACCESS_TOKEN-style credential exists). So this is real (not dead)
// wiring: the fix is an honest "not configured" no-op, not deletion of the
// module.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initGoogleOAuth,
  loginWithGoogle,
  getCachedToken,
  setCachedToken,
  getGoogleUser,
  setGoogleUser,
  logoutGoogle,
} from "../src/services/googleAuth";

test("no mock OAuth token string remains anywhere in src/", () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const content = fs.readFileSync(full, "utf8");
        if (content.includes("ya29.mock")) offenders.push(full);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `found the mock token string in: ${JSON.stringify(offenders)}`);
});

test("initGoogleOAuth returns null with nothing cached (no fabricated token)", () => {
  setCachedToken(null);
  assert.equal(initGoogleOAuth(), null);
});

test("loginWithGoogle rejects honestly instead of fabricating a working session", async () => {
  await assert.rejects(() => loginWithGoogle(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /not configured/i);
    return true;
  });
  // A rejected login must never have set a token or a user as a side effect.
  assert.equal(getCachedToken(), null);
  assert.equal(getGoogleUser(), null);
});

test("setCachedToken / getCachedToken / setGoogleUser / getGoogleUser / logoutGoogle round-trip still works (real-OAuth escape hatch preserved)", () => {
  setCachedToken("a-real-token-obtained-some-other-way");
  setGoogleUser({ name: "Hari", email: "hariase@gmail.com" });
  assert.equal(getCachedToken(), "a-real-token-obtained-some-other-way");
  assert.deepEqual(getGoogleUser(), { name: "Hari", email: "hariase@gmail.com" });

  logoutGoogle();
  assert.equal(getCachedToken(), null);
  assert.equal(getGoogleUser(), null);
});
