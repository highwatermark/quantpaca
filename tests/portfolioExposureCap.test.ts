import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-exposure-cap-test-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
// Force the simulated/unconfigured broker path deterministically, regardless of any
// real Alpaca credentials in a local .env file (same reasoning as symbolCooldown.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
// The value under test: a low cap (20%) so an existing position that already
// consumes 18% of equity leaves only $2,000 of exposure room -- far less than
// what the buying-power ($81,900 usable) or per-symbol ($72,000) caps would
// allow. If server.ts still passed the old hardcoded 100 into sizeTradeIntent
// instead of this env-loaded value, the exposure cap would never bind and the
// sized quantity would be governed by one of those much larger caps instead.
process.env.QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT = "20";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const SYMBOL = "EXPO";
const SEED_PRICE = 100;
const SEED_QTY = 180; // $18,000 notional = 18% of the $100,000 simulated equity

// This exercises the real /api/sync wiring end-to-end (pattern: whipsawGateIntegration
// .test.ts), not the pure sizeTradeIntent function in isolation -- that proves server.ts
// actually passes the env-loaded riskLimits.maxPortfolioExposurePercent value into the
// real sizing call on the automation buy path, not just that the sizing math is correct
// in isolation (the sizing engine's own unit tests already cover that math).
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
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }
  return realFetch(input, init);
}) as typeof fetch;
test.after(() => {
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
        // Deliberately high so the per-symbol cap ($90,000 remaining) never binds --
        // the portfolio exposure cap must be the constraint under test.
        maxPositionSizePercent: 90,
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

test("an automated BUY on a symbol already near the env-loaded portfolio exposure cap is shrunk (or rejected) so aggregate exposure stays within the cap", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await enableAutoTrading(port);
  // Seed an existing position for the same symbol so the simulated-broker price
  // lookup on the automation buy path (server.ts) has a deterministic current_price
  // to read, and so exposure is already close to the 20% cap before the new buy.
  await seedPosition(port, SYMBOL, SEED_QTY, SEED_PRICE);

  analysisFixture = {
    symbol: SYMBOL,
    growthScore: 90,
    sentimentScore: 90,
    riskProfile: "Medium",
    reasoning: "Strong fundamentals support continued accumulation.",
    whipsawCheck: "No prior position swing to evaluate.",
    whipsawVerdict: "reversal",
    decision: "BUY",
  };

  const body = await runSync(port);
  const analysis = body.analyses.find((a: any) => a.symbol === SYMBOL);
  assert.ok(analysis, "expected an analysis to be recorded for EXPO");
  assert.equal(analysis.decision, "BUY");

  const portfolioRes = await fetch(`http://127.0.0.1:${port}/api/portfolio`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  const portfolio = await portfolioRes.json();
  const equity = Number(portfolio.equity ?? portfolio.portfolio_value);
  assert.ok(Number.isFinite(equity) && equity > 0, `expected a finite equity, got: ${JSON.stringify(portfolio)}`);

  const cappedExposureNotional = equity * 0.2;
  const totalLongMarketValue = Number(portfolio.long_market_value);
  assert.ok(
    Number.isFinite(totalLongMarketValue),
    `expected a finite long_market_value, got: ${JSON.stringify(portfolio)}`,
  );

  // The core acceptance criterion: aggregate long exposure never exceeds the
  // env-configured 20% cap (a one-share tolerance covers whole-share rounding).
  assert.ok(
    totalLongMarketValue <= cappedExposureNotional + SEED_PRICE,
    `expected aggregate exposure (${totalLongMarketValue}) to stay within the 20% cap (${cappedExposureNotional}) plus one-share tolerance`,
  );

  // Prove the cap -- not buying power or the per-symbol cap -- was the binding
  // constraint: those caps would each have allowed tens of thousands more dollars
  // of exposure (see comment above), so if the automated buy had been sized against
  // the old hardcoded 100 instead of the env-loaded 20, the resulting exposure would
  // have blown well past $20,000. The seed position alone already consumes $18,000,
  // so any additional buy at all only fits if it was capped far below what the other
  // limits would allow.
  const seedNotional = SEED_QTY * SEED_PRICE;
  const newBuyNotional = totalLongMarketValue - seedNotional;
  assert.ok(
    newBuyNotional < 72000,
    `expected the new buy's notional (${newBuyNotional}) to be far below what the per-symbol/buying-power caps alone would allow (72000), proving the portfolio exposure cap bound the trade`,
  );

  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  const trades = await tradesRes.json();
  const automatedBuys = trades.filter((tr: any) => tr.symbol === SYMBOL && tr.side === "buy" && tr.source === "automation");
  if (automatedBuys.length > 0) {
    assert.ok(
      automatedBuys[0].qty * automatedBuys[0].price <= cappedExposureNotional - seedNotional + SEED_PRICE,
      `expected the automated buy's own notional to fit within the remaining exposure room`,
    );
  }
  // If no automated buy trade exists, the intent was fully rejected by the cap --
  // also an acceptable outcome per the acceptance criterion ("shrinks or rejects").
});
