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

test("a strong token in paper mode produces no issues", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    TRADING_MODE: "paper",
  } as NodeJS.ProcessEnv);
  assert.equal(issues.length, 0);
});
