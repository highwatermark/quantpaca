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

test("I1: same email (stable message-id sourceId + stable dedupContent) is still rejected as a duplicate even when Claude's re-analysis wording drifts", () => {
  const dbPath = freshStorePath("test-signal-review-dedup-stable-input.sqlite");
  const store = createProductionStore(dbPath);

  try {
    // The raw ingested email body is identical across re-syncs of the SAME Gmail
    // message -- this is what production now hashes for dedup (server.ts passes
    // `dedupContent: target.content`), not Claude's free-text reasoning.
    const emailBody =
      "ZipTrader Newsletter: Palantir just landed another multi-year government contract, " +
      "extending its enterprise AI footprint across federal agencies.";

    const firstRun = createRawSignal({
      source: "email",
      sourceId: "email:18d2f0a1b2c3d4e5", // stable Gmail message id
      sourceTimestamp: "2026-07-12T13:00:00.000Z",
      symbol: "PLTR",
      thesis: "PLTR enterprise growth is accelerating on new government contracts.",
      dedupContent: emailBody,
      url: "gmail://ziptrader",
      aiConfidence: 80,
    });
    // Same message, re-synced later: Claude's wording drifts (different reasoning
    // string) but the sourceId and the underlying email body are unchanged.
    const secondRun = createRawSignal({
      source: "email",
      sourceId: "email:18d2f0a1b2c3d4e5",
      sourceTimestamp: "2026-07-12T14:00:00.000Z",
      symbol: "PLTR",
      thesis: "Momentum in Palantir's government contract pipeline continues to build, underscoring durable enterprise demand.",
      dedupContent: emailBody,
      url: "gmail://ziptrader",
      aiConfidence: 82,
    });

    const first = reviewAndPersistSignal(store, firstRun);
    assert.equal(first.status, "accepted");

    const second = reviewAndPersistSignal(store, secondRun);
    assert.equal(second.status, "rejected", `expected wording drift to still dedup; got status=${second.status} reason=${second.rejectionReason}`);
    assert.equal(second.rejectionReason, "duplicate");
  } finally {
    store.close();
    fs.unlinkSync(dbPath);
  }
});
