import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createProductionStore } from "../src/server/persistence";
import { createRawSignal } from "../src/server/signalEngine";
import { reviewAndPersistSignal } from "../src/server/signalReviewStep";

function freshStorePath(name: string) {
  const dbPath = path.join(process.cwd(), "data", name);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return dbPath;
}

test("syncing the same email-derived signal twice rejects the second as a duplicate, backed by a real SQLite store", () => {
  const dbPath = freshStorePath("test-signal-review-dedup.sqlite");
  const store = createProductionStore(dbPath);

  try {
    // Two separate syncs of the same newsletter email produce raw signals whose
    // sourceTimestamp differs (stamped with new Date().toISOString() per run) but
    // whose source/sourceId/symbol/thesis are identical -- this mirrors the real
    // /api/sync pipeline re-processing the same message.
    const firstRun = createRawSignal({
      source: "email",
      sourceId: "ziptrader:PLTR Newsletter",
      sourceTimestamp: "2026-07-12T13:00:00.000Z",
      symbol: "PLTR",
      thesis: "PLTR enterprise growth is accelerating on new government contracts.",
      url: "gmail://ziptrader",
      aiConfidence: 80,
    });
    const secondRun = createRawSignal({
      source: "email",
      sourceId: "ziptrader:PLTR Newsletter",
      sourceTimestamp: "2026-07-12T14:00:00.000Z",
      symbol: "PLTR",
      thesis: "PLTR enterprise growth is accelerating on new government contracts.",
      url: "gmail://ziptrader",
      aiConfidence: 80,
    });

    const first = reviewAndPersistSignal(store, firstRun);
    assert.equal(first.status, "accepted");

    const second = reviewAndPersistSignal(store, secondRun);
    assert.equal(second.status, "rejected");
    assert.equal(second.rejectionReason, "duplicate");

    // Duplicate rejection must also hold when the process restarts and a fresh
    // in-memory Set would otherwise have forgotten the prior sync.
    store.close();
    const reopened = createProductionStore(dbPath);
    const thirdRun = createRawSignal({
      source: "email",
      sourceId: "ziptrader:PLTR Newsletter",
      sourceTimestamp: "2026-07-12T15:00:00.000Z",
      symbol: "PLTR",
      thesis: "PLTR enterprise growth is accelerating on new government contracts.",
      url: "gmail://ziptrader",
      aiConfidence: 80,
    });
    const third = reviewAndPersistSignal(reopened, thirdRun);
    assert.equal(third.status, "rejected");
    assert.equal(third.rejectionReason, "duplicate");
    reopened.close();
  } finally {
    fs.unlinkSync(dbPath);
  }
});
