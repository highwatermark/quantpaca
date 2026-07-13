// Phase 2 Task 14 review fix 1: the crash-loop boot check (guardrail 9) runs
// FIRST at boot -- deliberately BEFORE the one-time db.json -> SQLite
// migration, so a crash loop caused by any later boot step (including a buggy
// migration itself) is still caught. On a PRE-migration boot the SQLite
// config row doesn't exist yet: the Telegram config still lives in the legacy
// db.json. This file exercises that REAL ordering -- an un-migrated db.json
// fixture with a configured Telegram plus a seeded crash-loop history must
// deliver the crash-loop alert using db.json's config, without the migration
// having run.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-crashloop-premigration-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

// The un-migrated legacy db.json, written BEFORE the server module is
// imported -- exactly the state an existing deployment is in on its first
// boot after upgrading to the consolidated-store version.
const dbJsonPath = path.join(dataDir, "db.json");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  dbJsonPath,
  JSON.stringify({
    config: {
      telegram: { botToken: "legacy-bot-token", chatId: "legacy-chat-id", enabled: true },
    },
  }, null, 2),
  "utf8",
);

const sentTelegramMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { runCrashLoopBootCheckForTests } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");
const { RESTART_HISTORY_APP_STATE_KEY } = await import("../src/server/crashLoopGuard");
const { DBJSON_MIGRATED_AT_APP_STATE_KEY } = await import("../src/server/appStore");

test("pre-migration crash loop: the boot alert is delivered using the un-migrated db.json's telegram config", async () => {
  const store = createProductionStore(path.join(dataDir, "quantpaca.sqlite"));
  try {
    assert.equal(
      store.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY),
      undefined,
      "sanity: the migration must NOT have run (the crash-loop check precedes it in run())",
    );
    assert.equal(store.getConfig?.() ?? undefined, undefined, "sanity: no SQLite config row exists pre-migration");
    // Two prior boots moments ago -> this boot is the 3rd within the window.
    store.setAppState(RESTART_HISTORY_APP_STATE_KEY, JSON.stringify([Date.now() - 60_000, Date.now() - 30_000]));
  } finally {
    store.close();
  }

  sentTelegramMessages.length = 0;
  const result = await runCrashLoopBootCheckForTests();
  assert.equal(result.stayDown, true, "sanity: 3 boots within the window must trip the crash loop");

  assert.ok(
    sentTelegramMessages.some((m) => /crash loop/i.test(m)),
    `expected the crash-loop alert to be delivered via db.json's telegram config, got: ${JSON.stringify(sentTelegramMessages)}`,
  );

  // The alert must not have required (or triggered) the migration: the
  // marker is still absent and the store's config row still doesn't exist.
  const storeAfter = createProductionStore(path.join(dataDir, "quantpaca.sqlite"));
  try {
    assert.equal(storeAfter.getAppState(DBJSON_MIGRATED_AT_APP_STATE_KEY), undefined, "the migration must still not have run");
    assert.equal(storeAfter.getConfig(), undefined, "no config row must have been written by the alert path");
  } finally {
    storeAfter.close();
  }
});
