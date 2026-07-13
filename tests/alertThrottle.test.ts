import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SYNC_ALERT_WINDOW_MS, shouldSendThrottledAlert } from "../src/server/alertThrottle";

test("shouldSendThrottledAlert: never alerted before -> alerts immediately", () => {
  assert.equal(shouldSendThrottledAlert(undefined, Date.parse("2026-07-12T12:00:00.000Z")), true);
});

test("shouldSendThrottledAlert: within the window since the last alert -> suppressed", () => {
  const last = "2026-07-12T12:00:00.000Z";
  const now = Date.parse(last) + EMPTY_SYNC_ALERT_WINDOW_MS - 1;
  assert.equal(shouldSendThrottledAlert(last, now), false);
});

test("shouldSendThrottledAlert: exactly at the window boundary -> alerts (trailing throttle re-opens)", () => {
  const last = "2026-07-12T12:00:00.000Z";
  const now = Date.parse(last) + EMPTY_SYNC_ALERT_WINDOW_MS;
  assert.equal(shouldSendThrottledAlert(last, now), true);
});

test("shouldSendThrottledAlert: past the window -> alerts again", () => {
  const last = "2026-07-12T12:00:00.000Z";
  const now = Date.parse(last) + EMPTY_SYNC_ALERT_WINDOW_MS + 60_000;
  assert.equal(shouldSendThrottledAlert(last, now), true);
});

test("shouldSendThrottledAlert: corrupt persisted timestamp fails closed toward alerting, not silent suppression", () => {
  assert.equal(shouldSendThrottledAlert("not-a-real-timestamp", Date.now()), true);
});

test("shouldSendThrottledAlert: an injectable window lets tests exercise the boundary without a new env var", () => {
  const last = "2026-07-12T12:00:00.000Z";
  const shortWindow = 1000;
  assert.equal(shouldSendThrottledAlert(last, Date.parse(last) + 500, shortWindow), false);
  assert.equal(shouldSendThrottledAlert(last, Date.parse(last) + 1500, shortWindow), true);
});
