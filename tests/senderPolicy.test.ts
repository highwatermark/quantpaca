import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSender, parseFromAddress, GLOBAL_SENDER_BLOCKLIST, GLOBAL_SENDER_BLOCKLIST_DOMAIN_SUFFIXES } from "../src/server/senderPolicy";

// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4): the blocklist-beats-
// allowlist sender policy that sits between a fetched Gmail message and the
// analysis pipeline. Pure unit tests -- no Gmail/server wiring here (see
// tests/signalSourceRegistryIngestion.test.ts for the end-to-end acceptance
// test with a real trade-confirmation fixture).

test("parseFromAddress extracts the address out of display-name form", () => {
  assert.equal(parseFromAddress("Charlie <charlie-from-ziptrader@ghost.io>"), "charlie-from-ziptrader@ghost.io");
});

test("parseFromAddress lowercases and trims the extracted address", () => {
  assert.equal(parseFromAddress("Charlie <Charlie-From-ZipTrader@Ghost.IO>  "), "charlie-from-ziptrader@ghost.io");
});

test("parseFromAddress accepts a bare address with no display name", () => {
  assert.equal(parseFromAddress("noreply@robinhood.com"), "noreply@robinhood.com");
});

test("parseFromAddress returns null for an absent or empty header", () => {
  assert.equal(parseFromAddress(undefined), null);
  assert.equal(parseFromAddress(""), null);
  assert.equal(parseFromAddress("   "), null);
});

test("evaluateSender allows an exact allowlist match parsed from display-name form", () => {
  const decision = evaluateSender("Charlie <charlie-from-ziptrader@ghost.io>", ["charlie-from-ziptrader@ghost.io"]);
  assert.equal(decision.outcome, "allowed");
  assert.equal(decision.address, "charlie-from-ziptrader@ghost.io");
});

test("evaluateSender rejects a different sender in the same thread (forwarded mail)", () => {
  const decision = evaluateSender("Some Forwarder <forwarder@example.com>", ["charlie-from-ziptrader@ghost.io"]);
  assert.equal(decision.outcome, "rejected");
  assert.equal(decision.address, "forwarder@example.com");
});

test("evaluateSender rejects when the From header is unparsable, never guessing a match", () => {
  const decision = evaluateSender(undefined, ["charlie-from-ziptrader@ghost.io"]);
  assert.equal(decision.outcome, "rejected");
  assert.equal(decision.address, null);
});

test("evaluateSender blocks an exact-match blocklisted sender even when not on the allowlist", () => {
  const decision = evaluateSender("no-reply@robinhood.com".replace("no-reply", "noreply"), ["charlie-from-ziptrader@ghost.io"]);
  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.address, "noreply@robinhood.com");
  assert.equal(decision.blocklistConflict, false);
});

test("evaluateSender blocks Titan@investordelivery.com case-insensitively", () => {
  const decision = evaluateSender("Titan Alerts <Titan@InvestorDelivery.com>", []);
  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.address, "titan@investordelivery.com");
});

test("evaluateSender blocks any sender on the @alpaca.markets domain suffix", () => {
  const decision = evaluateSender("Alpaca Notifications <notify@alpaca.markets>", []);
  assert.equal(decision.outcome, "blocked");
});

test("evaluateSender blocks any sender on the @ealerts.alpaca.markets domain suffix", () => {
  const decision = evaluateSender("Alerts <trade-confirm@ealerts.alpaca.markets>", []);
  assert.equal(decision.outcome, "blocked");
});

test("evaluateSender does NOT block a lookalike domain that merely contains the suffix as a substring, not a real suffix", () => {
  // e.g. "notalpaca.markets.evil.com" must not match "@alpaca.markets" -- the
  // suffix check must anchor on the address boundary (endsWith), not a bare
  // substring search.
  const decision = evaluateSender("Someone <ops@notalpaca.markets.evil.com>", []);
  assert.equal(decision.outcome, "rejected");
});

test("blocklist wins even when an operator mistakenly allowlists a blocked sender -- loud conflict flag", () => {
  const decision = evaluateSender("noreply@robinhood.com", ["noreply@robinhood.com"]);
  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.blocklistConflict, true);
});

test("the exact-match blocklist constants contain the two brokerage addresses named in the plan", () => {
  assert.ok(GLOBAL_SENDER_BLOCKLIST.includes("noreply@robinhood.com"));
  assert.ok(GLOBAL_SENDER_BLOCKLIST.includes("titan@investordelivery.com"));
});

test("the domain-suffix blocklist constants contain both alpaca notification domains", () => {
  assert.ok(GLOBAL_SENDER_BLOCKLIST_DOMAIN_SUFFIXES.includes("@alpaca.markets"));
  assert.ok(GLOBAL_SENDER_BLOCKLIST_DOMAIN_SUFFIXES.includes("@ealerts.alpaca.markets"));
});
