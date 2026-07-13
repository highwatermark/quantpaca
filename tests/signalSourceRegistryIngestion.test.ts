import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-source-registry-ingestion-"));
process.env.QUANTPACA_DATA_DIR = dataDir;
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_API_KEY = "";
process.env.ALPACA_SECRET_KEY = "";

const ADMIN_TOKEN = "test-admin-token-0123456789";
const registryPath = path.join(dataDir, "signal-sources.json");

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function writeRegistry(entries: unknown[]) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(entries));
}

// id -> { from, subject, symbol, internalDateMs }
type Fixture = { from: string; subject: string; symbol: string; internalDateMs: number };
let MESSAGES: Record<string, Fixture> = {};
// exact gmailQuery string -> ordered list of message ids that query returns
let QUERY_TO_IDS: Record<string, string[]> = {};
const anthropicCallSymbols: string[] = [];

function gmailMessageFixture(id: string) {
  const f = MESSAGES[id];
  const body = `Thesis body for ${f.symbol}: fundamentals accelerating, whipsaw-only pullback, high conviction entry.`;
  return {
    id,
    internalDate: String(f.internalDateMs),
    snippet: body.slice(0, 100),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: f.subject },
        { name: "From", value: f.from },
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
    decision: "HOLD",
  };
}

const gmailListCalls: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (typeof url !== "string") return realFetch(input, init);

  if (url.includes("api.anthropic.com")) {
    let body: any = {};
    try {
      body = init?.body ? JSON.parse(init.body as string) : {};
    } catch {
      body = {};
    }
    if (body.output_config) {
      const promptText: string = body.messages?.[0]?.content ?? "";
      const symbols = Object.values(MESSAGES).map((f) => f.symbol);
      const matched = symbols.find((sym) => promptText.includes(sym));
      if (matched) anthropicCallSymbols.push(matched);
      const fixture = matched ? holdFixtureFor(matched) : { symbol: "UNKNOWN", growthScore: 0, sentimentScore: 0, riskProfile: "Low", reasoning: "n/a", whipsawCheck: "n/a", whipsawVerdict: "unclear", decision: "NONE" };
      return fixtureMessageResponse([{ type: "text", text: JSON.stringify(fixture) }]);
    }
    return fixtureMessageResponse([{ type: "text", text: "fixture sentiment: nothing notable this cycle." }]);
  }

  if (url.includes("gmail.googleapis.com")) {
    if (url.includes("/messages?")) {
      gmailListCalls.push(url);
      const q = new URL(url).searchParams.get("q") || "";
      const ids = QUERY_TO_IDS[q] || [];
      return new Response(JSON.stringify({ messages: ids.map((id) => ({ id })) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const match = url.match(/\/messages\/([^?]+)\?/);
    const id = match?.[1];
    if (id && MESSAGES[id]) {
      return new Response(JSON.stringify(gmailMessageFixture(id)), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unhandled gmail path in test fixture", { status: 404 });
  }

  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const { app } = await import("../server");

async function runSync(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN, Authorization: "Bearer test-oauth-token" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  return body;
}

async function getReviewedSignals(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/signals/reviewed`, { headers: { "x-admin-token": "test-admin-token-0123456789" } });
  assert.equal(res.status, 200);
  return res.json();
}

function resetFixtures() {
  MESSAGES = {};
  QUERY_TO_IDS = {};
  gmailListCalls.length = 0;
  anthropicCallSymbols.length = 0;
}

test("two enabled registry sources are both queried in one cycle; each signal is stamped with its own source id, and per-source maxAgeHours is honored", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  writeRegistry([
    { id: "ziptrader", gmailQuery: "from:charlie-from-ziptrader@ghost.io", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
    { id: "secondsource", gmailQuery: "from:analyst@secondsource.example", senderAllowlist: ["analyst@secondsource.example"], trustTier: "medium", maxAgeHours: 24, enabled: true },
  ]);

  const fortyEightHoursAgo = Date.now() - 48 * 60 * 60 * 1000;
  MESSAGES = {
    z1: { from: "Charlie <charlie-from-ziptrader@ghost.io>", subject: "ZipTrader thesis", symbol: "SRCA", internalDateMs: fortyEightHoursAgo },
    s1: { from: "Analyst <analyst@secondsource.example>", subject: "Second source thesis", symbol: "SRCB", internalDateMs: fortyEightHoursAgo },
  };
  QUERY_TO_IDS = {
    "from:charlie-from-ziptrader@ghost.io": ["z1"],
    "from:analyst@secondsource.example": ["s1"],
  };

  const body = await runSync(port);

  // Both sources' queries were actually issued as separate Gmail list calls.
  assert.equal(gmailListCalls.length, 2, `expected exactly two Gmail list calls, got: ${JSON.stringify(gmailListCalls)}`);
  assert.ok(gmailListCalls.some((u) => decodeURIComponent(u).includes("from:charlie-from-ziptrader@ghost.io")));
  assert.ok(gmailListCalls.some((u) => decodeURIComponent(u).includes("from:analyst@secondsource.example")));

  // Both messages actually reached Claude analysis (staleness is a review-
  // time rejection, not a pre-analysis filter) -- but only the accepted one
  // (SRCA, fresh under its 72h source) surfaces in body.analyses; the
  // rejected-as-stale one (SRCB) is logged and persisted as a rejected
  // reviewed signal instead (asserted via /api/signals/reviewed below), same
  // as any other rejected signal.
  assert.deepEqual(anthropicCallSymbols.sort(), ["SRCA", "SRCB"]);
  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].symbol, "SRCA");
  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(logMessages.some((m) => /Signal rejected for SRCB: stale/i.test(m)));

  const reviewed = await getReviewedSignals(port);
  const srcaSignal = reviewed.find((s: any) => s.symbol === "SRCA");
  const srcbSignal = reviewed.find((s: any) => s.symbol === "SRCB");
  assert.ok(srcaSignal, "expected a reviewed signal for SRCA");
  assert.ok(srcbSignal, "expected a reviewed signal for SRCB");

  // Source stamping: each signal carries its OWN registry id, not a generic "email".
  assert.equal(srcaSignal.source, "ziptrader");
  assert.equal(srcbSignal.source, "secondsource");

  // Per-source maxAgeHours: the same 48h-old email age passes for the 72h
  // source (ziptrader) but is rejected stale for the 24h source (secondsource).
  assert.equal(srcaSignal.status, "accepted");
  assert.equal(srcaSignal.freshnessStatus, "fresh");
  assert.equal(srcbSignal.status, "rejected");
  assert.equal(srcbSignal.rejectionReason, "stale");
});

test("blocklist acceptance: a fixture Robinhood trade-confirmation email matched by a broadened query produces zero signals, zero Claude calls for it, and a distinct log line", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  // A deliberately broadened query (simulating an operator widening the
  // filter) that happens to also match a Robinhood trade-confirmation email
  // in the same inbox/thread.
  writeRegistry([
    { id: "broadsource", gmailQuery: "from:(ziptrader OR robinhood)", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
  ]);

  const now = Date.now();
  MESSAGES = {
    legit: { from: "Charlie <charlie-from-ziptrader@ghost.io>", subject: "ZipTrader thesis", symbol: "LEGIT", internalDateMs: now - 1000 },
    confirm: { from: "noreply@robinhood.com", subject: "Your order has been filled", symbol: "RBLK", internalDateMs: now - 1000 },
  };
  QUERY_TO_IDS = { "from:(ziptrader OR robinhood)": ["legit", "confirm"] };

  const body = await runSync(port);

  // Only the legit message reached analysis.
  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].symbol, "LEGIT");
  assert.deepEqual(anthropicCallSymbols, ["LEGIT"], "the blocklisted message must never reach a Claude analysis call");

  const reviewed = await getReviewedSignals(port);
  assert.equal(reviewed.some((s: any) => s.symbol === "RBLK"), false, "the trade-confirmation email must produce zero signals");

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /blocklisted sender/i.test(m)),
    `expected a distinct "blocklisted sender" log line, got: ${JSON.stringify(logMessages)}`,
  );
});

test("blocklist-vs-allowlist conflict: an operator mistakenly allowlisting a blocked sender still gets blocked, with a loud conflict log", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  writeRegistry([
    { id: "misconfigured", gmailQuery: "from:noreply@robinhood.com", senderAllowlist: ["noreply@robinhood.com"], trustTier: "high", maxAgeHours: 72, enabled: true },
  ]);

  MESSAGES = {
    confirm: { from: "noreply@robinhood.com", subject: "Your order has been filled", symbol: "RBLK", internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:noreply@robinhood.com": ["confirm"] };

  const body = await runSync(port);

  assert.equal(body.analyses.length, 0);
  assert.deepEqual(anthropicCallSymbols, []);

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /blocklisted sender/i.test(m) && /allowlist/i.test(m)),
    `expected a loud blocklist-vs-allowlist conflict log line, got: ${JSON.stringify(logMessages)}`,
  );
});

test("allowlist mismatch: a different sender in the same thread is skipped and logged with the sender address", async (t) => {
  resetFixtures();
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  writeRegistry([
    { id: "ziptrader", gmailQuery: "from:charlie-from-ziptrader@ghost.io", senderAllowlist: ["charlie-from-ziptrader@ghost.io"], trustTier: "high", maxAgeHours: 72, enabled: true },
  ]);

  MESSAGES = {
    forwarded: { from: "Random Forwarder <forwarder@example.com>", subject: "Fwd: ZipTrader thesis", symbol: "FWD", internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:charlie-from-ziptrader@ghost.io": ["forwarded"] };

  const body = await runSync(port);

  assert.equal(body.analyses.length, 0);
  assert.deepEqual(anthropicCallSymbols, []);

  const logMessages: string[] = body.logs.map((l: any) => l.message);
  assert.ok(
    logMessages.some((m) => /not.*allowlist/i.test(m) && /forwarder@example\.com/i.test(m)),
    `expected a log entry naming the non-allowlisted sender, got: ${JSON.stringify(logMessages)}`,
  );
});

test("the default registry (created on first run) ingests through end-to-end with source id \"ziptrader\"", async (t) => {
  resetFixtures();
  // Delete the registry file written by earlier tests in this file so the
  // default-bootstrap path is exercised for real.
  if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);

  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  MESSAGES = {
    z1: { from: "Charlie <charlie-from-ziptrader@ghost.io>", subject: "ZipTrader default thesis", symbol: "DFLT", internalDateMs: Date.now() - 1000 },
  };
  QUERY_TO_IDS = { "from:charlie-from-ziptrader@ghost.io": ["z1"] };

  const body = await runSync(port);

  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].symbol, "DFLT");

  const reviewed = await getReviewedSignals(port);
  const signal = reviewed.find((s: any) => s.symbol === "DFLT");
  assert.ok(signal);
  assert.equal(signal.source, "ziptrader");

  assert.ok(fs.existsSync(registryPath), "the default registry file should have been created on disk");
});
