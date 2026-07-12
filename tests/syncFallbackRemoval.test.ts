import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-test-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";

// This test exercises the real /api/sync wiring end-to-end. server.ts loads
// .env via dotenv, which may contain a real ANTHROPIC_API_KEY -- deleting the
// env var here would not help, since dotenv.config() only skips keys that are
// already present and would just refill it. To keep this test hermetic (no
// live network calls, no real API spend) regardless of what's configured
// locally, intercept fetch calls to the Anthropic API and simulate the "web
// search call fails" branch the task requires us to handle without a canned
// fallback.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    throw new Error("Simulated Claude API failure (test isolation: no live network calls).");
  }
  return realFetch(input, init);
}) as typeof fetch;

const { app } = await import("../server");

test("with Gmail unavailable and no Claude API key, a sync produces zero signals and zero trades, and logs the failure", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => {
    listener.close();
    globalThis.fetch = realFetch;
  });

  // No Authorization header -> Gmail branch is skipped entirely (no OAuth token).
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": "test-admin-token-0123456789",
    },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);

  // Zero signals: no fabricated MARA thesis, no fabricated YouTube sentiment.
  assert.deepEqual(body.analyses, []);

  // No fabricated content should ever have reached the analysis pipeline.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("MARA"), "fabricated MARA demo thesis must never reach the response");
  assert.ok(!serialized.includes("Bullish on growth tech"), "canned bullish YouTube fallback must never reach the response");

  // The failure is logged, not silent.
  const messages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    messages.some((m) => /no gmail|zero.*email|no authorization token/i.test(m)),
    `expected a log entry about missing/zero email scan-targets, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    messages.some((m) => /youtube/i.test(m) && /(fail|zero|no content)/i.test(m)),
    `expected a log entry about the failed/empty YouTube sentiment scan, got: ${JSON.stringify(messages)}`,
  );

  // Zero trades: with zero analyses there is nothing to size or submit an order for.
  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`);
  assert.equal(tradesRes.status, 200);
  const trades = await tradesRes.json();
  assert.deepEqual(trades, []);
});
