import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-scheduler-autopause-3fail-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Unconfigured broker: checkMarketOpenForScheduledCycle treats this as "open"
// with no clock fetch (see schedulerMarketHoursGate.test.ts for the gate
// itself) -- this test is purely about the failure-counting/auto-pause path,
// driven by making the YouTube web-search Claude call always fail. A
// scheduled cycle never carries an Authorization header, so Gmail is never
// attempted; per server.ts's runSyncCycle, guardrail 7's "every ATTEMPTED
// ingestion source errored" then reduces to "YouTube errored" for a
// scheduled cycle -- exactly what this simulates.
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const ADMIN_TOKEN = "test-admin-token-0123456789";

const sentTelegramMessages: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    throw new Error("Simulated persistent Claude API outage (test isolation: no live network calls).");
  }
  if (url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called (scheduled cycles carry no Authorization header).", { status: 500 });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app, runScheduledSyncTickForTests } = await import("../server");
const dbJsonPath = path.join(dataDir, "db.json");

function enableTelegram() {
  const raw = fs.existsSync(dbJsonPath) ? JSON.parse(fs.readFileSync(dbJsonPath, "utf8")) : {};
  raw.config = { ...(raw.config || {}), telegram: { botToken: "test-telegram-bot-token", chatId: "test-chat-id", enabled: true } };
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(dbJsonPath, JSON.stringify(raw, null, 2), "utf8");
}

async function setAutoTrading(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: true, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 5, targetProfitPercent: 15 },
    }),
  });
  assert.equal(res.status, 200);
}

test("guardrail 7: the third consecutive failed scheduled cycle pauses trading -- autoTrading persisted false, an unthrottled Telegram alert is attempted, and an audit event is recorded", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Order matters: POST /api/config (setAutoTrading) round-trips db.config
  // through stripPersistedSecrets, which always zeroes telegram.botToken --
  // enableTelegram's direct db.json write must happen AFTER, or the config
  // POST below would immediately wipe it back out (same reasoning as
  // emptySyncTelegramThrottle.test.ts's enableTelegram comment).
  await setAutoTrading(port);
  enableTelegram();
  sentTelegramMessages.length = 0;
  // Each of these scheduled cycles also independently triggers the (unrelated,
  // already-throttled) empty-Gmail-ingestion alert from Phase 2 Task 1 -- both
  // alerts share api.telegram.org, so pause-specific assertions below filter
  // sentTelegramMessages down to /paused/i rather than asserting on raw counts.
  const pauseAlerts = () => sentTelegramMessages.filter((m) => /paused/i.test(m));

  await runScheduledSyncTickForTests();
  let config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json();
  assert.equal(config.system.autoTrading, true, "1 failure must not pause trading");

  await runScheduledSyncTickForTests();
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json();
  assert.equal(config.system.autoTrading, true, "2 failures must not pause trading");
  assert.equal(pauseAlerts().length, 0, "no pause alert before the 3rd consecutive failure");

  await runScheduledSyncTickForTests();
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json();
  assert.equal(config.system.autoTrading, false, "the 3rd consecutive failure must pause trading (autoTrading -> false, persisted)");

  assert.equal(pauseAlerts().length, 1, `expected exactly one pause alert attempt, got: ${JSON.stringify(sentTelegramMessages)}`);

  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.ok(
    audit.some((e) => e.actor === "scheduler" && /auto-pause/i.test(e.message || "")),
    `expected an audit event recording the auto-pause, got: ${JSON.stringify(audit.map((e) => e.message))}`,
  );

  // The scheduler keeps ticking, but does nothing while paused -- no further
  // pause alert, and autoTrading stays false until a human resumes.
  await runScheduledSyncTickForTests();
  assert.equal(pauseAlerts().length, 1, "the scheduler must not re-alert on ticks after the pause while still paused");
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json();
  assert.equal(config.system.autoTrading, false, "trading must stay paused until a human resumes");
});
