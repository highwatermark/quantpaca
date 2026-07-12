import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-empty-sync-throttle-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Broker deliberately left unconfigured (pattern: breakerResetTelegram.test.ts)
// -- with autoTrading left off (default), that keeps MODULE 2.5 (regime) and
// MODULE 2 (portfolio risk controller) hermetic, since neither is gated to
// run without autoTrading. This test only needs Claude (unconditional
// YouTube-sentiment web search) and Telegram intercepted; Gmail is never
// called since no Authorization header is ever sent, which is exactly the
// "no Gmail OAuth token" zero-email-scan-targets scenario under test.
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const dbJsonPath = path.join(dataDir, "db.json");

function fixtureMessageResponse(content: Array<{ type: "text"; text: string }>) {
  return new Response(
    JSON.stringify({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Only a "NONE" decision fixture is needed -- this test is about the empty-
// sync Telegram alert throttle, not the buy path (same pattern as
// regimeStaleness.test.ts).
const analysisFixture = {
  symbol: "NONE",
  growthScore: 0,
  sentimentScore: 0,
  riskProfile: "Low",
  reasoning: "no thesis this cycle",
  whipsawCheck: "n/a",
  whipsawVerdict: "unclear",
  decision: "NONE",
};

const sentTelegramMessages: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    if (body.output_config) {
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(analysisFixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "ZipTrader fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called in this test file (no Authorization header sent).", { status: 500 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");

const ADMIN_TOKEN_HEADER = { "x-admin-token": ADMIN_TOKEN };

// db.json's config.telegram.botToken can never be set via POST /api/config
// (stripPersistedSecrets always zeroes it out before writing -- see
// tradingSafety.ts). Writing directly to the on-disk db.json (read fresh by
// readDB() on every request) is the only way to get sendTelegramAlert past
// its own `config.botToken` guard in a test, without adding a new env var.
function enableTelegram() {
  const raw = fs.existsSync(dbJsonPath) ? JSON.parse(fs.readFileSync(dbJsonPath, "utf8")) : {};
  raw.config = { ...(raw.config || {}), telegram: { botToken: "test-telegram-bot-token", chatId: "test-chat-id", enabled: true } };
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(dbJsonPath, JSON.stringify(raw, null, 2), "utf8");
}

// The default config shape (defaultDB() in server.ts): no botToken/chatId,
// enabled false -- sendTelegramAlert silently no-ops (returns false) against
// this, which is exactly the "Telegram not configured yet" state under test.
function disableTelegram() {
  const raw = fs.existsSync(dbJsonPath) ? JSON.parse(fs.readFileSync(dbJsonPath, "utf8")) : {};
  raw.config = { ...(raw.config || {}), telegram: { botToken: "", chatId: "", enabled: false } };
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(dbJsonPath, JSON.stringify(raw, null, 2), "utf8");
}

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ADMIN_TOKEN_HEADER },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body;
}

test("empty-sync Telegram alert throttle: two back-to-back syncs with Gmail absent produce exactly one Telegram alert attempt, but two log entries", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  enableTelegram();
  sentTelegramMessages.length = 0;

  const firstBody = await runSync(port);
  const secondBody = await runSync(port);

  assert.equal(sentTelegramMessages.length, 1, `expected exactly one Telegram alert attempt across two syncs, got: ${JSON.stringify(sentTelegramMessages)}`);
  assert.ok(/zero usable emails/i.test(sentTelegramMessages[0]));

  const firstLogMessages: string[] = firstBody.logs.map((l: any) => l.message);
  const secondLogMessages: string[] = secondBody.logs.map((l: any) => l.message);
  assert.ok(
    firstLogMessages.some((m) => /zero usable email scan-targets/i.test(m)),
    `expected the first sync's log to record the zero-email-targets outcome, got: ${JSON.stringify(firstLogMessages)}`,
  );
  assert.ok(
    secondLogMessages.some((m) => /zero usable email scan-targets/i.test(m)),
    `expected the second sync's log to ALSO record the zero-email-targets outcome (logs are never throttled), got: ${JSON.stringify(secondLogMessages)}`,
  );
});

test("empty-sync Telegram alert throttle: suppressed within the window, fires again once the window has elapsed", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  enableTelegram();
  sentTelegramMessages.length = 0;

  // Directly seed the persisted throttle state -- bypassing a real 6-hour
  // wait (or dependence on this test file's other test's leftover state),
  // same pattern as the regime cache tests seeding a backdated
  // fetchedAt/asOf directly through the store.
  const { createProductionStore } = await import("../src/server/persistence");
  const { EMPTY_SYNC_ALERT_STATE_KEY, EMPTY_SYNC_ALERT_WINDOW_MS } = await import("../src/server/alertThrottle");
  const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

  // A "just alerted" timestamp, well within the window -> the next sync must
  // stay suppressed.
  const rawStoreRecent = createProductionStore(sqlitePath);
  rawStoreRecent.setAppState(EMPTY_SYNC_ALERT_STATE_KEY, new Date().toISOString());
  rawStoreRecent.close();

  await runSync(port);
  assert.equal(sentTelegramMessages.length, 0, "expected the alert to stay suppressed while within the throttle window");

  // Back-date the throttle state past the window -> the very next sync must alert.
  const rawStoreOld = createProductionStore(sqlitePath);
  rawStoreOld.setAppState(EMPTY_SYNC_ALERT_STATE_KEY, new Date(Date.now() - (EMPTY_SYNC_ALERT_WINDOW_MS + 60_000)).toISOString());
  rawStoreOld.close();

  await runSync(port);
  assert.equal(sentTelegramMessages.length, 1, "expected the alert to fire again once the throttle window has elapsed");
});

test("empty-sync Telegram alert throttle: a no-op alert attempt (Telegram unconfigured) must not advance the throttle stamp -- enabling Telegram later alerts immediately", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  sentTelegramMessages.length = 0;

  const { createProductionStore } = await import("../src/server/persistence");
  const { EMPTY_SYNC_ALERT_STATE_KEY, EMPTY_SYNC_ALERT_WINDOW_MS } = await import("../src/server/alertThrottle");
  const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

  // Start from a quiet period (stamp well past the window -- the alert is
  // "due") with Telegram NOT configured: sendTelegramAlert will silently
  // no-op (returns false) because botToken/chatId/enabled aren't set.
  disableTelegram();
  const backdated = new Date(Date.now() - (EMPTY_SYNC_ALERT_WINDOW_MS + 60_000)).toISOString();
  const rawStoreSeed = createProductionStore(sqlitePath);
  rawStoreSeed.setAppState(EMPTY_SYNC_ALERT_STATE_KEY, backdated);
  rawStoreSeed.close();

  await runSync(port);
  assert.equal(sentTelegramMessages.length, 0, "Telegram is unconfigured -- nothing must reach api.telegram.org");

  // The throttle stamp must NOT have advanced: nothing was actually
  // delivered, and stamping a silent no-op would suppress the first REAL
  // alert for up to 6 hours after the operator finally configures Telegram --
  // contradicting this control's fail-open-toward-alerting direction
  // (alertThrottle.ts module comment).
  const rawStoreCheck = createProductionStore(sqlitePath);
  const stampAfterNoop = rawStoreCheck.getAppState(EMPTY_SYNC_ALERT_STATE_KEY);
  rawStoreCheck.close();
  assert.equal(stampAfterNoop, backdated, "a silent no-op alert attempt must not advance the persisted throttle stamp");

  // Operator configures Telegram within what would have been the 6h window:
  // the very next empty-Gmail sync must alert immediately.
  enableTelegram();
  await runSync(port);
  assert.equal(
    sentTelegramMessages.length,
    1,
    "the first sync after Telegram is configured must alert immediately (no stamp was written by the earlier no-op)",
  );
});
