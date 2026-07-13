// Phase 2 final review, finding I2: guardrail 7's cycle-failure signal used
// to look ONLY at ingestion-source errors (Gmail/YouTube) -- a broker that is
// hard-down (account/positions fetch failing every cycle) never counted, so
// the scheduler would retry against a dead broker forever, never reaching
// MAX_CONSECUTIVE_FAILURES / auto-pause. This exercises the fix: the
// position-reconciliation account/positions fetch (MODULE 1.6) failing feeds
// a `brokerConnectivityFailed` signal into the SAME `failed` guardrail 7
// already threads into the scheduler's auto-pause counter.
//
// The market is kept CLOSED for every scheduled tick (mocked GET /v2/clock)
// so the whole Gmail/YouTube ingestion + Claude analysis loop is a reduced-
// cycle no-op (gmailAttempted/youtubeAttempted both stay false) -- this
// isolates the broker-connectivity signal as the ONLY possible source of
// `failed` here; no Claude mocking is needed at all.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-scheduler-broker-connectivity-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Broker IS configured -- MODULE 1.6's account/positions fetch only ever
// attempts (and can therefore only ever fail) when it is.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";

const sentTelegramMessages: string[] = [];
let accountFetchCount = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    throw new Error("Claude must never be called: the market is always closed in this test (reduced cycle, ingestion skipped).");
  }
  if (url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called (scheduled cycles carry no Authorization header).", { status: 500 });
  }
  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/clock")) {
      // Market always closed -> every scheduled tick is a reduced cycle;
      // ingestion is skipped entirely (Claude healthy but never called).
      return new Response(JSON.stringify({ is_open: false }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/account")) {
      // Claude healthy (never even called), Alpaca hard-down: every account
      // fetch this test issues fails with a 500.
      accountFetchCount += 1;
      return new Response(JSON.stringify({ message: "simulated Alpaca outage" }), { status: 500 });
    }
    return new Response("unhandled paper-api.alpaca.markets path in test fixture", { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app, runScheduledSyncTickForTests } = await import("../server");
const { withAppStore } = await import("./helpers/appStoreFixture");

function enableTelegram() {
  withAppStore(dataDir, (store) => {
    const config = store.getConfig();
    store.setConfig({ ...config, telegram: { botToken: "test-telegram-bot-token", chatId: "test-chat-id", enabled: true } });
  });
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

test("guardrail 7 (I2): 3 consecutive scheduled cycles with the Alpaca account fetch failing (Claude never even called) auto-pauses trading", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  enableTelegram();
  sentTelegramMessages.length = 0;
  const pauseAlerts = () => sentTelegramMessages.filter((m) => /paused/i.test(m));

  await runScheduledSyncTickForTests();
  let config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
  assert.equal(config.system.autoTrading, true, "1 failure must not pause trading");

  await runScheduledSyncTickForTests();
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
  assert.equal(config.system.autoTrading, true, "2 failures must not pause trading");
  assert.equal(pauseAlerts().length, 0, "no pause alert before the 3rd consecutive failure");

  await runScheduledSyncTickForTests();
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
  assert.equal(config.system.autoTrading, false, "the 3rd consecutive broker-connectivity failure must pause trading");

  assert.equal(pauseAlerts().length, 1, `expected exactly one pause alert attempt, got: ${JSON.stringify(sentTelegramMessages)}`);
  assert.ok(accountFetchCount >= 3, `sanity: expected the account fetch to have actually been attempted each cycle, got ${accountFetchCount}`);

  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { "x-admin-token": ADMIN_TOKEN } })).json() as any[];
  assert.ok(
    audit.some((e) => e.actor === "scheduler" && /auto-pause/i.test(e.message || "")),
    `expected an audit event recording the auto-pause, got: ${JSON.stringify(audit.map((e) => e.message))}`,
  );
});
