// Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, "Cross-source confirmation
// bonus"): when >=2 enabled sources agree (bullish) on the same symbol within
// a bounded time window, the second (and any later) corroborating signal's
// confidence gets a single, bounded boost; when sources DISAGREE (one bullish,
// one bearish) on the same symbol within that window, the bullish side's
// trade intent must fail toward a human, not auto-resolve.
//
// Pure and side-effect free, same convention as whipsawGate.ts and
// bearishMapping.ts: this module only DECIDES the effect (boost / conflict /
// none); the caller (server.ts) is responsible for querying persistence for
// `recentSignals`, applying the boost to confidence, routing a conflict into
// the risk engine's additive input, logging, and persisting the applied
// effect on the signal record (the `crossSource` field).

export type Stance = "bullish" | "bearish" | "neutral";

// Named constants, not magic numbers -- per the plan, no new env vars for
// these; they are fixed policy constants that live in code.
export const CROSS_SOURCE_WINDOW_HOURS = 72;
// Single, bounded multiplier -- deliberately independent of how many OTHER
// sources agree (2 agreeing sources and 5 agreeing sources both produce
// exactly this multiplier, never a stacked one). The final confidence is
// still clamped to [0, 100] by the caller (same clamp normalizeConfidence
// already applies in signalEngine.ts), so this is bounded twice over.
export const CROSS_SOURCE_BOOST_MULTIPLIER = 1.2;

// A signal from another source, already known to be for the SAME symbol as
// the one being evaluated (the caller's persistence query --
// recentAcceptedSignalsForSymbol -- filters by symbol; this module does not
// re-derive that filter, it has no symbol field to check it against on each
// entry). `source` and `sourceTimestamp` mirror ReviewedSignal's own fields
// exactly so the caller can pass persisted signals through with no reshaping
// beyond picking these three fields off.
export type CrossSourceSignal = {
  source: string;
  stance: Stance;
  sourceTimestamp: string;
};

export type CrossSourceResult =
  | { effect: "boost"; multiplier: number }
  | { effect: "conflict" }
  | { effect: "none" };

/**
 * Evaluates whether `recentSignals` (candidate corroborating/conflicting
 * signals for the SAME symbol, from potentially many other sources) agree
 * with or conflict against the CURRENT signal's own stance.
 *
 * Precedence:
 *   1. A neutral current stance is always inert -- neutral never trades, so
 *      it can neither be boosted nor flagged as conflicting (mirrors
 *      bearishMapping.ts's/normalizeStance's "neutral never trades and never
 *      invalidates a thesis" convention).
 *   2. Same-source repeats never count: an entry whose `source` matches
 *      `currentSource` is filtered out before agreement/conflict is
 *      evaluated -- a source re-affirming the same call via a different
 *      email must not self-boost (or self-conflict).
 *   3. Only entries within CROSS_SOURCE_WINDOW_HOURS of `now` (inclusive of
 *      the boundary itself) count; an unparsable sourceTimestamp is excluded
 *      defensively rather than treated as in-window.
 *   4. Conflict wins over boost: ANY other-source bearish signal while the
 *      current stance is bullish (or vice versa) is a conflict, checked
 *      before agreement -- per the plan, "conflicts always fail toward human
 *      review, never auto-resolution," even when an agreeing source is also
 *      present.
 *   5. Boost only ever applies to a bullish current stance (this is a
 *      long-only system; only a BUY-side confidence bonus makes sense) with
 *      >=1 other bullish source in the window.
 */
export function evaluateCrossSource(input: {
  symbol: string;
  currentSource: string;
  stance: Stance;
  recentSignals: CrossSourceSignal[];
  now?: Date;
}): CrossSourceResult {
  if (input.stance === "neutral") return { effect: "none" };

  const now = input.now || new Date();
  const relevant = input.recentSignals.filter((signal) => {
    if (signal.source === input.currentSource) return false;
    const sourceTime = Date.parse(signal.sourceTimestamp);
    if (!Number.isFinite(sourceTime)) return false;
    const ageHours = (now.getTime() - sourceTime) / 36e5;
    return ageHours >= 0 && ageHours <= CROSS_SOURCE_WINDOW_HOURS;
  });

  const opposingStance: Stance = input.stance === "bullish" ? "bearish" : "bullish";
  const hasConflict = (input.stance === "bullish" || input.stance === "bearish") &&
    relevant.some((signal) => signal.stance === opposingStance);
  if (hasConflict) return { effect: "conflict" };

  if (input.stance === "bullish" && relevant.some((signal) => signal.stance === "bullish")) {
    return { effect: "boost", multiplier: CROSS_SOURCE_BOOST_MULTIPLIER };
  }

  return { effect: "none" };
}
