// Gates the LLM's "whipsaw vs. genuine trend reversal" judgment for real, per
// docs/GO_LIVE_PLAN.md Phase 1.1. Before this module existed, whipsawCheck was a
// free-text field pasted into the trade reasoning string -- no code ever branched
// on it, so the headline safety check ("only SELL if trend reversal is verified")
// was decorative. This module is the enforcement point:
//   - A SELL only proceeds if the reversal is verified (whipsawVerdict === "reversal").
//     Otherwise it is downgraded to HOLD -- selling into a whipsaw locks in the dip.
//   - A BUY's confidence is haircut when it is the riskiest entry (buying into a
//     verified downtrend reversal); a whipsaw dip-buy (the strategy's core case) is
//     unaffected; an unclear verdict gets an intermediate haircut.
// Pure and side-effect free so it is unit-testable in isolation from server.ts.

export type WhipsawVerdict = "whipsaw" | "reversal" | "unclear";

export type SignalDecision = "BUY" | "SELL" | "HOLD" | "NONE";

const VALID_VERDICTS: ReadonlySet<string> = new Set<WhipsawVerdict>(["whipsaw", "reversal", "unclear"]);

/**
 * Defensive parse-site validation. The Claude API's structured-output schema
 * enforces the enum, but we never trust a single layer for a safety-critical
 * value: any value other than the three allowed strings -- including missing/
 * undefined (e.g. a persisted analysis row from before this field existed) --
 * fails closed to "unclear", the most conservative interpretation for the
 * actions gated below (blocks SELL, haircuts BUY).
 */
export function normalizeWhipsawVerdict(value: unknown): WhipsawVerdict {
  return typeof value === "string" && VALID_VERDICTS.has(value) ? (value as WhipsawVerdict) : "unclear";
}

// Named constants, not magic numbers -- per the plan, no new env vars for these;
// they are fixed risk-policy constants that live in code.
const BUY_CONFIDENCE_MULTIPLIER: Record<WhipsawVerdict, number> = {
  // Buying a shakeout dip is the strategy's core case: full confidence.
  whipsaw: 1,
  // Cannot determine whipsaw vs. reversal: moderate haircut.
  unclear: 0.75,
  // Buying into a verified downtrend reversal is the riskiest entry: heavy haircut.
  reversal: 0.5,
};

const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 100;

export type WhipsawGateResult = {
  decision: SignalDecision;
  aiConfidence: number;
  whipsawVerdict: WhipsawVerdict;
  /** True when a SELL was downgraded to HOLD by this gate. */
  downgraded: boolean;
  /** Human-readable audit note, present only when downgraded is true. */
  note?: string;
};

/**
 * Gates a signal-analysis decision on the (defensively-validated) whipsaw
 * verdict. HOLD/NONE decisions pass through untouched -- this gate only
 * applies to the two decisions that can move money (BUY/SELL).
 */
export function applyWhipsawGate(
  decision: SignalDecision,
  whipsawVerdictInput: unknown,
  aiConfidence: number,
): WhipsawGateResult {
  const whipsawVerdict = normalizeWhipsawVerdict(whipsawVerdictInput);

  if (decision === "SELL") {
    if (whipsawVerdict !== "reversal") {
      return {
        decision: "HOLD",
        aiConfidence,
        whipsawVerdict,
        downgraded: true,
        note: `SELL downgraded to HOLD: whipsaw verdict is "${whipsawVerdict}", not a verified reversal -- selling into a whipsaw locks in the dip.`,
      };
    }
    return { decision: "SELL", aiConfidence, whipsawVerdict, downgraded: false };
  }

  if (decision === "BUY") {
    const multiplier = BUY_CONFIDENCE_MULTIPLIER[whipsawVerdict];
    const adjusted = clampConfidence(aiConfidence * multiplier);
    return { decision: "BUY", aiConfidence: adjusted, whipsawVerdict, downgraded: false };
  }

  return { decision, aiConfidence, whipsawVerdict, downgraded: false };
}

function clampConfidence(value: number): number {
  return Math.max(MIN_CONFIDENCE, Math.min(MAX_CONFIDENCE, value));
}
