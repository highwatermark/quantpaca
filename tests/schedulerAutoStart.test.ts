import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-scheduler-autostart-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Broker deliberately unconfigured: checkMarketOpenForScheduledCycle treats an
// unconfigured broker as "open" with no clock fetch at all (nothing to
// gate against in local/offline mode) -- this test is only about the loop's
// start/no-start wiring and the exported manual-tick trigger, not the
// market-hours gate (covered separately in schedulerMarketHoursGate.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const ADMIN_TOKEN = "test-admin-token-0123456789";

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

const { app, runScheduledSyncTickForTests } = await import("../server");

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

test("NODE_ENV=test: the scheduler loop never auto-starts, but the exported test-visible tick runs cycles on demand", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);

  // Nothing should have run automatically yet -- no real setTimeout chain was
  // ever armed (run(), which alone calls scheduler.start(), is gated off by
  // NODE_ENV=test at the bottom of server.ts).
  const beforeLogs = await (await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.ok(
    !beforeLogs.some((l) => l.trigger === "scheduled"),
    `expected zero auto-started scheduled cycles before any manual tick, got: ${JSON.stringify(beforeLogs)}`,
  );

  await runScheduledSyncTickForTests();
  await runScheduledSyncTickForTests();

  const afterLogs = await (await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  const scheduledStartLogs = afterLogs.filter((l) => l.trigger === "scheduled" && /Starting automation loop/i.test(l.message));
  assert.equal(
    scheduledStartLogs.length,
    2,
    `expected exactly 2 scheduled cycles' start log entries after 2 manual ticks, got: ${JSON.stringify(afterLogs.map((l) => ({ trigger: l.trigger, message: l.message })))}`,
  );

  // Trigger source is also recorded in audit events (not just sync logs).
  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  const scheduledCycleAudit = audit.filter((e) => e.type === "sync" && e.actor === "scheduler" && e.details?.trigger === "scheduled");
  assert.equal(
    scheduledCycleAudit.length,
    2,
    `expected 2 audit events marking scheduled-cycle starts, got: ${JSON.stringify(audit.map((e) => ({ type: e.type, actor: e.actor })))}`,
  );
});
