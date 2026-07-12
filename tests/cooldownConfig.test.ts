import test from "node:test";
import assert from "node:assert/strict";
import { loadCooldownConfig } from "../src/server/cooldownConfig";

test("default cooldown window is 24 hours when env is empty", () => {
  const result = loadCooldownConfig({} as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.symbolCooldownHours, 24);
});

test("env override wins", () => {
  const result = loadCooldownConfig({ QUANTPACA_SYMBOL_COOLDOWN_HOURS: "6" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.symbolCooldownHours, 6);
});

test("0 is a valid explicit escape hatch that disables cooldown", () => {
  const result = loadCooldownConfig({ QUANTPACA_SYMBOL_COOLDOWN_HOURS: "0" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.symbolCooldownHours, 0);
});

test("an unparsable value is a startup error, not a silent default", () => {
  const result = loadCooldownConfig({ QUANTPACA_SYMBOL_COOLDOWN_HOURS: "lots" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors[0].includes("QUANTPACA_SYMBOL_COOLDOWN_HOURS"));
});

test("a negative value is a startup error", () => {
  const result = loadCooldownConfig({ QUANTPACA_SYMBOL_COOLDOWN_HOURS: "-1" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
});

test("a non-finite value (Infinity/NaN) is a startup error", () => {
  const infinite = loadCooldownConfig({ QUANTPACA_SYMBOL_COOLDOWN_HOURS: "Infinity" } as NodeJS.ProcessEnv);
  assert.equal(infinite.ok, false);
  const nan = loadCooldownConfig({ QUANTPACA_SYMBOL_COOLDOWN_HOURS: "NaN" } as NodeJS.ProcessEnv);
  assert.equal(nan.ok, false);
});
