import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-breaker-tg-"));
process.env.TELEGRAM_ADMIN_ROLES = "42:admin";
process.env.TELEGRAM_BOT_TOKEN = "test-telegram-bot-token";
// Force the simulated/unconfigured broker path deterministically (pattern:
// tests/symbolCooldown.test.ts) -- /breaker_reset's getAlpacaPortfolio call then
// resolves locally with no Alpaca network mocking required. The simulated
// portfolio's equity never dips on its own, so this file only exercises who is
// allowed to reset (the auth/confirmation gate), not the re-latch-if-still-breached
// path -- that's covered end-to-end against a mocked real broker in
// breakerLatchIntegration.test.ts.
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";

// Capture outbound Telegram messages instead of hitting the network, so the
// confirmation token embedded in the bot's reply (the same way a real operator
// would read it) can be scraped and replayed through /confirm.
const sentMessages: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    sentMessages.push(String(body.text || ""));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { handleTelegramCommand, productionStore } = await import("../server");

function extractConfirmToken(message: string): string {
  const match = message.match(/\/confirm\s+([A-Z0-9]+)/);
  assert.ok(match, `expected a confirmation token in the reply, got: ${message}`);
  return match![1];
}

test("telegram /breaker_reset from an unauthorized user is refused and performs no reset", async () => {
  sentMessages.length = 0;
  await handleTelegramCommand({
    update_id: 100,
    message: { text: "/breaker_reset", chat: { id: 99 }, from: { id: 99 } }, // 99 has no configured role
  });

  const auditEvents = productionStore.listAuditEvents();
  const rejection = auditEvents.find((e: any) => e.type === "telegram" && e.details?.command === "/breaker_reset" && e.actor === "99") as any;
  assert.ok(rejection, "expected a telegram audit event for the /breaker_reset attempt");
  assert.equal(rejection.details.auth.allowed, false);

  const breakerAudit = auditEvents.find((e: any) => e.type === "breaker");
  assert.equal(breakerAudit, undefined, "an unauthorized user must not trigger an actual breaker reset");
  assert.ok(sentMessages.some((m) => /rejected/i.test(m)), `expected a rejection reply, got: ${JSON.stringify(sentMessages)}`);
});

test("telegram /breaker_reset from an authorized admin requires confirmation, then resets on /confirm", async () => {
  sentMessages.length = 0;

  await handleTelegramCommand({
    update_id: 101,
    message: { text: "/breaker_reset", chat: { id: 42 }, from: { id: 42 } }, // 42 is admin per TELEGRAM_ADMIN_ROLES
  });

  assert.equal(
    productionStore.listAuditEvents().find((e: any) => e.type === "breaker"),
    undefined,
    "must not reset before confirmation -- mirrors /close_all's two-step admin flow",
  );
  assert.ok(
    sentMessages.some((m) => /confirmation/i.test(m) && /\/confirm/.test(m)),
    `expected a confirmation-required reply, got: ${JSON.stringify(sentMessages)}`,
  );

  const token = extractConfirmToken(sentMessages[sentMessages.length - 1]);

  await handleTelegramCommand({
    update_id: 102,
    message: { text: `/confirm ${token}`, chat: { id: 42 }, from: { id: 42 } },
  });

  const auditEventsAfterConfirm = productionStore.listAuditEvents();
  const resetEvent = auditEventsAfterConfirm.find((e: any) => e.type === "breaker" && e.actor === "telegram:42");
  assert.ok(resetEvent, `expected a breaker reset audit event from telegram:42, got: ${JSON.stringify(auditEventsAfterConfirm)}`);
  assert.ok(
    sentMessages.some((m) => /reset/i.test(m) && /executed|status/i.test(m)),
    `expected a reset-executed reply, got: ${JSON.stringify(sentMessages)}`,
  );
});

test("telegram /confirm replaying the same breaker_reset token a second time is refused", async () => {
  sentMessages.length = 0;

  await handleTelegramCommand({
    update_id: 103,
    message: { text: "/breaker_reset", chat: { id: 42 }, from: { id: 42 } },
  });
  const token = extractConfirmToken(sentMessages[sentMessages.length - 1]);

  await handleTelegramCommand({ update_id: 104, message: { text: `/confirm ${token}`, chat: { id: 42 }, from: { id: 42 } } });
  const auditCountAfterFirst = productionStore.listAuditEvents().filter((e: any) => e.type === "breaker").length;

  await handleTelegramCommand({ update_id: 105, message: { text: `/confirm ${token}`, chat: { id: 42 }, from: { id: 42 } } });
  const auditCountAfterReplay = productionStore.listAuditEvents().filter((e: any) => e.type === "breaker").length;

  assert.equal(auditCountAfterReplay, auditCountAfterFirst, "a replayed confirmation token must not trigger a second reset");
  // The token is removed from the pending-confirmations map as soon as it's
  // consumed once (same mechanism /close_all already relies on) -- so a second
  // /confirm with the same value reports "unknown token", not "replayed". Either
  // way the reset must not fire twice, which is what auditCountAfterReplay above
  // actually proves.
  assert.ok(sentMessages.some((m) => /rejected/i.test(m)), `expected the replayed confirm to be rejected, got: ${JSON.stringify(sentMessages)}`);
});

after(() => {
  globalThis.fetch = realFetch;
});
