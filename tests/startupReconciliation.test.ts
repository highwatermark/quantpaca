// Phase 2 Task 6 (docs/GO_LIVE_PLAN.md Phase 2.2): startup reconciliation --
// boot safety so a crash mid-order can never lead to trading on unknown
// state. Unit-level tests against the module's pure/injectable functions,
// same style as tests/scheduler.test.ts (fake deps, no real timers, no
// server boot). See tests/startupReconciliationIntegration.test.ts for the
// full-server acceptance/orphan/admin-route tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECONCILIATION_RETRY_INTERVAL_MS,
  RECONCILIATION_MAX_RETRY_ATTEMPTS,
  STARTUP_ORPHANS_APP_STATE_KEY,
  detectOrphanOrders,
  fetchOpenBrokerOrders,
  attemptStartupReconciliation,
  runStartupReconciliation,
  isTradingReady,
  hasUnresolvedOrphans,
  getOrphanOrders,
  buyGateRejectionReason,
  clearOrphans,
  __setStateForTest,
  StartupReconciliationDeps,
} from "../src/server/startupReconciliation";
import { PipelineTrade } from "../src/server/tradingSafety";

const BROKER_CONFIG = {
  configured: true,
  tradingMode: "paper" as const,
  liveTradingEnabled: false,
  baseUrl: "https://paper-api.alpaca.markets/v2",
  apiKey: "test-key",
  secretKey: "test-secret",
};

function makeTrade(overrides: Partial<PipelineTrade> = {}): PipelineTrade {
  return {
    id: overrides.id || `tr-${Math.random().toString(36).slice(2, 8)}`,
    symbol: "ACME",
    qty: 1,
    price: 100,
    side: "buy",
    status: "Accepted",
    timestamp: new Date().toISOString(),
    reasoning: "test fixture",
    notifiedTelegram: false,
    exportedSheets: false,
    loggedNotion: false,
    source: "manual",
    ...overrides,
  } as PipelineTrade;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- Named constants ---

test("named constants match the brief's binding values", () => {
  assert.equal(RECONCILIATION_RETRY_INTERVAL_MS, 5 * 60_000);
  assert.equal(RECONCILIATION_MAX_RETRY_ATTEMPTS, 12);
  assert.equal(typeof STARTUP_ORPHANS_APP_STATE_KEY, "string");
  assert.ok(STARTUP_ORPHANS_APP_STATE_KEY.length > 0);
});

// --- detectOrphanOrders (pure) ---

test("detectOrphanOrders: an open order matching a local trade's brokerOrderId is NOT an orphan", () => {
  const trades = [makeTrade({ brokerOrderId: "bro-1" })];
  const openOrders = [{ id: "bro-1", clientOrderId: "qp-abc" }];
  assert.deepEqual(detectOrphanOrders(openOrders, trades), []);
});

test("detectOrphanOrders: an open order matching a local trade's clientOrderId is NOT an orphan", () => {
  const trades = [makeTrade({ brokerOrderId: "bro-other", clientOrderId: "qp-abc" })];
  const openOrders = [{ id: "bro-1", clientOrderId: "qp-abc" }];
  assert.deepEqual(detectOrphanOrders(openOrders, trades), []);
});

test("detectOrphanOrders: an open order matching a bracket leg id is NOT an orphan", () => {
  const trades = [makeTrade({ brokerOrderId: "bro-entry", brokerLegOrderIds: ["leg-tp", "leg-sl"] })];
  const openOrders = [{ id: "leg-tp" }, { id: "leg-sl" }];
  assert.deepEqual(detectOrphanOrders(openOrders, trades), []);
});

test("detectOrphanOrders: an open order with no matching local id or client_order_id IS an orphan", () => {
  const trades = [makeTrade({ brokerOrderId: "bro-1" })];
  const openOrders = [{ id: "bro-1" }, { id: "manual-order-9", clientOrderId: "not-ours" }];
  const orphans = detectOrphanOrders(openOrders, trades);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, "manual-order-9");
});

test("detectOrphanOrders: empty local trades -> every open order is an orphan", () => {
  const openOrders = [{ id: "a" }, { id: "b" }];
  assert.equal(detectOrphanOrders(openOrders, []).length, 2);
});

// --- fetchOpenBrokerOrders (I/O, injected fetch) ---

