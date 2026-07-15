// Phase 2 follow-up (docs/GO_LIVE_PLAN.md sign-off item 2): server-side
// Gmail refresh-token auth, wired end-to-end. This file exercises
// runSyncCycle's ONE broker-fallback wiring point (server.ts) through the
// real HTTP routes: a scheduled tick (no browser session, ever) and a
// manual /api/sync call without an Authorization header both must fall back
// to the broker's minted access token when GOOGLE_CLIENT_ID/SECRET/
// REFRESH_TOKEN are all configured; a manual sync WITH a browser header
// keeps using that header (precedence unchanged); a failed token exchange
// must degrade to the pre-existing zero-email-signals path, not crash the
// cycle.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-google-broker-integration-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
// Deliberately unconfigured: checkMarketOpenForScheduledCycle treats an
// unconfigured broker as "market open" (server.ts), so a scheduled cycle in
// this file runs full scope without needing a real/fixture Alpaca clock.
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";
// The three GOOGLE_* env vars under test: all three set, so
// isGoogleTokenBrokerConfigured() is true for every test in this file.
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.GOOGLE_REFRESH_TOKEN = "test-google-refresh-token";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const registryPath = path.join(dataDir, "signal-sources.json");

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function writeRegistry(entries: unknown[]) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(entries));
}

writeRegistry([
  {
    id: "ziptrader",
    gmailQuery: "from:charlie-from-ziptrader@ghost.io",
    senderAllowlist: ["charlie-from-ziptrader@ghost.io"],
    trustTier: "high",
    maxAgeHours: 72,
    enabled: true,
  },
]);

function gmailMessageFixture(id: string, symbol: string) {
  const body = `Thesis body for ${symbol}: fundamentals accelerating, whipsaw-only pullback, high conviction entry.`;
  return {
    id,
    internalDate: String(Date.now() - 1000),
    snippet: body.slice(0, 100),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: "ZipTrader thesis" },
        { name: "From", value: "Charlie <charlie-from-ziptrader@ghost.io>" },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64url(body) } }],
    },
  };
}

