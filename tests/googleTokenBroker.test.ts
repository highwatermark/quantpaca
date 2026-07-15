// Phase 2 follow-up: server-side Gmail refresh-token auth (unattended
// scheduled cycles). This module exchanges a long-lived GOOGLE_REFRESH_TOKEN
// for a short-lived Gmail access token (https://oauth2.googleapis.com/token),
// caching it in-memory until 5 minutes before expiry, single-flight (two
// concurrent callers await ONE exchange), and fails closed -- any of the
// three GOOGLE_* env vars absent means "not configured" (null, no fetch,
// logged once), and an exchange failure means null + log (never throws).
import test from "node:test";
import assert from "node:assert/strict";
import {
  getBrokerAccessToken,
  getBrokerAuthHeader,
  isGoogleTokenBrokerConfigured,
  resetGoogleTokenBrokerForTests,
} from "../src/server/googleTokenBroker";

const ENV = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REFRESH_TOKEN: "test-refresh-token",
} as NodeJS.ProcessEnv;

function fetchStub(responses: Array<() => Response>) {
  let calls = 0;
  const urls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return next();
  }) as typeof fetch;
  return { fn, urls, callCount: () => calls };
}

function tokenResponse(accessToken: string, expiresInSeconds: number) {
  return () =>
    new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresInSeconds, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

test("not-configured (any of the three env vars missing) returns null without ever calling fetch", async () => {
  resetGoogleTokenBrokerForTests();
  const logs: string[] = [];
  const { fn, callCount } = fetchStub([tokenResponse("should-never-be-used", 3600)]);

  const partials: NodeJS.ProcessEnv[] = [
    { GOOGLE_CLIENT_SECRET: "x", GOOGLE_REFRESH_TOKEN: "y" } as NodeJS.ProcessEnv,
    { GOOGLE_CLIENT_ID: "x", GOOGLE_REFRESH_TOKEN: "y" } as NodeJS.ProcessEnv,
    { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" } as NodeJS.ProcessEnv,
    {} as NodeJS.ProcessEnv,
  ];

  for (const env of partials) {
    resetGoogleTokenBrokerForTests();
    assert.equal(isGoogleTokenBrokerConfigured(env), false);
    const token = await getBrokerAccessToken({ env, fetchImpl: fn, log: (m) => logs.push(m) });
    assert.equal(token, null);
  }
  assert.equal(callCount(), 0, "not-configured must never call fetch");
});

test("not-configured is logged exactly once even across many calls (not per cycle)", async () => {
  resetGoogleTokenBrokerForTests();
  const logs: string[] = [];
  const env = {} as NodeJS.ProcessEnv;
  for (let i = 0; i < 5; i++) {
    await getBrokerAccessToken({ env, log: (m) => logs.push(m) });
  }
  assert.equal(logs.length, 1, `expected exactly one not-configured log line, got: ${JSON.stringify(logs)}`);
});

test("full configuration exchanges the refresh token for an access token and never logs the token values", async () => {
  resetGoogleTokenBrokerForTests();
  const logs: string[] = [];
  const { fn, urls } = fetchStub([tokenResponse("fixture-access-token-abc", 3600)]);

  const token = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, log: (m) => logs.push(m) });
  assert.equal(token, "fixture-access-token-abc");
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://oauth2.googleapis.com/token");

  for (const line of logs) {
    assert.ok(!line.includes("fixture-access-token-abc"), `log line leaked the access token: ${line}`);
    assert.ok(!line.includes(ENV.GOOGLE_REFRESH_TOKEN as string), `log line leaked the refresh token: ${line}`);
  }
});

test("getBrokerAuthHeader wraps the access token as a Bearer header", async () => {
  resetGoogleTokenBrokerForTests();
  const { fn } = fetchStub([tokenResponse("fixture-access-token-xyz", 3600)]);
  const header = await getBrokerAuthHeader({ env: ENV, fetchImpl: fn });
  assert.equal(header, "Bearer fixture-access-token-xyz");
});

test("getBrokerAuthHeader returns null when not configured", async () => {
  resetGoogleTokenBrokerForTests();
  const header = await getBrokerAuthHeader({ env: {} as NodeJS.ProcessEnv, log: () => {} });
  assert.equal(header, null);
});