test("fetchOpenBrokerOrders: maps a well-formed array response", async () => {
  const fetchImpl = (async () =>
    jsonResponse([{ id: "o1", client_order_id: "qp-x", symbol: "ACME", qty: "1", side: "buy", status: "accepted" }])) as unknown as typeof fetch;
  const result = await fetchOpenBrokerOrders({ brokerConfig: BROKER_CONFIG, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.orders?.length, 1);
  assert.equal(result.orders?.[0].clientOrderId, "qp-x");
});

test("fetchOpenBrokerOrders: non-OK HTTP status -> ok:false, never throws", async () => {
  const fetchImpl = (async () => jsonResponse({ message: "outage" }, 500)) as unknown as typeof fetch;
  const result = await fetchOpenBrokerOrders({ brokerConfig: BROKER_CONFIG, fetchImpl });
  assert.equal(result.ok, false);
  assert.ok(result.errorMessage);
});

test("fetchOpenBrokerOrders: a non-array body -> ok:false", async () => {
  const fetchImpl = (async () => jsonResponse({ not: "an array" })) as unknown as typeof fetch;
  const result = await fetchOpenBrokerOrders({ brokerConfig: BROKER_CONFIG, fetchImpl });
  assert.equal(result.ok, false);
});

test("fetchOpenBrokerOrders: a network throw -> ok:false, never throws", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await fetchOpenBrokerOrders({ brokerConfig: BROKER_CONFIG, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.errorMessage || "", /ECONNREFUSED/);
});

// --- attemptStartupReconciliation (single attempt, I/O) ---

function makeFetchImpl(input: {
  orders: Record<string, { status: string; filled_qty?: string }>;
  openOrders: Array<{ id: string; client_order_id?: string; symbol?: string; qty?: string; side?: string; status?: string }>;
  openOrdersFail?: boolean;
  orderPollFailFor?: Set<string>;
}) {
  return (async (url: any) => {
    const u = String(url);
    if (u.includes("/orders?status=open")) {
      if (input.openOrdersFail) return jsonResponse({ message: "simulated outage" }, 500);
      return jsonResponse(input.openOrders);
    }
    const match = u.match(/\/orders\/([^/?]+)/);
    if (match) {
      const orderId = decodeURIComponent(match[1]);
      if (input.orderPollFailFor?.has(orderId)) return jsonResponse({ message: "outage" }, 500);
      const order = input.orders[orderId];
      if (!order) return jsonResponse({ message: "not found" }, 404);
      return jsonResponse({ id: orderId, status: order.status, filled_qty: order.filled_qty ?? "0", type: "market" });
    }
    return jsonResponse({ message: "unhandled" }, 404);
  }) as unknown as typeof fetch;
}

test("attemptStartupReconciliation: recovers an Accepted trade whose broker order is now filled (the acceptance scenario)", async () => {
  const trade = makeTrade({ id: "tr-recover", brokerOrderId: "bro-recover", status: "Accepted", qty: 5 });
  const saved: PipelineTrade[] = [];
  const fetchImpl = makeFetchImpl({
    orders: { "bro-recover": { status: "filled", filled_qty: "5" } },
    openOrders: [],
  });

  const result = await attemptStartupReconciliation({
    brokerConfig: BROKER_CONFIG,
    fetchImpl,
    listTrades: () => [trade],
    saveTrade: (t) => saved.push(t),
    cancelOrder: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.polledCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.orphans.length, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "Filled");
});

test("attemptStartupReconciliation: an unmatched open broker order is reported as an orphan", async () => {
  const trade = makeTrade({ id: "tr-known", brokerOrderId: "bro-known", status: "Accepted" });
  const fetchImpl = makeFetchImpl({
    orders: { "bro-known": { status: "accepted", filled_qty: "0" } },
    openOrders: [
      { id: "bro-known" },
      { id: "bro-orphan", client_order_id: "not-ours-123", symbol: "XYZ", qty: "3", side: "buy", status: "new" },
    ],
  });

  const result = await attemptStartupReconciliation({
    brokerConfig: BROKER_CONFIG,
    fetchImpl,
    listTrades: () => [trade],
    saveTrade: () => {},
    cancelOrder: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].id, "bro-orphan");
});

test("attemptStartupReconciliation: a per-order poll failure fails the whole attempt closed", async () => {
  const trade = makeTrade({ id: "tr-fail", brokerOrderId: "bro-fail", status: "Accepted" });
  const fetchImpl = makeFetchImpl({
    orders: {},
    openOrders: [],
    orderPollFailFor: new Set(["bro-fail"]),
  });

  const result = await attemptStartupReconciliation({
    brokerConfig: BROKER_CONFIG,
    fetchImpl,
    listTrades: () => [trade],
    saveTrade: () => {},
    cancelOrder: async () => ({ ok: true }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.errorLogs.length > 0);
});

test("attemptStartupReconciliation: the orphan-sweep fetch failing fails the whole attempt closed even though the poll itself succeeded", async () => {
  const fetchImpl = makeFetchImpl({ orders: {}, openOrders: [], openOrdersFail: true });

  const result = await attemptStartupReconciliation({
    brokerConfig: BROKER_CONFIG,
    fetchImpl,
    listTrades: () => [],
    saveTrade: () => {},
    cancelOrder: async () => ({ ok: true }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.errorLogs.some((l) => /open-orders fetch failed/i.test(l)));
});

// --- runStartupReconciliation: full orchestration + module-scoped state ---

function makeOrchestratorDeps(overrides: Partial<StartupReconciliationDeps> = {}): {
  deps: StartupReconciliationDeps;
  state: {
    logs: string[];
    audits: unknown[];
    telegramMessages: string[];
    persistedOrphans: unknown[];
    timers: Array<{ cb: () => void; ms: number }>;
    clearedTimers: unknown[];
  };
} {
  const state = {
    logs: [] as string[],
    audits: [] as unknown[],
    telegramMessages: [] as string[],
    persistedOrphans: [] as unknown[],
    timers: [] as Array<{ cb: () => void; ms: number }>,
    clearedTimers: [] as unknown[],
  };
  const deps: StartupReconciliationDeps = {
    brokerConfig: BROKER_CONFIG,
    fetchImpl: makeFetchImpl({ orders: {}, openOrders: [] }),
    listTrades: () => [],
    saveTrade: () => {},
    cancelOrder: async () => ({ ok: true }),
    appendAuditEvents: (events) => state.audits.push(...events),
    persistOrphans: (orphans) => state.persistedOrphans.push(orphans),
    sendTelegramAlert: async (message: string) => {
      state.telegramMessages.push(message);
    },
    log: (message) => state.logs.push(message),
    setTimer: (cb, ms) => {
      state.timers.push({ cb, ms });
      return state.timers.length;
    },
    clearTimer: (handle) => state.clearedTimers.push(handle),
    ...overrides,
  };
  return { deps, state };
}

test("runStartupReconciliation: broker not configured -> tradingReady immediately, no orphans, no telegram alert", async () => {
  __setStateForTest({ tradingReady: false, orphanOrders: [] });
  const { deps, state } = makeOrchestratorDeps({ brokerConfig: { ...BROKER_CONFIG, configured: false } });

  await runStartupReconciliation(deps);

  assert.equal(isTradingReady(), true);
  assert.equal(hasUnresolvedOrphans(), false);
  assert.equal(state.telegramMessages.length, 0);
  assert.ok(state.logs.some((l) => /skipped/i.test(l)));
});

test("runStartupReconciliation: success with no orphans -> tradingReady true, audit summary, no telegram alert", async () => {
  __setStateForTest({ tradingReady: false, orphanOrders: [] });
  const trade = makeTrade({ id: "tr-a", brokerOrderId: "bro-a", status: "Accepted" });
  const { deps, state } = makeOrchestratorDeps({
    fetchImpl: makeFetchImpl({ orders: { "bro-a": { status: "filled", filled_qty: "1" } }, openOrders: [{ id: "bro-a" }] }),
    listTrades: () => [trade],
  });

  await runStartupReconciliation(deps);

  assert.equal(isTradingReady(), true);
  assert.equal(hasUnresolvedOrphans(), false);
  assert.equal(state.telegramMessages.length, 0);
  assert.ok(
    state.audits.some((e: any) => /startup reconciliation complete/i.test(e.message) && /1 orders polled/.test(e.message) && /1 updated/.test(e.message) && /0 orphans/.test(e.message)),
    `expected a completion audit event, got: ${JSON.stringify(state.audits)}`,
  );
});

test("runStartupReconciliation acceptance test: an Accepted trade whose broker order is now filled is recovered into local state on restart, and tradingReady becomes true", async () => {
  __setStateForTest({ tradingReady: false, orphanOrders: [] });
  const trade = makeTrade({ id: "tr-boot", brokerOrderId: "bro-boot", status: "Accepted", qty: 3 });
  const saved: PipelineTrade[] = [];
  const { deps } = makeOrchestratorDeps({
    fetchImpl: makeFetchImpl({ orders: { "bro-boot": { status: "filled", filled_qty: "3" } }, openOrders: [] }),
    listTrades: () => [trade],
    saveTrade: (t) => saved.push(t),
  });

  assert.equal(isTradingReady(), false, "precondition: reconciliation has not run yet");
  await runStartupReconciliation(deps);

  assert.equal(saved.some((t) => t.id === "tr-boot" && t.status === "Filled"), true, "the pre-crash Accepted trade must be recovered to Filled");
  assert.equal(isTradingReady(), true);
});

test("runStartupReconciliation: orphans found -> tradingReady true, BUYs blocked, sells exempt, telegram alerted, admin clear unblocks", async () => {
  __setStateForTest({ tradingReady: false, orphanOrders: [] });
  const { deps, state } = makeOrchestratorDeps({
    fetchImpl: makeFetchImpl({ orders: {}, openOrders: [{ id: "bro-orphan", client_order_id: "unknown-order", symbol: "XYZ" }] }),
    listTrades: () => [],
  });

  await runStartupReconciliation(deps);

  assert.equal(isTradingReady(), true);
  assert.equal(hasUnresolvedOrphans(), true);
  assert.equal(getOrphanOrders().length, 1);
  assert.equal(state.telegramMessages.length, 1);
  assert.match(state.telegramMessages[0], /orphan/i);

  const buyReason = buyGateRejectionReason("buy");
  assert.ok(buyReason && /orphan/i.test(buyReason), `expected an orphan-mentioning rejection reason, got: ${buyReason}`);
  assert.equal(buyGateRejectionReason("sell"), undefined, "sells must never be blocked by orphans");

  const cleared = clearOrphans();
  assert.equal(cleared.length, 1);
  assert.equal(hasUnresolvedOrphans(), false);
  assert.equal(buyGateRejectionReason("buy"), undefined, "BUYs unblock once orphans are cleared");
});

test("runStartupReconciliation: fetch failure keeps tradingReady false, BUY rejected with an honest reason, SELL allowed; a retry succeeds and flips ready", async () => {
  __setStateForTest({ tradingReady: false, orphanOrders: [] });
  let shouldFail = true;
  const { deps, state } = makeOrchestratorDeps({
    fetchImpl: (async (url: any) => {
      if (shouldFail) return jsonResponse({ message: "simulated outage" }, 500);
      return makeFetchImpl({ orders: {}, openOrders: [] })(url as any, undefined as any);
    }) as unknown as typeof fetch,
    listTrades: () => [],
  });

  await runStartupReconciliation(deps);

  assert.equal(isTradingReady(), false);
  const pendingReason = buyGateRejectionReason("buy");
  assert.ok(pendingReason && /pending/i.test(pendingReason));
  assert.equal(buyGateRejectionReason("sell"), undefined, "sells stay available while reconciliation is pending");

  assert.equal(state.timers.length, 1, "a retry must be scheduled");
  assert.equal(state.timers[0].ms, RECONCILIATION_RETRY_INTERVAL_MS);

  shouldFail = false;
  state.timers[0].cb();
  // The retry callback is async (fire-and-forget from setTimer's perspective);
  // give it a tick to resolve before asserting the post-retry state.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(isTradingReady(), true);
  assert.equal(buyGateRejectionReason("buy"), undefined);
});

test("runStartupReconciliation: after RECONCILIATION_MAX_RETRY_ATTEMPTS consecutive failures, it gives up, alerts Telegram once, and stays blocked", async () => {
  __setStateForTest({ tradingReady: false, orphanOrders: [] });
  const { deps, state } = makeOrchestratorDeps({
    fetchImpl: (async () => jsonResponse({ message: "permanent outage" }, 500)) as unknown as typeof fetch,
    listTrades: () => [],
  });

  await runStartupReconciliation(deps);
  assert.equal(state.timers.length, 1);

  for (let attempt = 2; attempt <= RECONCILIATION_MAX_RETRY_ATTEMPTS; attempt++) {
    const timer = state.timers[state.timers.length - 1];
    timer.cb();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(isTradingReady(), false, "still blocked after exhausting every retry");
  assert.equal(
    state.timers.length,
    RECONCILIATION_MAX_RETRY_ATTEMPTS - 1,
    "no further retry is scheduled once the attempt cap is reached",
  );
  assert.equal(state.telegramMessages.length, 1, "exactly one give-up alert");
  assert.match(state.telegramMessages[0], /failed/i);
  assert.equal(buyGateRejectionReason("buy") !== undefined, true);
  assert.equal(buyGateRejectionReason("sell"), undefined);
});
