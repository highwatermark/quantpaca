import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 2 Task 7 (docs/GO_LIVE_PLAN.md Phase 2.3): "Scheduled position-level
// reconciliation" + "Mismatch halts buys" -- both Phase 2.3 checkboxes'
// acceptance sequence, end to end through the real HTTP API (pattern:
// tests/breakerLatchIntegration.test.ts, tests/orderStatusPolling.test.ts).

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-position-reconciliation-"));
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
const dbJsonPath = path.join(dataDir, "db.json");

// Mutable broker fixtures -- account stays healthy throughout (no drawdown
// breaker interplay under test here); `positionsFixture` is what GET
// /positions reports, deliberately independent of what's been traded so
// tests can inject real drift; `positionsShouldFail` flips GET /positions
// to a 500 to exercise the "positions-fetch failure -> skip, not drift" path.
let account = {
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

const sentTelegramMessages: string[] = [];

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
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentTelegramMessages.push(String(body.text || ""));
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
    // Every order (single GET by id, or the open-orders list) resolves as a
    // plain, still-"accepted" order with zero fill -- this file is not
    // exercising order-status polling (Task 5), so nothing here ever
    // transitions to Filled; computeExpectedPositions still counts an
    // Accepted BUY at its requested qty (brief's documented "else qty"
    // fallback), which is exactly what lets these tests seed a clean
    // expected-position baseline via a plain BUY.
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

function enableTelegram() {
  const raw = fs.existsSync(dbJsonPath) ? JSON.parse(fs.readFileSync(dbJsonPath, "utf8")) : {};
  raw.config = { ...(raw.config || {}), telegram: { botToken: "test-telegram-bot-token", chatId: "test-chat-id", enabled: true } };
  fs.mkdirSync(path.dirname(dbJsonPath), { recursive: true });
  fs.writeFileSync(dbJsonPath, JSON.stringify(raw, null, 2), "utf8");
}

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

async function resetBreaker(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/breaker/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ADMIN_TOKEN_HEADER },
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function acknowledge(port: number, symbol: string, qty: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/reconciliation/acknowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ADMIN_TOKEN_HEADER },
    body: JSON.stringify({ symbol, qty }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function auditEvents(port: number) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/audit`)).json()) as any[];
}

// `/api/override/trade` sends its OWN "MANUAL OVERRIDE" Telegram notification
// for every trade attempt, independent of reconciliation -- this filters the
// captured Telegram traffic down to just the reconciliation-mismatch alert
// under test, so BUY/SELL noise elsewhere in the test never pollutes the
// throttle/immediate-alert assertions.
function reconciliationAlertCount(): number {
  return sentTelegramMessages.filter((m) => /reconciliation mismatch/i.test(m)).length;
}

test("position reconciliation: injected drift latches block_new_buys, throttles/re-alerts correctly, and the full reset/acknowledge lifecycle behaves", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  enableTelegram();
  sentTelegramMessages.length = 0;
  positionsFixture = [];
  positionsShouldFail = false;

  // --- Step 1: clean baseline -----------------------------------------
  // A BUY for DRIFT (qty 10) reaches the broker; the broker mock is set to
  // agree with it BEFORE the next sync, so this cycle's comparison is clean.
  const buyDrift = await placeOrder(port, { symbol: "DRIFT", qty: 10, side: "buy", price: 50 });
  assert.equal(buyDrift.body.trade.status, "Accepted", JSON.stringify(buyDrift.body));
  positionsFixture = [{ symbol: "DRIFT", qty: "10" }];

  const syncClean = await runSync(port);
  assert.equal(syncClean.success, true, JSON.stringify(syncClean));

  const reportClean = await reconciliationLatest(port);
  assert.equal(reportClean.status, "matched", JSON.stringify(reportClean));
  assert.deepEqual(reportClean.mismatches, []);

  const breakerClean = await breakerLatest(port);
  assert.notEqual(breakerClean.status, "block_new_buys", JSON.stringify(breakerClean));
  assert.equal(reconciliationAlertCount(), 0, "no mismatch yet -- no reconciliation alert expected");

  // --- Step 2: inject drift (acceptance test 1: "injected drift in a test
  // produces a mismatch report") --------------------------------------
  // GHOST shows up on the broker with no matching local trade -- a manual
  // buy in the Alpaca UI, or an unknown fill (the brief's example: the
  // operator's own SGOV).
  positionsFixture = [{ symbol: "DRIFT", qty: "10" }, { symbol: "GHOST", qty: "15" }];

  const syncDrift = await runSync(port);
  assert.equal(syncDrift.success, true, JSON.stringify(syncDrift));

  const reportDrift = await reconciliationLatest(port);
  assert.equal(reportDrift.status, "mismatch", JSON.stringify(reportDrift));
  assert.equal(reportDrift.mismatches.length, 1);
  assert.equal(reportDrift.mismatches[0].type, "unexpected_position");
  assert.equal(reportDrift.mismatches[0].symbol, "GHOST");

  // Mismatch halts buys via the EXISTING breaker latch (acceptance test 2).
  const breakerDrift = await breakerLatest(port);
  assert.equal(breakerDrift.status, "block_new_buys", JSON.stringify(breakerDrift));
  assert.ok(
    breakerDrift.reasons.some((r: string) => /reconciliation_mismatch/.test(r)) ||
      (breakerDrift.latch?.latchedReasons || []).some((r: string) => /reconciliation_mismatch/.test(r)),
    `expected "reconciliation_mismatch" among the breaker reasons, got: ${JSON.stringify(breakerDrift)}`,
  );

  const auditAfterDrift = await auditEvents(port);
  const tripEvent = auditAfterDrift.find((e) => e.type === "breaker" && /tripped|latch/i.test(e.message));
  assert.ok(tripEvent, `expected a breaker trip audit event, got: ${JSON.stringify(auditAfterDrift.slice(0, 5))}`);
  const reconciliationAuditEvent = auditAfterDrift.find((e) => e.actor === "position_reconciliation" && e.type === "sync");
  assert.ok(reconciliationAuditEvent, `expected a position_reconciliation audit event with details, got: ${JSON.stringify(auditAfterDrift.slice(0, 5))}`);
  assert.ok(reconciliationAuditEvent.details?.mismatches?.length === 1);

  assert.equal(reconciliationAlertCount(), 1, "expected exactly one Telegram alert for the newly-detected mismatch");

  // --- Step 3: next BUY rejected while a SELL passes --------------------
  const buyBlocked = await placeOrder(port, { symbol: "BLOCKED", qty: 1, side: "buy", price: 50 });
  assert.equal(buyBlocked.body.trade.status, "RiskRejected", JSON.stringify(buyBlocked.body));
  assert.match(buyBlocked.body.trade.riskDecision.reason, /block_new_buys/);

  const sellPasses = await placeOrder(port, { symbol: "NEUTRAL", qty: 1, side: "sell", price: 50 });
  assert.equal(sellPasses.body.trade.status, "Accepted", JSON.stringify(sellPasses.body));

  // --- Step 4: the SAME mismatch persists -- throttled, no new alert ----
  const syncPersist = await runSync(port);
  assert.equal(syncPersist.success, true);
  const reportPersist = await reconciliationLatest(port);
  assert.equal(reportPersist.status, "mismatch");
  assert.equal(reconciliationAlertCount(), 1, "the persisting mismatch must stay throttled (no second alert within the window)");

  // --- Step 5: a NEW/different mismatch alerts immediately --------------
  positionsFixture = [{ symbol: "DRIFT", qty: "10" }, { symbol: "GHOST", qty: "15" }, { symbol: "GHOST2", qty: "3" }];
  const syncNewMismatch = await runSync(port);
  assert.equal(syncNewMismatch.success, true);
  const reportNewMismatch = await reconciliationLatest(port);
  assert.equal(reportNewMismatch.mismatches.length, 2, JSON.stringify(reportNewMismatch));
  assert.equal(reconciliationAlertCount(), 2, "a new/different mismatch must alert immediately, bypassing the throttle window");

  // --- Step 6: reset while still drifted -- clears immediately (reset only
  // re-evaluates the drawdown breaker, which is healthy); the NEXT
  // comparison (not the reset call itself) is what re-latches. ------------
  const resetWhileDrifted = await resetBreaker(port);
  assert.equal(resetWhileDrifted.status, 200);
  assert.equal(resetWhileDrifted.body.status, "ok", JSON.stringify(resetWhileDrifted.body));
  const breakerAfterReset = await breakerLatest(port);
  assert.notEqual(breakerAfterReset.status, "block_new_buys");

  // --- Step 7: mismatch still present -> the NEXT comparison re-latches -
  const syncAfterReset = await runSync(port);
  assert.equal(syncAfterReset.success, true);
  const breakerReLatched = await breakerLatest(port);
  assert.equal(breakerReLatched.status, "block_new_buys", "the mismatch is still present, so the next comparison must re-latch");

  const buyStillBlocked = await placeOrder(port, { symbol: "STILLBLOCKED", qty: 1, side: "buy", price: 50 });
  assert.equal(buyStillBlocked.body.trade.status, "RiskRejected", "reset while still drifted must re-latch, not clear");

  // --- Step 8: acknowledge route -> next comparison clean, but the latch
  // stays sticky (no auto-unlatch on a clean comparison) ------------------
  const ackGhost = await acknowledge(port, "GHOST", 15);
  assert.equal(ackGhost.status, 200, JSON.stringify(ackGhost.body));
  const ackGhost2 = await acknowledge(port, "GHOST2", 3);
  assert.equal(ackGhost2.status, 200, JSON.stringify(ackGhost2.body));

  const syncAfterAck = await runSync(port);
  assert.equal(syncAfterAck.success, true);
  const reportAfterAck = await reconciliationLatest(port);
  assert.equal(reportAfterAck.status, "matched", JSON.stringify(reportAfterAck));

  const breakerAfterAck = await breakerLatest(port);
  assert.equal(breakerAfterAck.status, "block_new_buys", "acknowledging alone must not auto-unlatch the sticky breaker latch");

  const buyStillBlockedAfterAck = await placeOrder(port, { symbol: "STILLBLOCKED2", qty: 1, side: "buy", price: 50 });
  assert.equal(buyStillBlockedAfterAck.body.trade.status, "RiskRejected", "acknowledging alone must not unblock buys -- a human reset is required");

  // --- Step 9: after reset (comparison already clean), BUYs flow ---------
  const finalReset = await resetBreaker(port);
  assert.equal(finalReset.body.status, "ok", JSON.stringify(finalReset.body));

  const buyFlows = await placeOrder(port, { symbol: "FLOWS", qty: 1, side: "buy", price: 50 });
  assert.equal(buyFlows.body.trade.status, "Accepted", JSON.stringify(buyFlows.body));
});
