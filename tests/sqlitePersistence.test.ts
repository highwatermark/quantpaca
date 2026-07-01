import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createProductionStore } from "../src/server/persistence";

test("SQLite store persists append-only audit events and pipeline records", () => {
  const dbPath = path.join(process.cwd(), "data", "test-quantpaca.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = createProductionStore(dbPath);
  store.appendAuditEvents([{
    id: "ae-1",
    timestamp: "2026-06-29T20:00:00.000Z",
    type: "trade_state",
    actor: "test",
    entityId: "tr-1",
    fromState: "PendingApproval",
    toState: "BrokerSubmitted",
    message: "submitted",
  }]);
  store.saveTradeIntent({
    id: "tr-1",
    symbol: "PLTR",
    side: "buy",
    qty: 1,
    price: 100,
    status: "Accepted",
    timestamp: "2026-06-29T20:00:00.000Z",
    reasoning: "test",
    notifiedTelegram: false,
    exportedSheets: false,
    loggedNotion: false,
    source: "manual",
  });
  store.close();

  const reopened = createProductionStore(dbPath);
  assert.equal(reopened.listAuditEvents()[0].id, "ae-1");
  assert.equal(reopened.listTradeIntents()[0].id, "tr-1");
  reopened.close();
  fs.unlinkSync(dbPath);
});