function fixtureMessageResponse(content: Array<{ type: "text"; text: string }>) {
  return new Response(
    JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-4-8",
      content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function holdFixtureFor(symbol: string) {
  return {
    symbol,
    growthScore: 60,
    sentimentScore: 40,
    riskProfile: "Medium",
    reasoning: `Thesis on ${symbol}.`,
    whipsawCheck: "This is a whipsaw -- volatility-driven, dip likely to recover.",
    whipsawVerdict: "whipsaw",
    decision: decisionMode,
  };
}

// --- Fixture control state, reset per test ---------------------------------
let tokenMode: "success" | "failure" = "success";
let decisionMode: "HOLD" | "BUY" = "HOLD";
let tokenCallCount = 0;
const gmailAuthHeadersSeen: string[] = [];
const tokenExchangeBodies: string[] = [];
let messageId = "m1";
let messageSymbol = "BROKR";

function resetFixtures() {
  tokenMode = "success";
  decisionMode = "HOLD";
  tokenCallCount = 0;
  gmailAuthHeadersSeen.length = 0;
  tokenExchangeBodies.length = 0;
  messageId = `m-${Math.random().toString(36).slice(2, 8)}`;
  messageSymbol = "BROKR";
  // The broker's cache/single-flight state is module-scoped, not per-test --
  // without this reset, an earlier test's successful exchange would still be
  // cached (and reused) by a LATER test that specifically wants to exercise
  // a failing exchange or a fresh call count.
  resetGoogleTokenBrokerForTests();
}

const FIXTURE_ACCESS_TOKEN = "fixture-broker-access-token";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url === "https://oauth2.googleapis.com/token") {
    tokenCallCount++;
    tokenExchangeBodies.push(String(init?.body ?? ""));
    if (tokenMode === "failure") {
      return new Response("invalid_grant", { status: 400 });
    }
    return new Response(
      JSON.stringify({ access_token: FIXTURE_ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    if (body.output_config) {
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(holdFixtureFor(messageSymbol)) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    const authHeader = init?.headers?.Authorization;
    if (typeof authHeader === "string") gmailAuthHeadersSeen.push(authHeader);
    if (url.includes("/messages?")) {
      return new Response(JSON.stringify({ messages: [{ id: messageId }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes(`/messages/${messageId}?`)) {
      return new Response(JSON.stringify(gmailMessageFixture(messageId, messageSymbol)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("unhandled gmail path in test fixture", { status: 404 });
  }

  if (url.includes("sheets.googleapis.com")) {
    const authHeader = init?.headers?.Authorization;
    if (typeof authHeader === "string") gmailAuthHeadersSeen.push(`sheets:${authHeader}`);
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app, runScheduledSyncTickForTests } = await import("../server");
const { resetGoogleTokenBrokerForTests } = await import("../src/server/googleTokenBroker");

async function getLogs(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { "x-admin-token": ADMIN_TOKEN } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ message: string }>;
  return body.map((l) => l.message);
}

async function setAutoTrading(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      system: { autoTrading: true, runIntervalMins: 15, maxPositionSizePercent: 10, stopLossPercent: 5, targetProfitPercent: 15 },
    }),
  });
  assert.equal(res.status, 200);
}

test("a scheduled cycle (no browser session, ever) falls back to the broker's minted access token for the Gmail Authorization header", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setAutoTrading(port);

  await runScheduledSyncTickForTests();

  assert.ok(gmailAuthHeadersSeen.length > 0, "expected at least one Gmail request to have carried an Authorization header");
  for (const header of gmailAuthHeadersSeen) {
    assert.equal(header, `Bearer ${FIXTURE_ACCESS_TOKEN}`, `expected the broker's fixture token, got: ${header}`);
  }
  assert.equal(tokenCallCount, 1, "expected exactly one token exchange for the whole cycle (cached thereafter)");
});

test("a second scheduled cycle in the same process reuses the cached broker token (no second exchange)", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setAutoTrading(port);

  await runScheduledSyncTickForTests();
  const firstCallCount = tokenCallCount;
  assert.equal(firstCallCount, 1);

  // Immediately run a second cycle -- the in-memory cache (5 minutes before
  // a 1-hour expiry) must still be valid; no second /token request.
  await runScheduledSyncTickForTests();
  assert.equal(tokenCallCount, 1, "the cached broker token must be reused across cycles within its lifetime");
});

test("manual /api/sync WITHOUT a browser Authorization header falls back to the broker", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);

  assert.ok(gmailAuthHeadersSeen.length > 0);
  assert.ok(gmailAuthHeadersSeen.every((h) => h === `Bearer ${FIXTURE_ACCESS_TOKEN}`));
});

test("manual /api/sync WITH a browser Authorization header takes precedence over the broker (existing behavior unchanged)", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN, Authorization: "Bearer browser-session-token" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);

  assert.ok(gmailAuthHeadersSeen.length > 0);
  assert.ok(gmailAuthHeadersSeen.every((h) => h === "Bearer browser-session-token"), `expected the browser header to win, got: ${JSON.stringify(gmailAuthHeadersSeen)}`);
  assert.equal(tokenCallCount, 0, "the broker must never be consulted when a browser header is already present");
});

test("a failing token exchange degrades to the existing zero-email-signals path -- no crash, honest logs", async (t) => {
  resetFixtures();
  tokenMode = "failure";
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setAutoTrading(port);

  await runScheduledSyncTickForTests();

  assert.equal(gmailAuthHeadersSeen.length, 0, "Gmail must never be called when the broker has no token to offer");

  const logs = await getLogs(port);
  assert.ok(
    logs.some((m) => /No Gmail authorization token detected/i.test(m)),
    `expected the existing zero-email-signals log line, got: ${JSON.stringify(logs)}`,
  );
  assert.ok(
    logs.some((m) => /zero usable email scan-targets/i.test(m)),
    `expected the cycle to complete and log the zero-scan-targets outcome, got: ${JSON.stringify(logs)}`,
  );
});

test("broker-configured but Sheets export disabled: the cycle still completes cleanly (Sheets export is skipped, not attempted)", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());
  await setAutoTrading(port);

  // Default config has google.enabled=false -- confirm the cycle still runs
  // Gmail ingestion end-to-end via the broker (proving the broker header
  // itself is fine) while never once calling sheets.googleapis.com, and
  // completes without throwing.
  await runScheduledSyncTickForTests();

  assert.ok(gmailAuthHeadersSeen.length > 0, "expected the broker-backed Gmail ingestion to have run");
  assert.ok(
    !gmailAuthHeadersSeen.some((h) => h.startsWith("sheets:")),
    "Sheets export must not be attempted while google.enabled is false, even with a configured broker",
  );

  const logs = await getLogs(port);
  assert.ok(
    logs.some((m) => /Starting automation loop/i.test(m)),
    "expected the cycle to have actually run (not skipped)",
  );
});
