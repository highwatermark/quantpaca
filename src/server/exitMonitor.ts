// Wires evaluateExitPlan (src/server/exitEngine.ts) into the per-sync portfolio
// risk controller (MODULE 2 in server.ts). Before this module existed,
// evaluateExitPlan had zero callers: exit plans were computed and persisted for
// every trade but take-profit, time-exit, and plan stop-loss never fired -- the
// only exit that actually executed was a hardcoded 5% unrealized_plpc poll.
//
// This module is intentionally pure (no I/O, no fetch, no DB handle) so the
// wiring decision logic is unit-testable without spinning up the Express app --
// server.ts supplies live position data and a plan-lookup callback and applies
// the returned decisions.
//
// Reconciliation rule (see docs/GO_LIVE_PLAN.md Phase 1.2): a position with a
// valid persisted exit plan is evaluated via evaluateExitPlan ONLY -- the plan's
// own stop-loss dimension is authoritative and the legacy 5% check is skipped
// entirely for that symbol (whether or not the plan triggers). A position with
// no plan, or a plan whose lookup/parse fails, falls back to the legacy 5%
// unrealized_plpc check so the symbol is never left completely unprotected.
import { ExitPlan } from "./tradingSafety";
import { evaluateExitPlan } from "./exitEngine";
import { parseFiniteNumber } from "./numericSafety";

export type ExitPlanRecord = {
  side: "buy" | "sell";
  exitPlan: ExitPlan;
  // Owning trade id, needed to persist a ratcheted high-water mark back to the
  // exit_plans row it came from. Optional so records built without trailing in
  // mind (pre-existing tests, plans predating this feature) keep compiling --
  // a ratchet simply can't be persisted without it (still evaluated in-memory
  // for that one cycle).
  tradeId?: string;
  // Raw persisted high-water mark for this plan. Typed `unknown` (not `number`)
  // because it round-trips through storage and must be treated as untrusted --
  // parsed via parseFiniteNumber below the same way currentPrice/takeProfitPrice
  // already are elsewhere in this module.
  highWaterMark?: unknown;
};

export type OpenPositionSnapshot = {
  symbol: string;
  qty: unknown;
  currentPrice: unknown;
  // Pre-computed percent (e.g. -6.2 for a 6.2% loss), matching the legacy
  // `parseFloat(pos.unrealized_plpc) * 100` convention. NaN if unparsable --
  // NaN never satisfies the `<= -stopPercent` comparison, so an unparsable
  // value already fails closed (no accidental trigger from garbage data).
  unrealizedPlPercent: number;
};

export type PlanExitReason = "take_profit" | "time_exit" | "stop_loss" | "thesis_invalidation" | "regime_change" | "trailing_stop";

export type PlanExitDecision = {
  kind: "plan_exit";
  symbol: string;
  qty: number;
  reason: PlanExitReason;
  reasoning: string;
};

export type LegacyExitDecision = {
  kind: "legacy_stop_loss";
  symbol: string;
  qty: number;
  unrealizedLossPercent: number;
  reasoning: string;
};

export type SkippedPlan = {
  symbol: string;
  message: string;
};

export type ExitEvaluationResult = {
  planExits: PlanExitDecision[];
  legacyExits: LegacyExitDecision[];
  skippedPlans: SkippedPlan[];
};

