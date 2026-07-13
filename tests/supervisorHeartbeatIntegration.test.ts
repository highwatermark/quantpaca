// Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5): supervisor crash-loop
// boot branch + heartbeat + missed-cycle watchdog, tested through the REAL
// server wiring (real SQLite app_state, real scheduler deps, Telegram
// mocked at globalThis.fetch) via the exported test-visible triggers --
// same convention as tests/schedulerAutoStart.test.ts /
// tests/startupReconciliationIntegration.test.ts.
//
// What is covered WHERE (task brief, "document what's covered where"):
// - Pure crash-loop decision logic: tests/crashLoopGuard.test.ts (unit).
// - Pure heartbeat/watchdog decisions: tests/heartbeat.test.ts (unit).
// - Scheduler timer/hook machinery: tests/scheduler.test.ts (unit, fake timers).
// - This file: the server.ts wiring of all three (app_state persistence,
//   delivery-gated stamping, Telegram message content, the boot branch's
//   stay-down decision). A true PROCESS-level test (spawn `node dist/server.cjs`,
//   kill -9 it three times, assert exit code 0 and no listener) would need a
//   real build + real ports + multi-second timeouts -- flaky in CI by the
//   brief's own standards, so it is an operator drill instead: see
//   docs/OPS_RUNBOOK.md.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-supervisor-heartbeat-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Broker deliberately unconfigured: the market-hours gate treats an
// unconfigured broker as "open" (no clock fetch), and getAlpacaPortfolio
// falls back to the simulated portfolio (no positions fetch) -- these tests
// are about supervisor/heartbeat wiring, not broker I/O.
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const sqlitePath = path.join(dataDir, "quantpaca.sqlite");
const dbJsonPath = path.join(dataDir, "db.json");

const sentTelegramMessages: string[] = [];

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

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called (scheduled cycles carry no Authorization header).", { status: 500 });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { runCrashLoopBootCheckForTests, runScheduledSyncTickForTests, runWatchdogCheckForTests } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");
const {
  CRASH_LOOP_WINDOW_MS,
  RESTART_HISTORY_APP_STATE_KEY,
  CLEAN_SHUTDOWN_APP_STATE_KEY,
} = await import("../src/server/crashLoopGuard");
const {
  CYCLE_COUNT_APP_STATE_KEY,
  LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY,
  WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY,
} = await import("../src/server/heartbeat");

// Telegram must be CONFIGURED (enabled + token + chat id) for delivery-gated
// sends to actually fire against the mocked fetch above. autoTrading on so
// scheduled ticks run cycles and the watchdog is armed to care.
function writeDbJson(overrides?: { autoTrading?: boolean }) {
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(
    dbJsonPath,
    JSON.stringify({
      config: {
        telegram: { botToken: "test-bot-token", chatId: "test-chat-id", enabled: true },
        system: {
          autoTrading: overrides?.autoTrading ?? true,
          runIntervalMins: 15,
          maxPositionSizePercent: 10,
          stopLossPercent: 5,
          targetProfitPercent: 15,
        },
      },
    }, null, 2),
    "utf8",
  );
}
writeDbJson();

