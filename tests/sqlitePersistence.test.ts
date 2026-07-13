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

  // Relative to the real clock, NOT hardcoded calendar dates: saveCooldown's
  // opportunistic cleanup deletes rows whose expires_at <= new Date() (the
  // real wall clock), so a hardcoded "future" date silently becomes an
  // already-expired one the day the calendar catches up and the write itself
  // deletes the row (this exact test broke that way on 2026-07-13).
  const nowMs = Date.now();
  const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  const DAY_MS = 24 * 60 * 60 * 1000;

  store.saveCooldown({ symbol: "PLTR", expiresAt: iso(DAY_MS), reason: "trade reached broker" });
  store.saveCooldown({ symbol: "OLD", expiresAt: iso(-365 * DAY_MS), reason: "long expired" });

  const active = store.listActiveCooldownSymbols(iso(0));
  assert.deepEqual(active, ["PLTR"]);

  const noneActive = store.listActiveCooldownSymbols(iso(30 * DAY_MS));
  assert.deepEqual(noneActive, []);

  // A later cooldown write for the same symbol replaces (extends) the prior window.
  store.saveCooldown({ symbol: "PLTR", expiresAt: iso(8 * DAY_MS), reason: "second trade" });
  const stillOne = store.listActiveCooldownSymbols(iso(DAY_MS));
  assert.deepEqual(stillOne, ["PLTR"]);

  store.close();

  const reopened = createProductionStore(dbPath);
  assert.deepEqual(reopened.listActiveCooldownSymbols(iso(DAY_MS)), ["PLTR"]);
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

// Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
// Burry Substack): thesis_invalidations and do_not_buy tables, following the
// exact same "single row per symbol, filter-on-read + delete-expired-on-
// write" pattern as symbol_cooldowns above.

test("thesis invalidations persist, filter expired entries, and survive reopen", () => {
  const dbPath = path.join(process.cwd(), "data", "test-thesis-invalidations.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = createProductionStore(dbPath);

  // Relative dates for the same reason as the cooldown test above: the
  // delete-expired-on-write cleanup uses the REAL clock, so hardcoded
  // calendar dates rot into pre-expired ones.
  const nowMs = Date.now();
  const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  const DAY_MS = 24 * 60 * 60 * 1000;

  store.saveThesisInvalidation({ symbol: "NVDA", sourceId: "michael-burry", reason: "Short Thoughts NVDA", expiresAt: iso(30 * DAY_MS) });
  store.saveThesisInvalidation({ symbol: "OLD", sourceId: "michael-burry", reason: "long expired", expiresAt: iso(-365 * DAY_MS) });

  const active = store.listActiveThesisInvalidatedSymbols(iso(0));
  assert.deepEqual(active, ["NVDA"]);

  const noneActive = store.listActiveThesisInvalidatedSymbols(iso(90 * DAY_MS));
  assert.deepEqual(noneActive, []);

  store.close();

  const reopened = createProductionStore(dbPath);
  assert.deepEqual(reopened.listActiveThesisInvalidatedSymbols(iso(0)), ["NVDA"]);
  reopened.close();
  fs.unlinkSync(dbPath);
});

test("do-not-buy entries persist with full record detail, filter expired entries on read, and survive reopen", () => {
  const dbPath = path.join(process.cwd(), "data", "test-do-not-buy.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = createProductionStore(dbPath);

  // Relative dates -- same rationale as the cooldown test above.
  const nowMs = Date.now();
  const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const firstExpiry = iso(30 * DAY_MS);

  store.saveDoNotBuy({ symbol: "NVDA", sourceId: "michael-burry", reason: "Short Thoughts NVDA (unheld)", expiresAt: firstExpiry });
  store.saveDoNotBuy({ symbol: "OLD", sourceId: "michael-burry", reason: "long expired", expiresAt: iso(-365 * DAY_MS) });

  const active = store.listActiveDoNotBuy(iso(0));
  assert.equal(active.length, 1);
  assert.equal(active[0].symbol, "NVDA");
  assert.equal(active[0].sourceId, "michael-burry");
  assert.equal(active[0].reason, "Short Thoughts NVDA (unheld)");
  assert.equal(active[0].expiresAt, firstExpiry);

  assert.deepEqual(store.listActiveDoNotBuy(iso(90 * DAY_MS)), []);

  // A later write for the same symbol replaces (extends/updates) the prior entry.
  store.saveDoNotBuy({ symbol: "NVDA", sourceId: "michael-burry", reason: "renewed", expiresAt: iso(50 * DAY_MS) });
  const renewed = store.listActiveDoNotBuy(iso(35 * DAY_MS));
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].reason, "renewed");

  store.close();

  const reopened = createProductionStore(dbPath);
  const reopenedActive = reopened.listActiveDoNotBuy(iso(35 * DAY_MS));
  assert.equal(reopenedActive.length, 1);
  assert.equal(reopenedActive[0].symbol, "NVDA");
  reopened.close();
  fs.unlinkSync(dbPath);
});
