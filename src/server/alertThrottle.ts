// Phase 2 Task 1, Item B (docs/GO_LIVE_PLAN.md "Phase 1 completion report" ->
// "Deferred to Phase 2"): the zero-email-scan-targets Telegram alert in
// server.ts's Gmail ingestion block previously fired on EVERY sync -- with the
// 15-minute scheduler coming next and Gmail OAuth still unconfigured, that is
// ~96 identical alerts/day. This module is the pure trailing-throttle
// decision: given when the alert last fired (persisted in the SQLite
// key-value store -- see persistence.ts's `app_state` table) and the current
// time, decide whether this occurrence should alert again.
//
// Fail-closed direction for THIS control is "alert" -- an unreadable/corrupt
// persisted timestamp must never silently suppress an alert forever, so it is
// treated the same as "never alerted" (alert immediately). This is the
// opposite fail-closed direction from the regime cache (marketDataFetcher.ts /
// domainTypes.ts's `fetchedAt`, which fails closed toward "stale" / refetch)
// because the two controls guard against different failure modes: the regime
// cache's danger is trading on stale market data, this throttle's danger is a
// real, ongoing Gmail outage going unnoticed by never re-alerting.

// 6 hours: named constant per the task brief (no env var, no config surface).
// Trailing throttle -- the first occurrence after a quiet period always
// alerts immediately; only repeats within the window are suppressed.
export const EMPTY_SYNC_ALERT_WINDOW_MS = 6 * 60 * 60 * 1000;

// Key under which the last-alerted-at ISO timestamp is persisted in the
// app_state key-value table (persistence.ts).
export const EMPTY_SYNC_ALERT_STATE_KEY = "empty_sync_alert_last_sent_at";

// Pure decision, clock/window both injectable so tests never need to wait out
// a real 6-hour window or add a new env var (per the task brief's binding
// constraints). `lastSentAtIso` is whatever was read back from app_state;
// undefined (never alerted) and unparsable (corrupt state) both mean "alert
// now" here.
export function shouldSendThrottledAlert(
  lastSentAtIso: string | undefined,
  nowMs: number,
  windowMs: number = EMPTY_SYNC_ALERT_WINDOW_MS,
): boolean {
  if (!lastSentAtIso) return true;
  const lastMs = Date.parse(lastSentAtIso);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= windowMs;
}
