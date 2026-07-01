import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-tg-test-"));
process.env.TELEGRAM_ADMIN_ROLES = "42:admin";
delete process.env.TELEGRAM_BOT_TOKEN; // sendTelegramBotMessage no-ops without it

const { dbMutex, handleTelegramCommand, readDB } = await import("../server");

test("telegram /pause waits for the db mutex instead of racing it", async () => {
  const release = await dbMutex.acquire(); // simulate an in-flight sync holding the lock

  const pause = handleTelegramCommand({
    update_id: 1,
    message: { text: "/pause", chat: { id: 42 }, from: { id: 42 } },
  });

  // Give the handler a chance to (incorrectly) write while the lock is held.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The command must not have been applied yet: no audit event written while the lock is held.
  assert.equal(readDB().auditEvents.length, 0);

  release();
  await pause;

  const db = readDB();
  assert.equal(db.config.system.autoTrading, false);
  assert.ok(db.auditEvents.some((e: any) => e.type === "telegram"));
});
