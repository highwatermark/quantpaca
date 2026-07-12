// Assembles the final list of scan targets the /api/sync analysis loop feeds to
// Claude. Both the email and YouTube sources used to have a trade-capable
// fallback: fabricated content (a hardcoded "MARA" thesis, a canned "Bullish on
// growth tech" sentiment string) that was substituted whenever the real
// ingestion source came back empty or failed, then silently analyzed as if it
// were real. Per the go-live plan's non-negotiable rule ("no silent fallbacks
// that can trade"), both fallbacks are gone: a failed or empty source now
// contributes zero scan-targets rather than fabricated ones.

import { TrustTier } from "./domainTypes";

// Phase 2 Task 8 (docs/GO_LIVE_PLAN.md Phase 2.4, signal-source registry):
// this is the ENRICHED email scan target -- distinct from
// emailIngestion.ts's own `EmailScanTarget` (the raw per-message extraction
// result, still literal `source: "email"`, unchanged by this task). The
// caller (server.ts's per-source ingestion loop) stamps the registry's own
// id onto `source` (replacing the old generic "email"), plus the additive
// `trustTier`/`maxAgeHours` carried straight through from that source's
// registry entry. `kind` is the discriminant used to tell an email target
// apart from a YoutubeScanTarget below -- `source` itself can no longer do
// that job now that it holds an arbitrary registry id instead of a fixed
// literal.
export type EmailScanTarget = {
  kind: "email";
  source: string;
  title: string;
  content: string;
  sourceTimestamp: string;
  messageId?: string;
  trustTier: TrustTier;
  maxAgeHours: number;
};

// Unchanged by this task -- registry governs email sources only (task
// brief). Gains the `kind` discriminant additively for symmetry with
// EmailScanTarget above; `source` stays the literal "youtube" it always was.
export type YoutubeScanTarget = {
  kind: "youtube";
  source: "youtube";
  title: string;
  content: string;
  sourceTimestamp: string;
};

export type ScanTarget = EmailScanTarget | YoutubeScanTarget;

export type YoutubeSentimentResult =
  | { ok: true; sentiment: string }
  | { ok: false; reason: string };

/**
 * Combines real email scan-targets with a YouTube scan-target derived from a
 * web-search sentiment result. If the sentiment call failed or returned no
 * usable content, no YouTube target is added -- there is no canned fallback
 * string to fall back on. Failed/empty email ingestion is handled by the
 * caller simply passing an empty emailsToScan array; this function never
 * fabricates content for either source.
 */
export function assembleScanTargets(
  emailsToScan: EmailScanTarget[],
  youtubeResult: YoutubeSentimentResult,
  now: () => string = () => new Date().toISOString(),
): ScanTarget[] {
  const targets: ScanTarget[] = [...emailsToScan];

  if (youtubeResult.ok) {
    targets.push({
      kind: "youtube",
      source: "youtube",
      title: "ZipTrader Channel Feed Analyzed",
      content: youtubeResult.sentiment,
      sourceTimestamp: now(),
    });
  }

  return targets;
}
