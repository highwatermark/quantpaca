import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 2 Task 10 review fix 1: do-not-buy enforcement lives at the shared
// order chokepoint (executeTradeIntent, server.ts) -- the same place the
// per-symbol cooldown is enforced -- so it guards EVERY buy path (sync
// automation AND manual override), not just the sync decision loop. The
// deliberate human escape hatch is DELETE /api/do-not-buy/:symbol (admin,
// audited), not bypassing the check. Modeled on tests/symbolCooldown.test.ts.

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-donotbuy-chokepoint-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
// Force the simulated/unconfigured broker path deterministically, regardless of any
// real Alpaca credentials present in a local .env file (same reasoning as
// symbolCooldown.test.ts).
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";

const { app } = await import("../server");
const { createProductionStore } = await import("../src/server/persistence");

const ADMIN_TOKEN = "test-admin-token-0123456789";
const sqlitePath = path.join(dataDir, "quantpaca.sqlite");

async function placeOrder(port: number, body: { symbol: string; qty: number; side: "buy" | "sell"; price: number }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/override/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

function seedDoNotBuy(symbol: string, expiresAt: string, reason = "test: bearish thesis") {
  const store = createProductionStore(sqlitePath);
  store.saveDoNotBuy({ symbol, sourceId: "michael-burry", reason, expiresAt });
  store.close();
}

test("manual override BUY of a symbol on the do-not-buy list is RiskRejected with an audited reason naming the source and expiry", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedDoNotBuy("AVOIDME", expiresAt);

  const buy = await placeOrder(port, { symbol: "AVOIDME", qty: 1, side: "buy", price: 100 });
  assert.equal(buy.body.trade.status, "RiskRejected", `expected the chokepoint to reject the manual BUY, got: ${JSON.stringify(buy.body.trade)}`);
  assert.match(buy.body.trade.riskDecision.reason, /do-not-buy/i);
  assert.match(buy.body.trade.riskDecision.reason, /michael-burry/, "the audited reason must name the source");
  assert.ok(buy.body.trade.riskDecision.reason.includes(expiresAt), "the audited reason must name the expiry");

  // The rejection is audited through the same pipeline every other risk
  // rejection uses (submitTradeThroughPipeline's audit events).
  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.ok(
    audit.some((e) => e.entityId === buy.body.trade.id && /do-not-buy/i.test(JSON.stringify(e))),
    "expected an audit event for the rejected trade referencing the do-not-buy block",
  );
});

// Phase 2 final review, finding I1: /api/override/trade used to pass
// req.body.symbol RAW into executeTradeIntent, but the do-not-buy/cooldown
// lookups (and every other chokepoint check) compare case-SENSITIVELY
// against the uppercase symbols those lists are keyed on -- only
// submitTradeThroughPipeline's own validateSymbol normalized to uppercase,
// and only AFTER every chokepoint check above it had already run against the
// raw, un-normalized string. A lowercase symbol therefore sailed straight
// past the do-not-buy block.
test("a lowercase override BUY of a do-not-buy symbol is still rejected -- the chokepoint is case-insensitive", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedDoNotBuy("LOWERME", expiresAt);

  const buy = await placeOrder(port, { symbol: "lowerme", qty: 1, side: "buy", price: 100 });
  assert.equal(
    buy.body.trade.status,
    "RiskRejected",
    `expected the chokepoint to reject the lowercase manual BUY, got: ${JSON.stringify(buy.body.trade)}`,
  );
  assert.match(buy.body.trade.riskDecision.reason, /do-not-buy/i);
  assert.equal(buy.body.trade.symbol, "LOWERME", "the trade record itself must carry the canonical uppercase symbol");

  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.ok(
    audit.some((e) => e.entityId === buy.body.trade.id && /do-not-buy/i.test(JSON.stringify(e))),
    "expected an audit event for the rejected lowercase trade referencing the do-not-buy block",
  );
});