test("a cached token is reused (no second fetch) until 5 minutes before expiry", async () => {
  resetGoogleTokenBrokerForTests();
  const { fn, callCount } = fetchStub([tokenResponse("cached-token", 3600)]);
  let nowMs = 1_000_000;
  const now = () => nowMs;

  const first = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, now });
  assert.equal(first, "cached-token");
  assert.equal(callCount(), 1);

  // 50 minutes later -- well within the cached lifetime (expires in 60 min,
  // 5-min early-refresh margin means it's still valid until ~55 min in).
  nowMs += 50 * 60 * 1000;
  const second = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, now });
  assert.equal(second, "cached-token");
  assert.equal(callCount(), 1, "a still-valid cached token must not trigger a second fetch");
});

test("the cache refreshes once within 5 minutes of expiry", async () => {
  resetGoogleTokenBrokerForTests();
  const { fn, callCount } = fetchStub([tokenResponse("token-1", 3600), tokenResponse("token-2", 3600)]);
  let nowMs = 1_000_000;
  const now = () => nowMs;

  const first = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, now });
  assert.equal(first, "token-1");
  assert.equal(callCount(), 1);

  // 56 minutes later -- inside the 5-minute early-refresh window (expires at 60 min).
  nowMs += 56 * 60 * 1000;
  const second = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, now });
  assert.equal(second, "token-2");
  assert.equal(callCount(), 2, "a token within 5 minutes of expiry must trigger a fresh exchange");
});

test("exchange failure (non-OK response) returns null and logs, without throwing", async () => {
  resetGoogleTokenBrokerForTests();
  const logs: string[] = [];
  const fn = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;

  const token = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, log: (m) => logs.push(m) });
  assert.equal(token, null);
  assert.ok(logs.length > 0, "expected an exchange-failure log line");
});

test("exchange failure (network error) returns null and logs, without throwing", async () => {
  resetGoogleTokenBrokerForTests();
  const logs: string[] = [];
  const fn = (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;

  const token = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, log: (m) => logs.push(m) });
  assert.equal(token, null);
  assert.ok(logs.some((m) => /simulated network failure/.test(m)));
});

test("a malformed success response (missing access_token or expires_in) returns null and logs", async () => {
  resetGoogleTokenBrokerForTests();
  const logs: string[] = [];
  const fn = (async () =>
    new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const token = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, log: (m) => logs.push(m) });
  assert.equal(token, null);
  assert.ok(logs.length > 0);
});

test("a failed exchange does not poison the cache -- the next call retries", async () => {
  resetGoogleTokenBrokerForTests();
  let attempt = 0;
  const fn = (async () => {
    attempt++;
    if (attempt === 1) return new Response("server error", { status: 500 });
    return new Response(JSON.stringify({ access_token: "recovered-token", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const first = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, log: () => {} });
  assert.equal(first, null);
  const second = await getBrokerAccessToken({ env: ENV, fetchImpl: fn, log: () => {} });
  assert.equal(second, "recovered-token");
  assert.equal(attempt, 2);
});

test("single-flight: two concurrent callers trigger exactly one exchange and both resolve to the same token", async () => {
  resetGoogleTokenBrokerForTests();
  let resolveFetch: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  let calls = 0;
  const fn = (async () => {
    calls++;
    return pending;
  }) as typeof fetch;

  const p1 = getBrokerAccessToken({ env: ENV, fetchImpl: fn });
  const p2 = getBrokerAccessToken({ env: ENV, fetchImpl: fn });

  // Let the exchange resolve.
  resolveFetch!(
    new Response(JSON.stringify({ access_token: "single-flight-token", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const [t1, t2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1, "exactly one exchange must have been issued for two concurrent callers");
  assert.equal(t1, "single-flight-token");
  assert.equal(t2, "single-flight-token");
});

test("the request is a POST, form-encoded, with grant_type=refresh_token", async () => {
  resetGoogleTokenBrokerForTests();
  let capturedInit: RequestInit | undefined;
  const fn = (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await getBrokerAccessToken({ env: ENV, fetchImpl: fn });
  assert.equal(capturedInit?.method, "POST");
  const body = String(capturedInit?.body ?? "");
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("client_id"), ENV.GOOGLE_CLIENT_ID);
  assert.equal(params.get("client_secret"), ENV.GOOGLE_CLIENT_SECRET);
  assert.equal(params.get("refresh_token"), ENV.GOOGLE_REFRESH_TOKEN);
});
