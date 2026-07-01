import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-test-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";

const { app } = await import("../server");

test("POST /api/config requires the admin token", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const noToken = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: { autoTrading: true } }),
  });
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": "wrong" },
    body: JSON.stringify({ system: { autoTrading: true } }),
  });
  assert.equal(badToken.status, 401);

  const goodToken = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": "test-admin-token-0123456789",
    },
    body: JSON.stringify({ system: { autoTrading: false } }),
  });
  assert.equal(goodToken.status, 200);
  const body = await goodToken.json();
  assert.equal(body.success, true);
});
