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

test("symbol cooldowns persist, filter expired entries, and survive reopen", () => {
  const dbPath = path.join(process.cwd(), "data", "test-cooldown.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = createProductionStore(dbPath);

  store.saveCooldown({ symbol: "PLTR", expiresAt: "2026-07-13T00:00:00.000Z", reason: "trade reached broker" });
  store.saveCooldown({ symbol: "OLD", expiresAt: "2020-01-01T00:00:00.000Z", reason: "long expired" });

  const active = store.listActiveCooldownSymbols("2026-07-12T00:00:00.000Z");
  assert.deepEqual(active, ["PLTR"]);

  const noneActive = store.listActiveCooldownSymbols("2030-01-01T00:00:00.000Z");
  assert.deepEqual(noneActive, []);

  // A later cooldown write for the same symbol replaces (extends) the prior window.
  store.saveCooldown({ symbol: "PLTR", expiresAt: "2026-07-20T00:00:00.000Z", reason: "second trade" });
  const stillOne = store.listActiveCooldownSymbols("2026-07-13T00:00:00.000Z");
  assert.deepEqual(stillOne, ["PLTR"]);

  store.close();

  const reopened = createProductionStore(dbPath);
  assert.deepEqual(reopened.listActiveCooldownSymbols("2026-07-13T00:00:00.000Z"), ["PLTR"]);
  reopened.close();
  fs.unlinkSync(dbPath);
});

test("app_state key-value store: absent key reads undefined, a written key round-trips, and state survives reopen", () => {
  const dbPath = path.join(process.cwd(), "data", "test-app-state.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = createProductionStore(dbPath);
  assert.equal(store.getAppState("never_written"), undefined);

  store.setAppState("empty_sync_alert_last_sent_at", "2026-07-12T12:00:00.000Z");
  assert.equal(store.getAppState("empty_sync_alert_last_sent_at"), "2026-07-12T12:00:00.000Z");

  // A later write for the same key replaces the value (no accumulation of rows).
  store.setAppState("empty_sync_alert_last_sent_at", "2026-07-12T18:00:00.000Z");
  assert.equal(store.getAppState("empty_sync_alert_last_sent_at"), "2026-07-12T18:00:00.000Z");
  store.close();

  const reopened = createProductionStore(dbPath);
  assert.equal(reopened.getAppState("empty_sync_alert_last_sent_at"), "2026-07-12T18:00:00.000Z");
  reopened.close();
  fs.unlinkSync(dbPath);
});
