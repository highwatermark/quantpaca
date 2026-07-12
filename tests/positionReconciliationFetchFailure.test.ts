import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3): "absence of data is never
// drift" -- isolated in its own file/dataDir (pattern: every other test file
// in this suite) so a positions-fetch failure is checked against a
// completely clean reconciliation/breaker history, not one carrying residue
// from an unrelated scenario.

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-position-reconciliation-fetch-failure-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const ADMIN_TOKEN_HEADER = { "x-admin-token": ADMIN_TOKEN };

const account = {
  cash: "500000",
  buying_power: "500000",
  portfolio_value: "500000",
  equity: "100000",
  last_equity: "100000",
  long_market_value: "0",
  daytrade_count: 0,
};
let positionsFixture: Array<{ symbol: string; qty: string }> = [];
let positionsShouldFail = false;
let orderCounter = 0;

const NONE_ANALYSIS = {
  symbol: "NONE",
  growthScore: 0,
  sentimentScore: 0,
  riskProfile: "Low",
  reasoning: "no thesis this cycle",
  whipsawCheck: "n/a",
  whipsawVerdict: "unclear",
  decision: "NONE",
};

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
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    if (body.output_config) {
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(NONE_ANALYSIS) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    return new Response("Gmail should never be called in this test file (no Authorization header sent).", { status: 500 });
  }

  if (url.includes("api.telegram.org")) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (url.includes("data.alpaca.markets")) {
    if (url.includes("/trades/latest")) {
      return new Response(JSON.stringify({ trade: { p: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/bars")) {
      return new Response(JSON.stringify({ bars: [], symbol: "X", next_page_token: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled data.alpaca.markets path in test fixture", { status: 404 });
  }

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.endsWith("/account")) {
      return new Response(JSON.stringify(account), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/positions")) {
      if (positionsShouldFail) {
        return new Response(JSON.stringify({ message: "simulated Alpaca positions outage" }), { status: 500 });
      }
      return new Response(JSON.stringify(positionsFixture), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/orders") && init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      orderCounter += 1;
      return new Response(
        JSON.stringify({ id: `bro-${orderCounter}`, status: "accepted", filled_qty: "0", client_order_id: body.client_order_id }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/assets/")) {
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

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ADMIN_TOKEN_HEADER },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ADMIN_TOKEN_HEADER },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  return res.json() as Promise<any>;
}

async function reconciliationLatest(port: number) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/reconciliation/latest`)).json()) as any;
}

async function breakerLatest(port: number) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/breaker/latest`)).json()) as any;
}

test("position reconciliation: a positions-fetch failure is skipped and logged, never treated as drift -- latch state and the latest report are both unchanged", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  positionsFixture = [{ symbol: "STABLE", qty: "5" }];
  positionsShouldFail = false;

  const buyStable = await placeOrder(port, { symbol: "STABLE", qty: 5, side: "buy", price: 20 });
  assert.equal(buyStable.body.trade.status, "Accepted", JSON.stringify(buyStable.body));

  const syncClean = await runSync(port);
  assert.equal(syncClean.success, true);
  const reportBefore = await reconciliationLatest(port);
  assert.equal(reportBefore.status, "matched");
  const breakerBefore = await breakerLatest(port);
  assert.notEqual(breakerBefore.status, "block_new_buys");

  // Now the positions fetch starts failing.
  positionsShouldFail = true;
  const syncFailed = await runSync(port);
  assert.equal(syncFailed.success, true, "a positions-fetch failure must not fail the whole sync cycle");

  const logMessages: string[] = (syncFailed.logs || []).map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /[Pp]osition reconciliation skipped/.test(m)),
    `expected a "position reconciliation skipped" log line, got: ${JSON.stringify(logMessages)}`,
  );

  // No new claims: the latest persisted report is UNCHANGED (still the
  // earlier clean one, same id), and the breaker latch is untouched.
  const reportAfter = await reconciliationLatest(port);
  assert.equal(reportAfter.id, reportBefore.id, "a fetch failure must not persist a new (fabricated) reconciliation report");
  const breakerAfter = await breakerLatest(port);
  assert.notEqual(breakerAfter.status, "block_new_buys", "a positions-fetch failure must never be treated as drift");

  positionsShouldFail = false;
});
