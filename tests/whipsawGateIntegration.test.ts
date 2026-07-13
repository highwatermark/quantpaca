import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-whipsaw-integration-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
// Force the simulated/unconfigured broker path deterministically, regardless of any
// real Alpaca credentials in a local .env file (same reasoning as symbolCooldown.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const ADMIN_TOKEN = "test-admin-token-0123456789";

// This exercises the real /api/sync wiring end-to-end (pattern: syncFallbackRemoval
// .test.ts), not the pure applyWhipsawGate function in isolation. Both Claude calls
// made during a sync (the YouTube web-search sentiment call, and the per-target
// structured-JSON analysis call) go to api.anthropic.com, so both are intercepted.
// The web-search fixture is constant; the structured analysis fixture is mutated
// per test to drive different whipsawVerdict/decision combinations through the
// real gate wired into server.ts.
let analysisFixture: Record<string, unknown> = {};

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

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    // The structured-output analysis call sets output_config; the web-search
    // sentiment call does not -- that's how the two calls are told apart here.
    if (body.output_config) {
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(analysisFixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "ZipTrader fixture sentiment: nothing notable this cycle." }]);
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");

async function enableAutoTrading(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: {
        autoTrading: true,
        runIntervalMins: 15,
        maxPositionSizePercent: 10,
        stopLossPercent: 5,
        targetProfitPercent: 15,
      },
    }),
  });
  assert.equal(res.status, 200);
}

async function seedPosition(port: number, symbol: string, qty: number, price: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ symbol, qty, side: "buy", price }),
  });
  const body = await res.json();
  assert.equal(body.trade.status, "Accepted", `expected seed buy to be accepted, got: ${JSON.stringify(body)}`);
}

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body;
}

test("a fixture SELL analysis with whipsawVerdict 'whipsaw' produces no sell trade; the analysis is recorded as HOLD with the downgrade noted", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  // A real position to sell -- otherwise the SELL branch would never be reached
  // regardless of the gate, which would make this test pass for the wrong reason.
  await seedPosition(port, "WHIP", 10, 100);

  analysisFixture = {
    symbol: "WHIP",
    growthScore: 80,
    sentimentScore: 80,
    riskProfile: "Medium",
    reasoning: "Fundamentals remain intact despite the pullback.",
    whipsawCheck: "This looks like a volatility-driven shakeout, not a broken thesis.",
    whipsawVerdict: "whipsaw",
    decision: "SELL",
  };

  const body = await runSync(port);

  assert.equal(body.analyses.length, 1);
  const analysis = body.analyses[0];
  assert.equal(analysis.symbol, "WHIP");
  assert.equal(analysis.decision, "HOLD", "a SELL with an unverified (whipsaw) verdict must be downgraded to HOLD");
  assert.equal(analysis.whipsawVerdict, "whipsaw");
  assert.match(analysis.reasoning, /whipsaw gate/i, "the downgrade must be recorded in the persisted reasoning (audit trail)");

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /whipsaw gate/i.test(m) && /WHIP/.test(m)),
    `expected a sync log entry documenting the downgrade, got: ${JSON.stringify(logMessages)}`,
  );

  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  const trades = await tradesRes.json();
  assert.equal(trades.length, 1, "only the seed manual buy trade should exist -- no automated SELL trade was submitted");
  assert.ok(!trades.some((tr: any) => tr.side === "sell"), "the gate must have prevented a sell trade from reaching execution");
});

test("a fixture SELL analysis with whipsawVerdict 'reversal' proceeds as a real sell trade", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  await seedPosition(port, "REVX", 5, 50);

  analysisFixture = {
    symbol: "REVX",
    growthScore: 80,
    sentimentScore: 20,
    riskProfile: "High",
    reasoning: "Momentum has genuinely reversed on volume confirmation.",
    whipsawCheck: "Verified trend reversal, not a shakeout.",
    whipsawVerdict: "reversal",
    decision: "SELL",
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "REVX");
  assert.ok(analysis, "expected a REVX analysis to be recorded");
  assert.equal(analysis.decision, "SELL", "a verified reversal must not be downgraded");
  assert.equal(analysis.whipsawVerdict, "reversal");

  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  const trades = await tradesRes.json();
  assert.ok(
    trades.some((tr: any) => tr.symbol === "REVX" && tr.side === "sell"),
    `expected a real sell trade for REVX once reversal is verified, got: ${JSON.stringify(trades)}`,
  );
});

test("a fixture BUY analysis with whipsawVerdict 'reversal' halves the confidence carried into the persisted reviewed signal", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  analysisFixture = {
    symbol: "RVRS",
    growthScore: 90,
    sentimentScore: 90,
    riskProfile: "High",
    reasoning: "Momentum has genuinely reversed on volume confirmation, high-conviction entry.",
    whipsawCheck: "Verified trend reversal, not a shakeout.",
    whipsawVerdict: "reversal",
    decision: "BUY",
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "RVRS");
  assert.ok(analysis, "expected an RVRS analysis to be recorded");
  assert.equal(analysis.decision, "BUY");
  assert.equal(analysis.whipsawVerdict, "reversal");

  const reviewedRes = await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  assert.equal(reviewedRes.status, 200);
  const reviewed = await reviewedRes.json();
  const rvrsSignal = reviewed.find((s: any) => s.symbol === "RVRS");
  assert.ok(rvrsSignal, "expected a persisted reviewed signal for RVRS");
  // Raw confidence would be round((90 + 90) / 2) = 90; a verified-reversal BUY
  // halves it to 45 before it flows into the reviewed signal / sizing engine.
  assert.equal(rvrsSignal.confidenceScore, 45);
});

test("a fixture BUY analysis with whipsawVerdict 'whipsaw' keeps full confidence (buying the dip is the strategy's core case)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  analysisFixture = {
    symbol: "DIPBUY",
    growthScore: 70,
    sentimentScore: 70,
    riskProfile: "Medium",
    reasoning: "Support level held; volatility shakeout, not a broken thesis.",
    whipsawCheck: "This is a whipsaw -- volatility-driven, dip likely to recover.",
    whipsawVerdict: "whipsaw",
    decision: "BUY",
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === "DIPBUY");
  assert.ok(analysis, "expected a DIPBUY analysis to be recorded");
  assert.equal(analysis.decision, "BUY");
  assert.equal(analysis.whipsawVerdict, "whipsaw");

  const reviewedRes = await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  const reviewed = await reviewedRes.json();
  const dipSignal = reviewed.find((s: any) => s.symbol === "DIPBUY");
  assert.ok(dipSignal);
  // Raw confidence: round((70 + 70) / 2) = 70; whipsaw BUYs keep full confidence.
  assert.equal(dipSignal.confidenceScore, 70);
});
