import { RawSignal, ReviewedSignal } from "./domainTypes";
import { ProductionStore } from "./persistence";
import { computeDuplicateKey, reviewSignal } from "./signalEngine";

// How many of the most recent reviewed signals to load as the dedup "seen" set.
// Bounds memory/query cost instead of loading the entire history on every sync.
const SEEN_KEYS_WINDOW = 1000;

type ReviewAndPersistOptions = {
  now?: Date;
  maxAgeHours?: number;
};

/**
 * Reviews a raw signal for dedup/staleness/confidence and persists the result,
 * using the SQLite store as the source of truth for previously-seen dedup keys
 * instead of a fresh in-memory Set. This is what makes duplicate rejection
 * survive across separate /api/sync calls (and process restarts).
 */
export function reviewAndPersistSignal(
  store: ProductionStore,
  rawSignal: RawSignal,
  options: ReviewAndPersistOptions = {},
): ReviewedSignal {
  const seenKeys = store.loadRecentDuplicateKeys(SEEN_KEYS_WINDOW);
  const reviewed = reviewSignal(rawSignal, { ...options, seenKeys });
  const duplicateKey = reviewed.status === "accepted" ? computeDuplicateKey(rawSignal) : undefined;
  store.saveReviewedSignal(reviewed, duplicateKey);
  return reviewed;
}
