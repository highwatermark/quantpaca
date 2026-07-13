// Phase 2 final review, finding I4: UnknownBrokerState (the fail-closed
// default mapBrokerStatusToTradeState maps every unrecognized broker status
// to) had no direct unit coverage, and fetchBrokerOrder's catch path (a
// fetchImpl that THROWS, e.g. an AbortError on a timed-out request) was only
// ever exercised indirectly via an HTTP 500 response in
// tests/orderStatusPolling.test.ts -- a genuinely thrown error is a
// different code path (the try/catch's `catch` block, not the `!res.ok`
// branch) and deserves its own coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchBrokerOrder, pollPendingOrders } from "../src/server/orderStatusPoller";
import { mapBrokerStatusToTradeState, PipelineTrade } from "../src/server/tradingSafety";

test("mapBrokerStatusToTradeState: every unrecognized/unknown broker status maps to UnknownBrokerState, never Filled", () => {
  for (const status of ["something_new", "held", "suspended", "", "FILLEDX", "unknown", undefined] as Array<string | undefined>) {
    const mapped = mapBrokerStatusToTradeState(status);
    assert.equal(mapped, "UnknownBrokerState", `expected UnknownBrokerState for status ${JSON.stringify(status)}, got ${mapped}`);
    assert.notEqual(mapped, "Filled", `an unrecognized broker status must never be mapped to Filled (status: ${JSON.stringify(status)})`);
  }
});

test("mapBrokerStatusToTradeState: every KNOWN status still maps correctly (sanity, so the default-branch test above isn't accidentally testing a no-op)", () => {
  assert.equal(mapBrokerStatusToTradeState("accepted"), "Accepted");
  assert.equal(mapBrokerStatusToTradeState("new"), "Accepted");
  assert.equal(mapBrokerStatusToTradeState("pending_new"), "Accepted");
  assert.equal(mapBrokerStatusToTradeState("partially_filled"), "PartiallyFilled");
  assert.equal(mapBrokerStatusToTradeState("filled"), "Filled");
  assert.equal(mapBrokerStatusToTradeState("rejected"), "Rejected");
  assert.equal(mapBrokerStatusToTradeState("canceled"), "Canceled");
  assert.equal(mapBrokerStatusToTradeState("cancelled"), "Canceled");
  assert.equal(mapBrokerStatusToTradeState("expired"), "Expired");
});

test("fetchBrokerOrder: a fetchImpl that THROWS (e.g. AbortError from a timed-out request) resolves ok:false with the error message, never throws itself", async () => {
  const abortError = new DOMException("The operation was aborted.", "AbortError");
  const throwingFetch = (async () => {
    throw abortError;
  }) as unknown as typeof fetch;

  const result = await fetchBrokerOrder({
    brokerConfig: { configured: true, baseUrl: "https://paper-api.alpaca.markets/v2", apiKey: "k", secretKey: "s" },
    orderId: "some-order-id",
    fetchImpl: throwingFetch,
  });

  assert.equal(result.ok, false);
  assert.match(result.errorMessage || "", /aborted/i);
  assert.equal(result.status, undefined, "no fill/status may ever be invented from a thrown fetch error");
  assert.equal(result.filledQty, undefined);
});

test("pollPendingOrders: when fetchImpl THROWS for a pollable order, the trade's state is left completely unchanged and lastPollError is recorded (never invent a fill, same as an HTTP failure)", async () => {
  const trade: PipelineTrade = {
    id: "tr-throw-1",
    symbol: "THROWME",
    qty: 3,
    price: 50,
    side: "buy",
    status: "Accepted",
    source: "manual",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    reasoning: "test",
    notifiedTelegram: true,
    exportedSheets: true,
    loggedNotion: true,
    brokerOrderId: "bro-throw-1",
  };

  const abortError = new DOMException("The operation was aborted.", "AbortError");
  const throwingFetch = (async () => {
    throw abortError;
  }) as unknown as typeof fetch;

  const savedTrades: PipelineTrade[] = [];
  const result = await pollPendingOrders({
    trades: [trade],
    brokerConfig: { configured: true, baseUrl: "https://paper-api.alpaca.markets/v2", apiKey: "k", secretKey: "s" },
    fetchImpl: throwingFetch,
    cancelOrder: async () => {
      throw new Error("cancelOrder must never be called when the poll itself failed");
    },
    saveTrade: (t) => savedTrades.push(t),
  });

  assert.equal(result.polledCount, 1);
  assert.equal(savedTrades.length, 1);
  const saved = savedTrades[0];
  assert.equal(saved.status, "Accepted", "state must be unchanged after a thrown fetch error -- never invent a fill");
  assert.notEqual(saved.status, "Filled");
  assert.equal(saved.filledQty, undefined);
  assert.ok(saved.lastPollError, "expected lastPollError to be recorded");
  assert.match(saved.lastPollError!, /aborted/i);

  assert.ok(
    result.errorLogs.some((line) => /THROWME/.test(line) && /(fail|unchanged)/i.test(line)),
    `expected an error log about the poll failure, got: ${JSON.stringify(result.errorLogs)}`,
  );
});
