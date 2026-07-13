import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-pdt-integration-test-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";
// A CONFIGURED broker is required: daytrade_count/equity flow from the real
// GET /v2/account response into reviewRisk's PDT check.
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";

// Fixture account state; mutated per test to exercise the PDT boundary.
let accountFixture = { equity: "100000", last_equity: "100000", buying_power: "100000", daytrade_count: 0 };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.includes("/assets/")) {
      // Not under test here -- always tradable so the tradability guard never
      // interferes with the PDT assertions below.
      const symbol = url.split("/assets/")[1];
      return new Response(JSON.stringify({ symbol, tradable: true, status: "active" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/account")) {
      return new Response(
        JSON.stringify({
          cash: accountFixture.equity,
          buying_power: accountFixture.buying_power,
          portfolio_value: accountFixture.equity,
          equity: accountFixture.equity,
          last_equity: accountFixture.last_equity,
          long_market_value: "0",
          daytrade_count: accountFixture.daytrade_count,
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
      return new Response(
        JSON.stringify({ id: `bro-${Math.random().toString(36).slice(2, 8)}`, status: "accepted", filled_qty: "0" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("fixture account with equity < $25k and daytrade_count 3 -> the 4th would-be day trade (a new BUY) is blocked with an audited PDT reason", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  accountFixture = { equity: "20000", last_equity: "20000", buying_power: "20000", daytrade_count: 3 };

  const result = await placeOrder(port, { symbol: "PDTSYM", qty: 1, side: "buy", price: 50 });
  assert.equal(result.body.trade.status, "RiskRejected");
  assert.match(result.body.trade.riskDecision.reason, /PDT guard/i);
});

test("fixture account with equity < $25k and daytrade_count 3 -> a SELL still proceeds (never blocked by PDT)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  accountFixture = { equity: "20000", last_equity: "20000", buying_power: "20000", daytrade_count: 3 };

  const result = await placeOrder(port, { symbol: "PDTSELL", qty: 1, side: "sell", price: 50 });
  assert.equal(result.body.trade.status, "Accepted");
});

test("fixture account with equity >= $25k and daytrade_count 3 -> the BUY is approved (PDT rule doesn't apply)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  accountFixture = { equity: "30000", last_equity: "30000", buying_power: "30000", daytrade_count: 3 };

  const result = await placeOrder(port, { symbol: "PDTOK", qty: 1, side: "buy", price: 50 });
  assert.equal(result.body.trade.status, "Accepted");
});
