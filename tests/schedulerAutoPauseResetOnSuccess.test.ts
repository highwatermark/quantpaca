import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-scheduler-autopause-reset-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const ADMIN_TOKEN = "test-admin-token-0123456789";

// The first two scheduled ticks see the YouTube Claude call fail (a
// consecutive-failure streak); the third sees it succeed with a NONE-decision
// fixture, so the cycle completes cleanly.
let claudeShouldFail = true;

function fixtureMessageResponse(content: Array<{ type: "text"; text: string }>) {
  return new Response(
    JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-4-8",
      content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
const analysisFixture = {
  symbol: "NONE", growthScore: 0, sentimentScore: 0, riskProfile: "Low",
  reasoning: "no thesis this cycle", whipsawCheck: "n/a", whipsawVerdict: "unclear", decision: "NONE",
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    if (claudeShouldFail) {
      throw new Error("Simulated Claude API outage (test isolation: no live network calls).");
    }
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

test("2 consecutive scheduled failures followed by a success resets the failure counter without ever pausing", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);

  claudeShouldFail = true;
  await runScheduledSyncTickForTests();
  await runScheduledSyncTickForTests();

  let config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.equal(config.system.autoTrading, true, "2 failures alone must never pause trading");

  claudeShouldFail = false;
  await runScheduledSyncTickForTests();
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.equal(config.system.autoTrading, true, "a success on the 3rd tick must reset the counter, not pause");

  // Prove the counter actually reset (not just "hasn't reached 3 yet"): run 2
  // MORE failures after the reset -- if the earlier 2 failures had leaked
  // through, this 4th consecutive failure overall would trip the pause; since
  // the counter reset on the intervening success, it must not.
  claudeShouldFail = true;
  await runScheduledSyncTickForTests();
  await runScheduledSyncTickForTests();
  config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.equal(config.system.autoTrading, true, "2 failures after a reset must still not pause -- the earlier failures must not have carried over");
});
