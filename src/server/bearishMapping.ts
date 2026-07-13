// Phase 2 Task 10 (docs/GO_LIVE_PLAN.md Phase 2.4, Priority 2 -- Michael
// Burry Substack): the long-only bearish-mapping decision layer. This is the
// task that makes exitEngine.ts's `thesis_invalidation` exit dimension live
// (tracked since Phase 1 -- see exitEngine.ts's evaluateExitPlan, which has
// accepted a `thesisInvalidated` input since Task 6 but never had a real
// signal source feeding it) and introduces the do-not-buy list.
//
// Generalized, not Burry-special-cased: ANY source's analysis can carry a
// bearish stance (see the `stance` field added to the analysis schema in
// server.ts) -- this module reacts to stance + decision + held-state, never
// to a source id.
//
// Pure and side-effect free, same convention as whipsawGate.ts: this module
// only DECIDES what should happen (thesis_invalidation / do_not_buy /
// contradiction / none); the caller (server.ts, where decisions execute in
// runSyncCycle) is responsible for persisting records, executing the actual
// exit, and writing audit/log entries.

export type Stance = "bullish" | "bearish" | "neutral";

const VALID_STANCES: ReadonlySet<string> = new Set<Stance>(["bullish", "bearish", "neutral"]);

/**
 * Defensive parse-site validation, same shape as whipsawGate.ts's
 * normalizeWhipsawVerdict: the Claude API's structured-output schema enforces
 * the enum, but a single layer is never trusted for a safety-critical value.
 * Anything other than the three allowed strings -- including missing/
 * undefined (e.g. a persisted analysis row from before this field existed, or
 * a source that predates stance) -- fails closed to "neutral", the most
 * conservative interpretation: neutral never trades and never invalidates a
 * thesis.
 */
export function normalizeStance(value: unknown): Stance {
  return typeof value === "string" && VALID_STANCES.has(value) ? (value as Stance) : "neutral";
}

// Named constants, not magic numbers -- per the plan, no new env vars for
// these; they are fixed risk-policy constants that live in code. Both
// default to 30 per the go-live plan's Task 10 brief ("do-not-buy list for N
// days (default 30)"); kept as two separate named constants (rather than one
// shared constant) because they gate conceptually different lists and are
// free to diverge later without a call-site ripple.
export const DO_NOT_BUY_DAYS = 30;
export const THESIS_INVALIDATION_DAYS = 30;

export type SignalDecision = "BUY" | "SELL" | "HOLD" | "NONE";

export type BearishMappingResult =
  | { kind: "thesis_invalidation"; symbol: string; sourceId: string; reason: string; expiresAt: string }
  | { kind: "do_not_buy"; symbol: string; sourceId: string; reason: string; expiresAt: string }
  // decision BUY + stance bearish: a contradiction the schema shouldn't
  // produce (this system never opens shorts, so a bearish call can never be a
  // BUY). The caller treats this as NONE and logs loudly -- this module just
  // classifies it.
  | { kind: "contradiction" }
  | { kind: "none" };

/**
 * Maps a (already whipsaw-gated) signal into a long-only bearish action.
 *
 * Precedence (docs/GO_LIVE_PLAN.md Phase 2.4 Task 10 brief, item 3):
 *   1. The whipsaw gate runs FIRST (server.ts, before this function is ever
 *      called) -- `whipsawDowngraded` reports whether it downgraded this
 *      SELL to HOLD. `originalDecision` is deliberately the PRE-gate decision
 *      (what the source actually said), not the post-gate one: a downgraded
 *      SELL must still be evaluated here for its do-not-buy consequence even
 *      though the trading system's own decision for this cycle is HOLD.
 *   2. decision BUY + stance bearish is a contradiction, checked before
 *      anything else (held-state is irrelevant to a contradiction).
 *   3. decision SELL + stance bearish + HELD: thesis-invalidation marking
 *      applies ONLY when the whipsaw gate did NOT downgrade this SELL (i.e.
 *      reversal was verified) -- a whipsaw-downgraded SELL does NOT
 *      invalidate the thesis and does NOT force an exit. This is the CHOSEN
 *      POLICY, not a derived equivalence: the task brief also floated "OR
 *      the source's trust tier is high" as an alternative invalidation path,
 *      and that alternative IS genuinely reachable (a high-trust source's
 *      SELL can absolutely be whipsaw-downgraded -- the gate has no
 *      awareness of trust tier). The accepted, conservative resolution is
 *      that a downgrade blocks invalidation REGARDLESS of trust tier --
 *      forcing an exit on an unverified reversal is expensive no matter how
 *      trusted the source -- which is why trust tier deliberately does not
 *      appear in this function's inputs at all.
 *   4. decision SELL + stance bearish + UNHELD: do-not-buy applies
 *      regardless of whipsawDowngraded -- avoiding a buy is cheap, forcing an
 *      exit is not, so the unheld case does not need reversal verification.
 */
export function evaluateBearishMapping(input: {
  symbol: string;
  sourceId: string;
  originalDecision: SignalDecision;
  stance: unknown;
  symbolHeld: boolean;
  whipsawDowngraded: boolean;
  now?: Date;
}): BearishMappingResult {
  const stance = normalizeStance(input.stance);
  const now = input.now || new Date();

  if (input.originalDecision === "BUY" && stance === "bearish") {
    return { kind: "contradiction" };
  }

  if (input.originalDecision !== "SELL" || stance !== "bearish") {
    return { kind: "none" };
  }

  if (input.symbolHeld) {
    if (input.whipsawDowngraded) {
      // Whipsaw gate downgraded this SELL to HOLD: reversal not verified.
      // Forcing an exit is expensive -- do not invalidate the thesis and do
      // not force a close on a held position.
      return { kind: "none" };
    }
    return {
      kind: "thesis_invalidation",
      symbol: input.symbol,
      sourceId: input.sourceId,
      reason: `Bearish/short thesis from source "${input.sourceId}" on held symbol ${input.symbol} (whipsaw-verified reversal).`,
      expiresAt: new Date(now.getTime() + THESIS_INVALIDATION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  // Unheld: avoiding a buy is cheap -- add to do-not-buy regardless of
  // whether the whipsaw gate downgraded this SELL.
  return {
    kind: "do_not_buy",
    symbol: input.symbol,
    sourceId: input.sourceId,
    reason: `Bearish/short thesis from source "${input.sourceId}" on unheld symbol ${input.symbol}.`,
    expiresAt: new Date(now.getTime() + DO_NOT_BUY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}