test("admin escape hatch: DELETE /api/do-not-buy/:symbol removes the entry (audited), after which the BUY proceeds", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  seedDoNotBuy("UNAVOID", new Date(Date.now() + 60 * 60 * 1000).toISOString());

  // Blocked before the delete.
  const blocked = await placeOrder(port, { symbol: "UNAVOID", qty: 1, side: "buy", price: 50 });
  assert.equal(blocked.body.trade.status, "RiskRejected");
  assert.match(blocked.body.trade.riskDecision.reason, /do-not-buy/i);

  // The delete route is admin-gated: no token -> rejected, entry survives.
  const noToken = await fetch(`http://127.0.0.1:${port}/api/do-not-buy/UNAVOID`, { method: "DELETE" });
  assert.ok(noToken.status === 401 || noToken.status === 403, `expected an auth rejection without the admin token, got ${noToken.status}`);

  const del = await fetch(`http://127.0.0.1:${port}/api/do-not-buy/UNAVOID`, {
    method: "DELETE",
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  assert.equal(del.status, 200);
  const delBody = await del.json() as any;
  assert.equal(delBody.removed, true);

  // The removal itself is audited.
  const audit = await (await fetch(`http://127.0.0.1:${port}/api/audit`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.ok(
    audit.some((e) => /UNAVOID/.test(e.message || "") && /do-not-buy/i.test(e.message || "") && /remov/i.test(e.message || "")),
    `expected an audit event recording the admin removal, got: ${JSON.stringify(audit.map((e: any) => e.message))}`,
  );

  // And the list no longer shows it.
  const list = await (await fetch(`http://127.0.0.1:${port}/api/do-not-buy`, { headers: { "x-admin-token": "test-admin-token-0123456789" } })).json() as any[];
  assert.equal(list.some((e) => e.symbol === "UNAVOID"), false);

  // A RiskRejected attempt never arms the cooldown (pre-existing behavior),
  // so this BUY exercises the now-clear chokepoint directly.
  const allowed = await placeOrder(port, { symbol: "UNAVOID", qty: 1, side: "buy", price: 50 });
  assert.equal(allowed.body.trade.status, "Accepted", `expected the BUY to proceed after the admin removal, got: ${JSON.stringify(allowed.body.trade)}`);
});

test("deleting a symbol that has no entry reports removed: false (idempotent, still 200)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const del = await fetch(`http://127.0.0.1:${port}/api/do-not-buy/NEVERWAS`, {
    method: "DELETE",
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  assert.equal(del.status, 200);
  const body = await del.json() as any;
  assert.equal(body.removed, false);
});

test("an expired do-not-buy entry does not block a manual BUY at the chokepoint", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  seedDoNotBuy("STALEDNB", new Date(Date.now() - 60_000).toISOString());

  const buy = await placeOrder(port, { symbol: "STALEDNB", qty: 1, side: "buy", price: 20 });
  assert.equal(buy.body.trade.status, "Accepted");
});

test("a SELL for a symbol on the do-not-buy list is never blocked by it -- de-risking always stays available", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Buy first (no entry yet), then list it, then sell.
  const buy = await placeOrder(port, { symbol: "DNBSELL", qty: 1, side: "buy", price: 10 });
  assert.equal(buy.body.trade.status, "Accepted");

  seedDoNotBuy("DNBSELL", new Date(Date.now() + 60 * 60 * 1000).toISOString());

  const sell = await placeOrder(port, { symbol: "DNBSELL", qty: 1, side: "sell", price: 10 });
  assert.equal(sell.body.trade.status, "Accepted", `a do-not-buy entry must never block a sell, got: ${JSON.stringify(sell.body.trade)}`);
});

test("a do-not-buy store read failure fails closed and rejects the BUY (not silently approved)", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // Break the table out from under the running server (same WAL-mode sqlite
  // file, second handle) -- pattern from symbolCooldown.test.ts. This is the
  // last test in this file using the shared app; the drop is one-way.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(sqlitePath);
  raw.exec("DROP TABLE do_not_buy");
  raw.close();

  const buy = await placeOrder(port, { symbol: "DNBFAIL", qty: 1, side: "buy", price: 15 });
  assert.equal(buy.body.trade.status, "RiskRejected");
  assert.match(buy.body.trade.riskDecision.reason, /do-not-buy/i);
});
