// Assembles the final list of scan targets the /api/sync analysis loop feeds to
// Claude. Both the email and YouTube sources used to have a trade-capable
// fallback: fabricated content (a hardcoded "MARA" thesis, a canned "Bullish on
// growth tech" sentiment string) that was substituted whenever the real
// ingestion source came back empty or failed, then silently analyzed as if it
// were real. Per the go-live plan's non-negotiable rule ("no silent fallbacks
// that can trade"), both fallbacks are gone: a failed or empty source now
// contributes zero scan-targets rather than fabricated ones.

import { EmailScanTarget } from "./emailIngestion";

export type YoutubeScanTarget = {
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
      source: "youtube",
      title: "ZipTrader Channel Feed Analyzed",
      content: youtubeResult.sentiment,
      sourceTimestamp: now(),
    });
  }

  return targets;
}
