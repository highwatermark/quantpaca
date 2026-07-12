import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-buy-cap-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Configured broker (pattern: regimeMarketData.test.ts) -- a BUY needs a real
// deterministic price, which the simulated/unconfigured path only has for a
// symbol that already holds a simulated position. Every Alpaca host is
// intercepted below.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

// Three Gmail messages, each pitching a distinct ticker as a BUY -- this is
// what drives 3 BUY-decision signals through one sync cycle (guardrail 8's
// per-cycle cap only makes sense with more than MAX_BUYS_PER_CYCLE decisions
// in a single cycle).
const GMAIL_MESSAGES: Record<string, { symbol: string; subject: string }> = {
  m1: { symbol: "AONE", subject: "ZipTrader: AONE breakout thesis" },
  m2: { symbol: "BONE", subject: "ZipTrader: BONE accumulation thesis" },
  m3: { symbol: "CONE", subject: "ZipTrader: CONE momentum thesis" },
};

function gmailMessageFixture(id: string) {
  const { symbol, subject } = GMAIL_MESSAGES[id];
  const body = `Strong bullish thesis on ${symbol}: fundamentals accelerating, whipsaw-only pullback, high conviction entry.`;
  return {
    id,
    internalDate: String(Date.now()),
    snippet: body.slice(0, 100),
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "Subject", value: subject }],
      parts: [{ mimeType: "text/plain", body: { data: b64url(body) } }],
    },
  };
}

function fixtureMessageResponse(content: Array<{ type: "text"; text: string }>) {
  return new Response(
    JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-4-8",
      content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function buyFixtureFor(symbol: string) {
  return {
    symbol,
    growthScore: 90,
    sentimentScore: 90,
    riskProfile: "Medium",
    reasoning: `Strong thesis on ${symbol}.`,
    whipsawCheck: "This is a whipsaw -- volatility-driven, dip likely to recover.",
    whipsawVerdict: "whipsaw",
    decision: "BUY",
  };
}
const noneFixture = {
  symbol: "NONE", growthScore: 0, sentimentScore: 0, riskProfile: "Low",
  reasoning: "no thesis", whipsawCheck: "n/a", whipsawVerdict: "unclear", decision: "NONE",
};

function buildBar(daysAgo: number, close: number) {
  const t = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { t, o: close, h: close, l: close, c: close, v: 1000 };
}
function buildMildRiseBars(count = 60, start = 400, step = 0.05) {
  const bars = [];
  for (let i = 0; i < count; i++) bars.push(buildBar(count - 1 - i, start + i * step));
  return bars;
}
function barsResponse(bars: unknown[]) {
  return new Response(JSON.stringify({ bars, symbol: "X", next_page_token: null }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

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
      const promptText: string = body.messages?.[0]?.content ?? "";
      const matched = ["AONE", "BONE", "CONE"].find((sym) => promptText.includes(sym));
      const fixture = matched ? buyFixtureFor(matched) : noneFixture;
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(fixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "ZipTrader fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    if (url.includes("/messages?")) {
      return new Response(JSON.stringify({ messages: Object.keys(GMAIL_MESSAGES).map((id) => ({ id })) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const match = url.match(/\/messages\/([^?]+)\?/);
    const id = match?.[1];
    if (id && GMAIL_MESSAGES[id]) {
      return new Response(JSON.stringify(gmailMessageFixture(id)), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unhandled gmail path in test fixture", { status: 404 });
  }

  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/trades/latest")) {
      return new Response(JSON.stringify({ trade: { p: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/bars")) return barsResponse(buildMildRiseBars());
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: "100000", buying_power: "100000", portfolio_value: "100000", equity: "100000",
          last_equity: "100000", long_market_value: "0", daytrade_count: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/positions")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: `bro-${Math.random().toString(36).slice(2, 8)}`, status: "accepted", filled_qty: "0" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/assets/")) {
      // Phase 2 Task 3 tradability guard: always tradable/active here -- not
      // under test in this file.
      const symbol = url.split("/assets/")[1];
      return new Response(JSON.stringify({ symbol, tradable: true, status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled paper-api.alpaca.markets path in test fixture", { status: 404 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");

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

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN, Authorization: "Bearer test-oauth-token" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("guardrail 8: a cycle with 3 BUY-decision signals places only MAX_BUYS_PER_CYCLE (2) orders; the 3rd is logged and audited as capped", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  await setAutoTrading(port);
  const body = await runSync(port) as any;

  const buyDecisions = body.analyses.filter((a: any) => a.decision === "BUY");
  assert.equal(buyDecisions.length, 3, `expected all 3 theses to be analyzed as BUY, got: ${JSON.stringify(body.analyses)}`);

  const trades = await (await fetch(`http://127.0.0.1:${port}/api/trades`)).json() as any[];
  const buyTrades = trades.filter((tr) => tr.side === "buy");
  assert.equal(buyTrades.length, 2, `expected exactly 2 BUY orders placed, got: ${JSON.stringify(trades)}`);

  const placedSymbols = buyTrades.map((tr) => tr.symbol).sort();
  assert.deepEqual(placedSymbols, ["AONE", "BONE"], "the first 2 BUY decisions (Gmail message order) should be the ones placed");

  const messages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    messages.some((m) => /CONE/.test(m) && /per-cycle buy cap/i.test(m)),
    `expected a logged per-cycle-cap skip for CONE, got: ${JSON.stringify(messages)}`,
  );

  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`)).json() as any[];
  assert.ok(
    audit.some((e) => e.type === "risk" && /CONE/.test(e.message || "") && /per-cycle buy cap/i.test(e.message || "")),
    `expected an audit event recording the capped CONE BUY, got: ${JSON.stringify(audit.map((e) => e.message))}`,
  );
});
