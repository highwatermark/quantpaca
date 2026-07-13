import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-test-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";

// These tests exercise the real /api/sync wiring end-to-end. server.ts loads
// .env via dotenv, which may contain a real ANTHROPIC_API_KEY -- deleting the
// env var here would not help, since dotenv.config() only skips keys that are
// already present and would just refill it. To keep the tests hermetic (no
// live network calls, no real API spend) regardless of what's configured
// locally, intercept outbound fetches:
//   - api.anthropic.com  -> throw, simulating the "web search call fails"
//     branch the task requires us to handle without a canned fallback.
//   - gmail.googleapis.com -> HTTP 500, simulating the Gmail-API-error branch
//     (a token is present but the API is down).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    throw new Error("Simulated Claude API failure (test isolation: no live network calls).");
  }
  if (typeof url === "string" && url.includes("gmail.googleapis.com")) {
    return new Response("Simulated Gmail outage (test isolation: no live network calls).", { status: 500 });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");

async function runSync(port: number, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": "test-admin-token-0123456789",
      ...extraHeaders,
    },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body;
}

async function assertZeroSignalsAndTrades(port: number, body: any) {
  // Zero signals: no fabricated MARA thesis, no fabricated YouTube sentiment.
  assert.deepEqual(body.analyses, []);

  // No fabricated content should ever have reached the analysis pipeline.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("MARA"), "fabricated MARA demo thesis must never reach the response");
  assert.ok(!serialized.includes("Bullish on growth tech"), "canned bullish YouTube fallback must never reach the response");

  // Zero trades: with zero analyses there is nothing to size or submit an order for.
  const tradesRes = await fetch(`http://127.0.0.1:${port}/api/trades`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  assert.equal(tradesRes.status, 200);
  const trades = await tradesRes.json();
  assert.deepEqual(trades, []);
}

test("with no Gmail token and the Claude API failing, a sync produces zero signals and zero trades, and logs the failure", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // No Authorization header -> Gmail branch is skipped entirely (no OAuth token).
  const body = await runSync(port);
  await assertZeroSignalsAndTrades(port, body);

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
});

test("with a Gmail token but the Gmail API responding non-OK, a sync produces zero signals and zero trades, and logs the real behavior", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // An Authorization header is present, so the Gmail branch is exercised for
  // real; the intercepted fetch answers 500, driving the gmailRes.ok === false
  // error branch.
  const body = await runSync(port, { Authorization: "Bearer test-oauth-token" });
  await assertZeroSignalsAndTrades(port, body);

  const messages: string[] = body.logs.map((l: any) => l.message);
  // The Gmail-API-error log must describe the real fail-closed behavior (zero
  // email signals this sync) -- not claim to be "operating with offline
  // simulation database", which no longer exists on this path.
  assert.ok(
    messages.some((m) => /gmail api failed/i.test(m) && /no email signals/i.test(m)),
    `expected the Gmail API error log to state that no email signals are produced, got: ${JSON.stringify(messages)}`,
  );
  assert.ok(
    !messages.some((m) => /simulat/i.test(m) && /gmail/i.test(m)),
    `Gmail failure log must not claim simulated operation, got: ${JSON.stringify(messages)}`,
  );
  // The zero-email-targets summary log still fires on this path too.
  assert.ok(
    messages.some((m) => /zero usable email scan-targets/i.test(m)),
    `expected the zero-email-scan-targets log entry, got: ${JSON.stringify(messages)}`,
  );
});