export function evaluateOpenPositionExits(input: {
  positions: OpenPositionSnapshot[];
  now: Date;
  legacyStopLossPercent: number;
  // Injected rather than reading a store directly, so this stays pure/testable.
  // May throw (e.g. a broken DB handle) -- treated the same as "no plan found":
  // fail closed to the legacy check for that symbol only.
  lookupPlan: (symbol: string) => ExitPlanRecord | undefined;
  // Called at most once per position, only when the high-water mark actually
  // ratchets up this cycle (currentPrice > the stored HWM, both numerically
  // valid). Lets server.ts persist the new HWM without this module touching a
  // DB handle. Optional; omitting it just means ratchets aren't persisted
  // (the freshly-ratcheted value is still used for this cycle's evaluation).
  onHighWaterMarkRatchet?: (tradeId: string, symbol: string, highWaterMark: number) => void;
  // This cycle's regime assessment (Task 9, docs/GO_LIVE_PLAN.md Phase 1.3),
  // supplied by server.ts from the sync-scoped RegimeAssessment (MODULE 2.5).
  // Undefined -- no assessment computed this cycle -- is the fail-closed
  // default: it is never coerced into "close_only", so an absent/degraded
  // regime feed can never liquidate a position.
  //
  // Gated per-plan below on the plan's OWN regimeChangeAction, not just
  // forwarded blindly: evaluateExitPlan's regime dimension is a bare
  // `regimePermission === "close_only"` check with no awareness of the plan
  // shape, so this module is what enforces "only plans that opted into
  // regimeChangeAction 'close' ever liquidate on a regime flip."
  regimePermission?: "allow" | "reduce_size" | "block_new_buys" | "close_only";
  // Recorded in the regime_change reasoning string alongside regimePermission
  // so a liquidation's audit trail names the regime that caused it. Purely
  // descriptive -- never affects the trigger decision above.
  regimeMode?: string;
}): ExitEvaluationResult {
  const planExits: PlanExitDecision[] = [];
  const legacyExits: LegacyExitDecision[] = [];
  const skippedPlans: SkippedPlan[] = [];

  for (const pos of input.positions) {
    const qty = Math.floor(Number(pos.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;

    let record: ExitPlanRecord | undefined;
    try {
      record = input.lookupPlan(pos.symbol);
    } catch (err) {
      skippedPlans.push({
        symbol: pos.symbol,
        message: `Exit plan lookup failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}. Falling back to the legacy stop-loss check.`,
      });
      applyLegacyFallback(pos, input.legacyStopLossPercent, qty, legacyExits);
      continue;
    }

    if (!record) {
      // No persisted plan for this symbol (manual buy predating this feature,
      // a pre-existing position, etc.) -- legacy check is the only safety net.
      applyLegacyFallback(pos, input.legacyStopLossPercent, qty, legacyExits);
      continue;
    }

    const validated = validatePlanInputs(pos, record.exitPlan);
    if (!validated.ok) {
      skippedPlans.push({
        symbol: pos.symbol,
        message: `Exit plan for ${pos.symbol} has an invalid ${validated.field}; skipping plan evaluation this cycle and falling back to the legacy stop-loss check.`,
      });
      applyLegacyFallback(pos, input.legacyStopLossPercent, qty, legacyExits);
      continue;
    }

    // High-water mark: ratchet up in-memory (never down) before evaluating the
    // trailing dimension, so a same-cycle price rise is reflected immediately
    // (matches the acceptance test: price rises 100->120 in one cycle and the
    // trailing threshold is computed off 120 that same cycle). A corrupt/missing
    // stored HWM (fails parseFiniteNumber) fails closed: no ratchet, no persist,
    // trailing simply doesn't evaluate this cycle -- validated.currentPrice was
    // already confirmed finite above, so every other dimension is unaffected.
    const hwmParsed = parseFiniteNumber(record.highWaterMark, "highWaterMark");
    let effectiveHighWaterMark: number | undefined = hwmParsed.ok ? hwmParsed.value : undefined;
    if (effectiveHighWaterMark !== undefined && validated.currentPrice > effectiveHighWaterMark) {
      effectiveHighWaterMark = validated.currentPrice;
      if (record.tradeId) {
        input.onHighWaterMarkRatchet?.(record.tradeId, pos.symbol, effectiveHighWaterMark);
      }
    }

    // Only forward this cycle's regime permission to evaluateExitPlan when the
    // plan itself opted into a "close" regime-change response -- see the
    // regimePermission doc comment above for why this gating lives here and
    // not in exitEngine.ts.
    const regimePermissionForPlan = record.exitPlan.regimeChangeAction === "close" ? input.regimePermission : undefined;

    const evaluation = evaluateExitPlan({
      exitPlan: record.exitPlan,
      side: record.side,
      currentPrice: validated.currentPrice,
      now: input.now,
      regimePermission: regimePermissionForPlan,
      highWaterMark: effectiveHighWaterMark,
    });

    if (evaluation.triggered) {
      planExits.push({
        kind: "plan_exit",
        symbol: pos.symbol,
        qty,
        reason: evaluation.reason as PlanExitReason,
        reasoning: buildPlanReasoning(evaluation.reason as PlanExitReason, record.exitPlan, validated.currentPrice, effectiveHighWaterMark, {
          mode: input.regimeMode,
          permission: regimePermissionForPlan,
        }),
      });
    }
    // Plan present and numerically valid: it owns this symbol's exit decision
    // for this cycle, triggered or not. Deliberately no legacy fallback here --
    // see the reconciliation rule in the module comment above.
  }

  return { planExits, legacyExits, skippedPlans };
}

function applyLegacyFallback(
  pos: OpenPositionSnapshot,
  legacyStopLossPercent: number,
  qty: number,
  out: LegacyExitDecision[],
): void {
  if (!Number.isFinite(pos.unrealizedPlPercent) || pos.unrealizedPlPercent > -legacyStopLossPercent) return;
  out.push({
    kind: "legacy_stop_loss",
    symbol: pos.symbol,
    qty,
    unrealizedLossPercent: pos.unrealizedPlPercent,
    reasoning: `Automatic stop-loss protection executed. Loss of ${pos.unrealizedPlPercent.toFixed(2)}% reached the threshold of -${legacyStopLossPercent}%. Position was automatically liquidated.`,
  });
}

// Flat (non-discriminated-union) return shape deliberately: this project's
// tsconfig does not enable `strict`, and TypeScript's control-flow narrowing
// of a boolean-literal-discriminated union (`ok: true` vs `ok: false`) across
// an if/else branch access is unreliable without strictNullChecks. A flat
// shape with an always-present `currentPrice`/`field` sidesteps that entirely
// (see parseFiniteNumber's ParsedFiniteNumber for the same style of pitfall --
// existing callers only ever narrow it via an early return/continue, never by
// reading a branch-specific property inside the negative check itself).
type PlanValidation = { ok: boolean; field: string; currentPrice: number };

function validatePlanInputs(pos: OpenPositionSnapshot, exitPlan: ExitPlan): PlanValidation {
  const currentPriceResult = parseFiniteNumber(pos.currentPrice, "currentPrice");
  if (!currentPriceResult.ok) return { ok: false, field: "currentPrice", currentPrice: NaN };

  const stopResult = parseFiniteNumber(exitPlan.initialStopLossPrice, "initialStopLossPrice");
  if (!stopResult.ok) return { ok: false, field: "initialStopLossPrice", currentPrice: NaN };

  if (!Number.isFinite(Date.parse(exitPlan.timeExitAt))) return { ok: false, field: "timeExitAt", currentPrice: NaN };

  if (exitPlan.takeProfitPrice !== undefined) {
    const takeProfitResult = parseFiniteNumber(exitPlan.takeProfitPrice, "takeProfitPrice");
    if (!takeProfitResult.ok) return { ok: false, field: "takeProfitPrice", currentPrice: NaN };
  }

  return { ok: true, field: "", currentPrice: currentPriceResult.value };
}

function buildPlanReasoning(
  reason: PlanExitReason,
  plan: ExitPlan,
  currentPrice: number,
  highWaterMark?: number,
  regime?: { mode?: string; permission?: string },
): string {
  switch (reason) {
    case "take_profit":
      return `take_profit hit: target ${Number(plan.takeProfitPrice).toFixed(2)}, current ${currentPrice.toFixed(2)}`;
    case "stop_loss":
      return `stop_loss hit: plan stop ${Number(plan.initialStopLossPrice).toFixed(2)}, current ${currentPrice.toFixed(2)}`;
    case "time_exit":
      return `time_exit hit: plan timeExitAt ${plan.timeExitAt} has passed (current time ${new Date().toISOString()})`;
    case "thesis_invalidation":
      return `thesis_invalidation triggered: ${plan.thesisInvalidation}`;
    case "regime_change":
      return `regime_change triggered: regime mode=${regime?.mode ?? "unknown"}, tradePermission=${regime?.permission ?? "unknown"} (plan regimeChangeAction=${plan.regimeChangeAction})`;
    case "trailing_stop": {
      const hwm = Number(highWaterMark);
      const threshold = hwm * (1 - Number(plan.trailingStopPercent) / 100);
      return `trailing_stop hit: HWM ${hwm.toFixed(2)}, threshold ${threshold.toFixed(2)} (trailing ${plan.trailingStopPercent}%), current ${currentPrice.toFixed(2)}`;
    }
    default:
      return `${reason} triggered by exit plan evaluation`;
  }
}
