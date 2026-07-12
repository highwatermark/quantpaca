// Parses a Gmail API message resource (users.messages.get, format=full) into a
// scan target the /api/sync analysis pipeline can feed to Claude. Two things this
// guards against, both defects in the original ingestion code:
//   1. Fabricated timestamps: the signal engine's freshness check
//      (signalEngine.ts, ageHours <= maxAgeHours) is meaningless if sourceTimestamp
//      is always "now". We must capture the message's real send time and, if none
//      can be parsed, reject rather than silently defaulting to now.
//   2. Teaser-only content: analyzing only the ~100-200 char snippet means trade
//      decisions are made without ever reading the newsletter.

const MAX_BODY_CHARS = 8000;
const TRUNCATION_MARKER = "\n[truncated]";

export type GmailHeader = { name: string; value: string };

export type GmailMessagePart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart & { headers?: GmailHeader[] };
};

export type EmailScanTarget = {
  source: "email";
  title: string;
  content: string;
  sourceTimestamp: string;
};

export type EmailExtractionResult =
  | {
      ok: true;
      target: EmailScanTarget;
      /** true if we could not decode a real body and fell back to the snippet. */
      bodyDegraded: boolean;
      /** true if the decoded body exceeded the cap and was truncated. */
      bodyTruncated: boolean;
    }
  | {
      ok: false;
      /** Fail-closed: no valid send time could be established for this message. */
      reason: string;
    };

/**
 * Parses a single Gmail message resource into a scan target with a real
 * sourceTimestamp and the full (capped) decoded body. Fail-closed: if no valid
 * date can be recovered from internalDate or the Date header, returns
 * { ok: false } rather than defaulting to "now" -- the caller must not
 * fabricate a timestamp for a message we can't actually date.
 */
export function extractEmailScanTarget(message: GmailMessage): EmailExtractionResult {
  const sourceTimestamp = extractSourceTimestamp(message);
  if (!sourceTimestamp) {
    return { ok: false, reason: "No valid internalDate or Date header found on Gmail message." };
  }

  const title = extractSubject(message) || "ZipTrader Thesis";
  const { text: rawBody, degraded } = extractBody(message);
  const { text: cappedBody, truncated } = capBody(rawBody);

  return {
    ok: true,
    bodyDegraded: degraded,
    bodyTruncated: truncated,
    target: {
      source: "email",
      title,
      content: cappedBody,
      sourceTimestamp,
    },
  };
}

function extractSubject(message: GmailMessage): string | undefined {
  const header = message.payload?.headers?.find((h) => h.name?.toLowerCase() === "subject");
  return header?.value;
}

function extractSourceTimestamp(message: GmailMessage): string | null {
  return parseInternalDate(message.internalDate) ?? parseHeaderDate(message.payload?.headers);
}

function parseInternalDate(internalDate: string | undefined): string | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseHeaderDate(headers: GmailHeader[] | undefined): string | null {
  const header = headers?.find((h) => h.name?.toLowerCase() === "date");
  if (!header?.value) return null;
  const ms = Date.parse(header.value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function extractBody(message: GmailMessage): { text: string; degraded: boolean } {
  try {
    const plainPart = findPart(message.payload, "text/plain");
    if (plainPart?.body?.data) {
      return { text: decodeBase64Url(plainPart.body.data), degraded: false };
    }
    const htmlPart = findPart(message.payload, "text/html");
    if (htmlPart?.body?.data) {
      return { text: stripHtml(decodeBase64Url(htmlPart.body.data)), degraded: false };
    }
  } catch {
    // Fall through to the snippet fallback below; this is a degraded-content
    // fallback (the email is still real), never a fabricated trade signal.
  }
  return { text: message.snippet || "", degraded: true };
}

function findPart(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const sub of part.parts || []) {
    const found = findPart(sub, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_BODY_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_BODY_CHARS) + TRUNCATION_MARKER, truncated: true };
}
