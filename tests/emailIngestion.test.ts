import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractEmailScanTarget, GmailMessage } from "../src/server/emailIngestion";
import { createRawSignal } from "../src/server/signalEngine";
import { createProductionStore } from "../src/server/persistence";
import { reviewAndPersistSignal } from "../src/server/signalReviewStep";

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function freshStorePath(name: string) {
  const dbPath = path.join(process.cwd(), "data", name);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  return dbPath;
}

// A fixture shaped like the real Gmail API users.messages.get response
// (format=full): internalDate in epoch millis, nested multipart/alternative
// payload with a base64url-encoded text/plain body.
function multiParagraphFixture(overrides: Partial<GmailMessage> = {}): GmailMessage {
  const body = [
    "Paragraph one: MARA shares slid 10% on Bitcoin volatility this week.",
    "Paragraph two: Fundamentals remain stellar, hash rates are steady, and the pullback looks like a whipsaw rather than a genuine trend reversal.",
    "Paragraph three: We are accumulating on this dip and expect a recovery once broader market volatility subsides.",
  ].join("\n\n");

  return {
    internalDate: "1770000000000", // 2026-02-02T00:00:00.000Z
    snippet: "MARA shares slid 10%...",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "Subject", value: "ZipTrader: MARA Pullback Accumulation" }],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: b64url(body) },
        },
        {
          mimeType: "text/html",
          body: { data: b64url(`<html><body><p>${body.replace(/\n\n/g, "</p><p>")}</p></body></html>`) },
        },
      ],
    },
    ...overrides,
  };
}

test("extracts the real internalDate and full multi-paragraph body from a Gmail message fixture", () => {
  const result = extractEmailScanTarget(multiParagraphFixture());

  assert.equal(result.ok, true);
  assert.equal(result.target.sourceTimestamp, new Date(1770000000000).toISOString());
  assert.equal(result.target.title, "ZipTrader: MARA Pullback Accumulation");
  assert.match(result.target.content, /Paragraph one/);
  assert.match(result.target.content, /Paragraph two/);
  assert.match(result.target.content, /Paragraph three/);
  assert.equal(result.bodyDegraded, false);
  assert.equal(result.bodyTruncated, false);
});

test("falls back to the Date header when internalDate is absent", () => {
  const fixture = multiParagraphFixture();
  delete (fixture as any).internalDate;
  fixture.payload!.headers!.push({ name: "Date", value: "Mon, 02 Feb 2026 00:00:00 +0000" });

  const result = extractEmailScanTarget(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.target.sourceTimestamp, new Date("2026-02-02T00:00:00.000Z").toISOString());
});

test("rejects (fail-closed) a message with no parseable date anywhere -- never defaults to now", () => {
  const fixture = multiParagraphFixture();
  delete (fixture as any).internalDate;
  // No Date header present either.

  const result = extractEmailScanTarget(fixture);

  assert.equal(result.ok, false);
  assert.match(result.reason, /date/i);
});

test("rejects a message with a garbage internalDate and no usable Date header", () => {
  const fixture = multiParagraphFixture({ internalDate: "not-a-number" });

  const result = extractEmailScanTarget(fixture);

  assert.equal(result.ok, false);
});

test("finds a text/plain body nested inside multipart/mixed > multipart/alternative", () => {
  const body = "Deeply nested plain text body for the newsletter thesis.";
  const fixture: GmailMessage = {
    internalDate: "1770000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "Nested" }],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url(body) } },
            { mimeType: "text/html", body: { data: b64url(`<p>${body}</p>`) } },
          ],
        },
        {
          mimeType: "application/pdf",
          body: { data: b64url("ignored-attachment") },
        },
      ],
    },
  };

  const result = extractEmailScanTarget(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.target.content, body);
});

test("falls back to a stripped text/html body when no text/plain part exists", () => {
  const fixture: GmailMessage = {
    internalDate: "1770000000000",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: "HTML only" }],
      body: { data: b64url("<html><body><p>Bullish thesis on <b>PLTR</b>.</p></body></html>") },
    },
  };

  const result = extractEmailScanTarget(fixture);

  assert.equal(result.ok, true);
  assert.match(result.target.content, /Bullish thesis on\s+PLTR/);
  assert.doesNotMatch(result.target.content, /<[a-z]/i);
  assert.equal(result.bodyDegraded, false);
});

test("falls back to the snippet (marked degraded) when no decodable body part exists", () => {
  const fixture: GmailMessage = {
    internalDate: "1770000000000",
    snippet: "Short teaser snippet only.",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "No body parts" }],
      parts: [{ mimeType: "application/pdf", body: { data: b64url("attachment") } }],
    },
  };

  const result = extractEmailScanTarget(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.target.content, "Short teaser snippet only.");
  assert.equal(result.bodyDegraded, true);
});

test("caps the body at 8000 characters and appends a truncation marker only when exceeded", () => {
  const exactly8000 = "a".repeat(8000);
  const over8000 = "b".repeat(8001);

  const atCap = extractEmailScanTarget(multiParagraphFixture({
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "At cap" }],
      body: { data: b64url(exactly8000) },
    },
  }));
  assert.equal(atCap.ok, true);
  assert.equal(atCap.target.content, exactly8000);
  assert.equal(atCap.target.content.length, 8000);
  assert.equal(atCap.bodyTruncated, false);

  const overCap = extractEmailScanTarget(multiParagraphFixture({
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Over cap" }],
      body: { data: b64url(over8000) },
    },
  }));
  assert.equal(overCap.ok, true);
  assert.equal(overCap.target.content.startsWith("b".repeat(8000)), true);
  assert.equal(overCap.target.content.endsWith("\n[truncated]"), true);
  assert.equal(overCap.bodyTruncated, true);
});

test("integration: a real Gmail message dated more than 72h ago is rejected as stale through reviewAndPersistSignal", () => {
  const dbPath = freshStorePath("test-email-ingestion-stale.sqlite");
  const store = createProductionStore(dbPath);

  try {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const staleInternalDate = now.getTime() - 100 * 60 * 60 * 1000; // 100h ago > 72h cap

    const extraction = extractEmailScanTarget(multiParagraphFixture({
      internalDate: String(staleInternalDate),
    }));
    assert.equal(extraction.ok, true);

    const rawSignal = createRawSignal({
      source: "email",
      sourceId: "ziptrader:stale-thesis",
      sourceTimestamp: extraction.target.sourceTimestamp,
      symbol: "MARA",
      thesis: extraction.target.content,
      url: "gmail://ziptrader",
      aiConfidence: 80,
    });

    const reviewed = reviewAndPersistSignal(store, rawSignal, { now });

    assert.equal(reviewed.status, "rejected");
    assert.equal(reviewed.rejectionReason, "stale");
  } finally {
    store.close();
    fs.unlinkSync(dbPath);
  }
});
