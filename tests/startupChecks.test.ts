import test from "node:test";
import assert from "node:assert/strict";
import { validateStartupEnv } from "../src/server/startupChecks";

test("placeholder admin token is fatal", () => {
  const issues = validateStartupEnv({ ADMIN_API_TOKEN: "change-me" } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal" && i.message.includes("change-me")));
});

test("short admin token is fatal", () => {
  const issues = validateStartupEnv({ ADMIN_API_TOKEN: "abc123" } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal"));
});

test("missing admin token is a warning, not fatal, in paper mode", () => {
  const issues = validateStartupEnv({ TRADING_MODE: "paper" } as NodeJS.ProcessEnv);
  assert.ok(issues.every((i) => i.level === "warn"));
  assert.ok(issues.some((i) => i.message.includes("ADMIN_API_TOKEN")));
});

test("live trading without an admin token is fatal", () => {
  const issues = validateStartupEnv({
    TRADING_MODE: "live",
    LIVE_TRADING_ENABLED: "true",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal"));
});

test("a strong admin token AND a strong read token in paper mode produce no issues", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    QUANTPACA_READ_TOKEN: "a-real-read-only-token-0123456789",
    TRADING_MODE: "paper",
  } as NodeJS.ProcessEnv);
  assert.equal(issues.length, 0);
});

// --- QUANTPACA_READ_TOKEN (Phase 2 Task 13, docs/GO_LIVE_PLAN.md Phase 2.5) ---
// Same validation shape as ADMIN_API_TOKEN above: refuse a placeholder/short
// value IF set; if unset, read endpoints fall back to requiring the ADMIN
// token (server.ts's requireReadToken) -- so an unset read token is only ever
// a WARNING, never fatal, regardless of trading mode.

test("placeholder read token is fatal", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    QUANTPACA_READ_TOKEN: "change-me",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal" && i.message.includes("QUANTPACA_READ_TOKEN") && i.message.includes("change-me")));
});

test("short read token is fatal", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    QUANTPACA_READ_TOKEN: "abc123",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal" && i.message.includes("QUANTPACA_READ_TOKEN")));
});

test("missing read token is a warning (not fatal), recommending one be set", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    TRADING_MODE: "paper",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.every((i) => i.level === "warn"));
  assert.ok(issues.some((i) => i.message.includes("QUANTPACA_READ_TOKEN")));
});

test("missing read token is still only a warning even in live trading mode (reads never gate live trading)", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    TRADING_MODE: "live",
    LIVE_TRADING_ENABLED: "true",
  } as NodeJS.ProcessEnv);
  const readTokenIssues = issues.filter((i) => i.message.includes("QUANTPACA_READ_TOKEN"));
  assert.ok(readTokenIssues.length > 0);
  assert.ok(readTokenIssues.every((i) => i.level === "warn"));
});

test("a strong read token together with a placeholder admin token still reports the admin token as fatal", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "change-me",
    QUANTPACA_READ_TOKEN: "a-real-read-only-token-0123456789",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal" && i.message.includes("ADMIN_API_TOKEN")));
});

// --- Google OAuth broker env vars (Phase 2 follow-up: server-side Gmail
// refresh-token auth, docs/GO_LIVE_PLAN.md sign-off item 2) ---
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are
// all-or-nothing: a partial set would silently leave scheduled email
// ingestion inert (the broker reports "not configured" for ANY missing var)
// instead of failing loudly, so 1-of-3 or 2-of-3 present is fatal at boot.
// Zero present is a legitimate "not using the broker" config (existing
// browser-header-only behavior); three present is the fully-configured case.
// Both boot cleanly.

const baseAdminEnv = { ADMIN_API_TOKEN: "a-real-secret-token-0123456789" } as NodeJS.ProcessEnv;

test("zero Google OAuth broker env vars set is not fatal (broker simply unused)", () => {
  const issues = validateStartupEnv(baseAdminEnv);
  assert.ok(issues.every((i) => i.level !== "fatal"));
});

test("all three Google OAuth broker env vars set is not fatal", () => {
  const issues = validateStartupEnv({
    ...baseAdminEnv,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.every((i) => i.level !== "fatal"));
});

test("exactly one of the three Google OAuth broker env vars set is fatal", () => {
  const issues = validateStartupEnv({ ...baseAdminEnv, GOOGLE_CLIENT_ID: "client-id" } as NodeJS.ProcessEnv);
  assert.ok(
    issues.some((i) => i.level === "fatal" && /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN/.test(i.message)),
    `expected a fatal partial-config issue, got: ${JSON.stringify(issues)}`,
  );
});

test("exactly two of the three Google OAuth broker env vars set is fatal", () => {
  const issues = validateStartupEnv({
    ...baseAdminEnv,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
  } as NodeJS.ProcessEnv);
  assert.ok(
    issues.some((i) => i.level === "fatal" && /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN/.test(i.message)),
    `expected a fatal partial-config issue, got: ${JSON.stringify(issues)}`,
  );
  // Every combination of exactly-2-of-3 is fatal, not just this one pairing.
  const otherPairs = [
    { GOOGLE_CLIENT_ID: "x", GOOGLE_REFRESH_TOKEN: "y" },
    { GOOGLE_CLIENT_SECRET: "x", GOOGLE_REFRESH_TOKEN: "y" },
  ];
  for (const pair of otherPairs) {
    const pairIssues = validateStartupEnv({ ...baseAdminEnv, ...pair } as NodeJS.ProcessEnv);
    assert.ok(pairIssues.some((i) => i.level === "fatal"), `expected fatal for ${JSON.stringify(pair)}`);
  }
});

test("the partial-Google-config fatal message never echoes a secret value", () => {
  const issues = validateStartupEnv({
    ...baseAdminEnv,
    GOOGLE_CLIENT_ID: "super-secret-client-id-value",
    GOOGLE_CLIENT_SECRET: "super-secret-client-secret-value",
  } as NodeJS.ProcessEnv);
  const fatal = issues.find((i) => i.level === "fatal" && /GOOGLE_/.test(i.message));
  assert.ok(fatal);
  assert.ok(!fatal!.message.includes("super-secret-client-id-value"));
  assert.ok(!fatal!.message.includes("super-secret-client-secret-value"));
});