function withStore<T>(fn: (store: ReturnType<typeof createProductionStore>) => T): T {
  const store = createProductionStore(sqlitePath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function setAppState(key: string, value: string) {
  withStore((store) => store.setAppState(key, value));
}

function getAppState(key: string): string | undefined {
  return withStore((store) => store.getAppState(key));
}

// --- Crash-loop boot branch ---

test("boot 1 and 2 within the window: no crash loop; the 3rd boot detects it, alerts, and decides to stay down", async () => {
  sentTelegramMessages.length = 0;
  setAppState(RESTART_HISTORY_APP_STATE_KEY, JSON.stringify([]));
  setAppState(CLEAN_SHUTDOWN_APP_STATE_KEY, "");

  const first = await runCrashLoopBootCheckForTests();
  assert.equal(first.stayDown, false);
  const second = await runCrashLoopBootCheckForTests();
  assert.equal(second.stayDown, false);
  assert.equal(sentTelegramMessages.length, 0, "no alert before the crash-loop threshold");

  const third = await runCrashLoopBootCheckForTests();
  assert.equal(third.stayDown, true, "the 3rd boot within the window is the crash loop");
  const alert = sentTelegramMessages.find((m) => /crash loop/i.test(m));
  assert.ok(alert, `expected a crash-loop Telegram alert, got: ${JSON.stringify(sentTelegramMessages)}`);
  assert.ok(/staying down/i.test(alert!), "the alert must say the process is staying down");
  assert.ok(/broker-protected/i.test(alert!), "the alert must reassure that positions remain broker-protected");

  const history = JSON.parse(getAppState(RESTART_HISTORY_APP_STATE_KEY)!) as number[];
  assert.equal(history.length, 3, "all 3 boots are recorded in restart_history");
});

test("a boot following a clean-shutdown marker does not count toward the crash window, and clears the marker", async () => {
  sentTelegramMessages.length = 0;
  const nowMs = Date.now();
  // Two crash-boots already in the window; the NEXT boot would be the 3rd...
  setAppState(RESTART_HISTORY_APP_STATE_KEY, JSON.stringify([nowMs - 10 * 60_000, nowMs - 20 * 60_000]));
  // ...but the prior run shut down cleanly (SIGTERM), so it must not count.
  setAppState(CLEAN_SHUTDOWN_APP_STATE_KEY, new Date().toISOString());

  const result = await runCrashLoopBootCheckForTests();
  assert.equal(result.stayDown, false, "a post-clean-shutdown boot is not a crash-recovery boot");
  assert.equal(sentTelegramMessages.length, 0);

  const history = JSON.parse(getAppState(RESTART_HISTORY_APP_STATE_KEY)!) as number[];
  assert.equal(history.length, 2, "the clean-shutdown boot was not appended to the history");

  const marker = getAppState(CLEAN_SHUTDOWN_APP_STATE_KEY);
  assert.ok(!marker, `the clean-shutdown marker must be cleared on boot (one marker excuses ONE boot), got: ${JSON.stringify(marker)}`);

  // The very next boot (no marker anymore) counts normally again -- it is the
  // 3rd boot in the window and trips the breaker.
  const next = await runCrashLoopBootCheckForTests();
  assert.equal(next.stayDown, true);
});

test("entries older than the 1-hour window are pruned by a passing boot (bounded history)", async () => {
  sentTelegramMessages.length = 0;
  const nowMs = Date.now();
  setAppState(
    RESTART_HISTORY_APP_STATE_KEY,
    JSON.stringify([nowMs - CRASH_LOOP_WINDOW_MS - 60_000, nowMs - CRASH_LOOP_WINDOW_MS - 120_000]),
  );
  setAppState(CLEAN_SHUTDOWN_APP_STATE_KEY, "");

  const result = await runCrashLoopBootCheckForTests();
  assert.equal(result.stayDown, false, "stale boots outside the window must not count");

  const history = JSON.parse(getAppState(RESTART_HISTORY_APP_STATE_KEY)!) as number[];
  assert.equal(history.length, 1, "stale entries pruned; only this boot remains");
});

test("corrupt restart_history fails open: boots normally instead of staying down", async () => {
  sentTelegramMessages.length = 0;
  setAppState(RESTART_HISTORY_APP_STATE_KEY, "definitely-not-json");
  setAppState(CLEAN_SHUTDOWN_APP_STATE_KEY, "");

  const result = await runCrashLoopBootCheckForTests();
  assert.equal(result.stayDown, false);
  const history = JSON.parse(getAppState(RESTART_HISTORY_APP_STATE_KEY)!) as number[];
  assert.equal(history.length, 1, "the corrupt blob was replaced with a fresh single-entry history");
});

// --- Heartbeat (every 12th completed scheduled cycle) ---

test("11th completed cycle: no heartbeat; 12th: exactly one delivery-gated heartbeat", async () => {
  writeDbJson({ autoTrading: true });
  sentTelegramMessages.length = 0;
  // Seed the counter at 10 so the next two REAL scheduled cycles are the
  // 11th and 12th -- driving 12 full cycles through the sync pipeline would
  // test nothing extra about the heartbeat wiring.
  setAppState(CYCLE_COUNT_APP_STATE_KEY, "10");

  await runScheduledSyncTickForTests(); // 11th
  assert.equal(getAppState(CYCLE_COUNT_APP_STATE_KEY), "11");
  assert.ok(
    !sentTelegramMessages.some((m) => /alive/i.test(m)),
    `no heartbeat on the 11th cycle, got: ${JSON.stringify(sentTelegramMessages)}`,
  );

  await runScheduledSyncTickForTests(); // 12th
  assert.equal(getAppState(CYCLE_COUNT_APP_STATE_KEY), "12");
  const heartbeats = sentTelegramMessages.filter((m) => /alive/i.test(m));
  assert.equal(heartbeats.length, 1, `exactly one heartbeat on the 12th cycle, got: ${JSON.stringify(sentTelegramMessages)}`);
  assert.match(heartbeats[0], /cycle 12/i);
  assert.match(heartbeats[0], /regime/i);
  assert.match(heartbeats[0], /open positions/i);

  // Every completed cycle (heartbeat or not) advances the watchdog's
  // last-completed-at timestamp.
  const lastCompletedAt = Number(getAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY));
  assert.ok(Number.isFinite(lastCompletedAt) && lastCompletedAt > 0);
});

// --- Missed-cycle watchdog ---

test("watchdog: 31-minute gap at a 15-minute interval with autoTrading on alerts once; repeated checks stay silent; a new gap alerts again", async () => {
  writeDbJson({ autoTrading: true });
  sentTelegramMessages.length = 0;
  const gapStart = Date.now() - 31 * 60_000;
  setAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY, String(gapStart));
  setAppState(WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY, "");

  await runWatchdogCheckForTests();
  let overdueAlerts = sentTelegramMessages.filter((m) => /overdue/i.test(m));
  assert.equal(overdueAlerts.length, 1, `expected exactly one overdue alert, got: ${JSON.stringify(sentTelegramMessages)}`);

  // Same gap, checked twice more: no repeat (the delivered alert stamped the gap).
  await runWatchdogCheckForTests();
  await runWatchdogCheckForTests();
  overdueAlerts = sentTelegramMessages.filter((m) => /overdue/i.test(m));
  assert.equal(overdueAlerts.length, 1, "the same still-open gap must never re-alert");

  // A cycle completes (last-completed-at moves forward), then a NEW gap opens.
  const newGapStart = Date.now() - 45 * 60_000;
  setAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY, String(newGapStart));
  await runWatchdogCheckForTests();
  overdueAlerts = sentTelegramMessages.filter((m) => /overdue/i.test(m));
  assert.equal(overdueAlerts.length, 2, "a distinct new gap alerts again");
});

test("watchdog: autoTrading off never alerts, even with a huge gap", async () => {
  writeDbJson({ autoTrading: false });
  sentTelegramMessages.length = 0;
  setAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY, String(Date.now() - 6 * 60 * 60_000));
  setAppState(WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY, "");

  await runWatchdogCheckForTests();
  assert.equal(
    sentTelegramMessages.filter((m) => /overdue/i.test(m)).length,
    0,
    "autoTrading off means no cycles are EXPECTED -- a quiet scheduler is correct, not overdue",
  );
});

test("watchdog: a fresh gap within 2x the interval does not alert", async () => {
  writeDbJson({ autoTrading: true });
  sentTelegramMessages.length = 0;
  setAppState(LAST_CYCLE_COMPLETED_AT_APP_STATE_KEY, String(Date.now() - 20 * 60_000));
  setAppState(WATCHDOG_ALERTED_GAP_START_APP_STATE_KEY, "");

  await runWatchdogCheckForTests();
  assert.equal(sentTelegramMessages.filter((m) => /overdue/i.test(m)).length, 0);
});
