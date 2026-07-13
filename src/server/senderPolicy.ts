// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4, signal-source registry):
// the sender-level policy applied to every Gmail message BEFORE it is allowed
// to become a scan target. Two layers, checked in a fixed order:
//   1. A global blocklist (brokerage/broker-notification senders) that no
//      registry entry can ever override -- broadening a source's gmailQuery
//      must never let an account-notification email get parsed as a thesis.
//   2. The per-source sender allowlist (exact-match on the parsed From
//      address) -- anything else in the thread (a forward, a reply-all, a
//      different sender entirely) is ignored.
// Blocklist is checked first and always wins, even if an operator mistakenly
// also allowlists a blocked address -- that conflict is reported back to the
// caller so it can be logged loudly rather than silently "working".

// Exact-match blocklist: brokerage trade-confirmation senders named in the
// go-live plan. Lowercase -- comparisons are case-insensitive (From headers
// are compared after lowercasing in parseFromAddress below).
// "fool@premiuminfo.fool.com" (Phase 2 Task 9, docs/GO_LIVE_PLAN.md Phase
// 2.4): Motley Fool's marketing/teaser sender, distinct from the legitimate
// premium recommendation sender "fool@motley.fool.com" -- an exact-match
// entry keeps this precise (a domain-suffix block on "@fool.com" would also
// catch the legitimate sender).
export const GLOBAL_SENDER_BLOCKLIST: readonly string[] = ["noreply@robinhood.com", "titan@investordelivery.com", "fool@premiuminfo.fool.com"];

// Domain-suffix blocklist: any sender address ending in one of these suffixes
// is blocked, regardless of the local part. Anchored with a leading "@" and
// matched via String.endsWith so a lookalike domain that merely CONTAINS the
// suffix as a substring (e.g. "ops@notalpaca.markets.evil.com") does not
// match.
export const GLOBAL_SENDER_BLOCKLIST_DOMAIN_SUFFIXES: readonly string[] = ["@alpaca.markets", "@ealerts.alpaca.markets"];

export type SenderDecision =
  | { outcome: "blocked"; address: string; blocklistConflict: boolean }
  | { outcome: "allowed"; address: string }
  | { outcome: "rejected"; address: string | null };

/**
 * Extracts and normalizes the email address out of a Gmail From header,
 * whether in display-name form ("Name <addr>") or a bare address. Returns
 * null (never a guess) if no non-empty address can be recovered.
 */
export function parseFromAddress(fromHeader: string | undefined | null): string | null {
  if (!fromHeader) return null;
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  const raw = angleMatch ? angleMatch[1] : fromHeader;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isBlocklisted(address: string): boolean {
  if (GLOBAL_SENDER_BLOCKLIST.includes(address)) return true;
  return GLOBAL_SENDER_BLOCKLIST_DOMAIN_SUFFIXES.some((suffix) => address.endsWith(suffix));
}

/**
 * Evaluates a message's From header against the global blocklist and a
 * source's sender allowlist, blocklist first (it always wins). `allowlist`
 * entries are matched case-insensitively against the parsed address.
 */
export function evaluateSender(fromHeader: string | undefined | null, allowlist: readonly string[]): SenderDecision {
  const address = parseFromAddress(fromHeader);
  const normalizedAllowlist = allowlist.map((a) => a.trim().toLowerCase());

  if (address !== null && isBlocklisted(address)) {
    return { outcome: "blocked", address, blocklistConflict: normalizedAllowlist.includes(address) };
  }
  if (address !== null && normalizedAllowlist.includes(address)) {
    return { outcome: "allowed", address };
  }
  return { outcome: "rejected", address };
}
