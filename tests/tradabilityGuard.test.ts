import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-tradability-test-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Cooldown disabled: this file exercises repeated BUYs for the same symbol
// (the cache assertion) which the symbol-cooldown guard would otherwise block
// as "requires_human_approval", unrelated to what's under test here.
process.env.QUANTPACA_SYMBOL_COOLDOWN_HOURS = "0";
// A CONFIGURED broker is required: the tradability guard only ever fetches
// GET /v2/assets/{symbol} when a broker is configured (mirrors the market-hours
// clock check's precedent -- an unconfigured/simulated broker has no Alpaca
// asset endpoint to check against, so the guard is skipped entirely there).
process.env.ALPACA_API_KEY = "test-alpaca-key";
process.env.ALPACA_SECRET_KEY = "test-alpaca-secret";
process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";

const ADMIN_TOKEN = "test-admin-token-0123456789";

type AssetMode = "tradable" | "not_tradable" | "fail" | "throw";
const assetFixtures: Record<string, AssetMode> = {};
const assetRequestCounts: Record<string, number> = {};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("paper-api.alpaca.markets")) {
    if (url.includes("/assets/")) {
      const symbol = url.split("/assets/")[1];
      assetRequestCounts[symbol] = (assetRequestCounts[symbol] || 0) + 1;
      const mode = assetFixtures[symbol] || "tradable";
      if (mode === "fail") return new Response("simulated asset lookup failure", { status: 500 });
      if (mode === "throw") throw new Error("simulated network/timeout failure");
      return new Response(
        JSON.stringify({ symbol, tradable: mode === "tradable", status: mode === "tradable" ? "active" : "inactive" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
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

test("BUY for a symbol whose asset check reports tradable=false is rejected with an audited tradability reason", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  assetFixtures["HALTED"] = "not_tradable";

  const result = await placeOrder(port, { symbol: "HALTED", qty: 1, side: "buy", price: 50 });
  assert.equal(result.body.trade.status, "RiskRejected");
  assert.match(result.body.trade.riskDecision.reason, /tradability/i);
});

test("BUY for a symbol whose asset check returns HTTP 500 is rejected (fail closed)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  assetFixtures["ERR500"] = "fail";

  const result = await placeOrder(port, { symbol: "ERR500", qty: 1, side: "buy", price: 50 });
  assert.equal(result.body.trade.status, "RiskRejected");
  assert.match(result.body.trade.riskDecision.reason, /tradability/i);
});

test("BUY for a symbol whose asset check throws/times out is rejected (fail closed)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  assetFixtures["TMOUT"] = "throw";

  const result = await placeOrder(port, { symbol: "TMOUT", qty: 1, side: "buy", price: 50 });
  assert.equal(result.body.trade.status, "RiskRejected");
  assert.match(result.body.trade.riskDecision.reason, /tradability/i);
});

test("SELL for a not-tradable symbol proceeds -- the guard is BUY-only", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  assetFixtures["HALTSEL"] = "not_tradable";

  const result = await placeOrder(port, { symbol: "HALTSEL", qty: 1, side: "sell", price: 50 });
  assert.equal(result.body.trade.status, "Accepted");
  assert.equal(assetRequestCounts["HALTSEL"] || 0, 0, "the asset tradability check must never be called for a SELL");
});

test("a second BUY for a tradable symbol reuses the 24h positive cache -- exactly one asset request across two orders", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  assetFixtures["CACHED"] = "tradable";

  const first = await placeOrder(port, { symbol: "CACHED", qty: 1, side: "buy", price: 10 });
  assert.equal(first.body.trade.status, "Accepted");

  const second = await placeOrder(port, { symbol: "CACHED", qty: 1, side: "buy", price: 10 });
  assert.equal(second.body.trade.status, "Accepted");

  assert.equal(assetRequestCounts["CACHED"], 1, `expected exactly one /assets request across two BUY cycles, got ${assetRequestCounts["CACHED"]}`);
});
