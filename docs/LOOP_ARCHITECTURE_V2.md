# Quantpaca Loop Architecture v2 — Redesign for Self-Learning/Self-Evolving Safety

**Date:** 2026-06-30
**Supersedes/extends:** `docs/LOOP_ARCHITECTURE.md` (v1) and `docs/LOOP_ARCHITECTURE_REVIEW.md`
**Purpose:** v1 correctly separates "agents propose" from "deterministic core decides," and it correctly fixes the bugs found in `docs/PRODUCTION_READINESS_REVIEW.md`. But evaluated specifically as a foundation for a system that learns and evolves itself, v1 has six structural gaps — it relies on *discipline* (rules loops are supposed to follow) in places where it needs *mechanism* (rules the system makes impossible to break). This document keeps everything in v1 that already works and redesigns the parts that don't.

Six problems, six fixes, and a revised inventory follow.

## Correcting the framing

The loop architecture is not net-negative. It's strictly better than the monolith on every axis the production review actually tested. The claim is narrower: the *specific* properties that matter for self-learning/self-evolving — atomicity of decision-to-execution, immutability of safety thresholds, statistical rigor in what gets promoted, and traceability of why any given trade happened — are not automatic consequences of "use loops." They have to be designed in explicitly. v1 names the right problems (it says "no weaker risk function," it says "AI output is untrusted input") but expresses the fix as a rule for humans to remember rather than a mechanism the system enforces. v2's job is to convert each of those rules into something a bug can't silently violate.

## The six fixes

### Fix 1 — Collapse the execution path into one atomic actor (kills the TOCTOU race)

**Problem:** v1 treats Sizing, Risk Review, Exit Plan, Approval, and Broker Writer as five independently-scheduled loops connected by persisted state. Between "risk approved this intent" and "broker writer submits it," another loop can change the portfolio (a different trade fills, the drawdown breaker trips) and nothing re-checks.

**Fix:** Replace the five polling loops with a single **Trade Execution Actor** — one logical, serialized writer that runs Sizing → Risk Review → Exit Plan Attach → Broker Submit as one transaction per candidate, not five independently-timed jobs. It is triggered per-candidate (event-driven, not polled), and it holds a single in-process lock for the duration of one trade decision so no other actor instance can interleave. Concretely:

```text
Candidate Builder Loop (read-only, many instances OK)
  -> enqueues TradeCandidate to a single in-memory inbox

Trade Execution Actor (exactly one running instance, ever)
  1. dequeue candidate
  2. fetch FRESH portfolio + breaker state (not cached) inside the transaction
  3. size -> risk review -> exit plan, all against that fresh snapshot
  4. if human approval required: persist PendingApproval, release lock, exit
     (re-acquire and re-run steps 2-3 fresh when approval arrives — approval
      does not skip re-validation, it re-enters at step 2)
  5. if approved: submit to broker inside the same transaction
  6. commit state transition + audit event atomically
  7. release lock, return to step 1
```

The "exactly one running instance" property is what eliminates the race — it's the same reason a single-threaded event loop doesn't need locks around in-memory state. Read-only observer loops (Portfolio Observer, Regime Detection, Drawdown Breaker) can run concurrently and freely; only the actor that actually writes trade-affecting state is serialized.

**Why this doesn't reintroduce the monolith's problem:** the monolith's flaw wasn't synchronicity, it was that *everything* — including slow integrations and unrelated concerns — shared one execution context. The Trade Execution Actor only owns the five steps that must be atomic; signal ingestion, Telegram, Notion, Sheets, calibration, and evolution stay fully decoupled loops exactly as in v1.

### Fix 2 — Make the NaN-bypass bug a type error, not a discipline error

**Problem:** "Invalid risk inputs must fail closed" is a sentence in v1, not something the type system enforces. Across 15+ loops, the odds that one engineer (or one agent-written loop) writes `if (x < limit)` instead of `parseFiniteNumber(x)` first are non-trivial, and v1 has no mechanism to catch it besides code review.

**Fix:** Introduce a branded type that can only be constructed by the validator:

```ts
type FiniteNumber = number & { readonly __brand: "FiniteNumber" };

function parseFiniteNumber(raw: unknown, field: string): FiniteNumber | { ok: false; field: string } {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? (n as FiniteNumber) : { ok: false, field };
}
```

Every function signature in the risk/breaker/sizing path takes `FiniteNumber`, never `number`. A raw `number` (from `req.body`, from a config file, from a broker response) cannot be passed into a risk comparison without going through `parseFiniteNumber` first — TypeScript rejects the call at compile time, not at review time. This is a few hours of work and it converts an entire class of bug (the one actually found in `riskEngine.ts`) from "possible if someone's careless" to "impossible to compile."

Pair this with one shared **safety property test suite** that every loop touching money must pass: inject `NaN`, `Infinity`, `undefined`, `null`, `""`, and an unparsable string at every numeric boundary, assert the result is always a rejection/breaker-trip, never a silent pass-through. Run it against every loop, not just `riskEngine.ts` — this is what actually scales the v1 rule across 15+ loops instead of hoping each one independently remembers it.

### Fix 3 — Correlation IDs and a decision-lineage view, built in from Phase 2

**Problem:** v1's audit trail is real but unindexed for the question that matters most for a self-evolving system: "why did this trade happen, and was the decision correct given what was known at the time?" Reconstructing that across 8+ loops without tooling is the debugging cost flagged earlier.

**Fix:** Every `RawSignal` is assigned a `correlationId` at ingestion. Every downstream record — `ReviewedSignal`, `TradeCandidate`, `SizedTradeIntent`, `RiskDecision`, `ExitPlan`, `BrokerOrder`, `BrokerFill`, `PerformanceAttributionRecord` — carries that same `correlationId` plus the `strategyVersion`/`promptVersion` active when it was created. Add one read-only query/view (`decision_lineage`) that joins all of these by `correlationId` into a single ordered timeline. This is infrastructure, not optional polish — it belongs in v1's existing "Phase 2: Loop Infrastructure" alongside checkpoints and heartbeats, because the Outcome Attribution Loop (and any human debugging a bad trade) needs it to function at all.

### Fix 4 — A promotion gate with actual statistical teeth, rate-limited and magnitude-capped

**Problem:** v1's earlier review proposed a Promotion Gate but didn't specify what would stop a Strategy Evolution Loop from finding a degenerate but metric-flattering parameter set (Goodhart's law) — e.g., overfitting to three weeks of a trending market, or improving raw P&L by quietly increasing concentration risk.

**Fix:** The Promotion Gate requires, all of:

- **Multiple uncorrelated metrics**, not one. A challenger must not regress on *any* of: realized P/L, max drawdown, Sharpe-equivalent, win-rate stability across sub-periods, and position concentration — improving P/L while regressing drawdown is a reject, not a tradeoff the loop gets to make unilaterally.
- **Walk-forward validation, not a single in-sample backtest.** Shadow evaluation must span at least two non-overlapping time windows with different realized regimes (e.g., one trending, one choppy) before eligibility — a config that only wins in one regime is exactly the overfit case this is designed to catch.
- **Minimum sample size with significance testing**, not just "ran for N days." If the shadow trade count is too low to distinguish the result from noise, the gate holds, regardless of how favorable the metric looks.
- **Magnitude cap per promotion.** No single promotion may move any parameter by more than a fixed bound (e.g., ±10%) from the current champion, regardless of what the evolution loop proposes. Large changes require multiple successive promotions, each separately gated — this bounds the damage of any single bad promotion even if every other check is fooled once.
- **Rate limit.** At most one promotion per fixed window (e.g., weekly), so the system cannot thrash between configs faster than a human can review what changed.
- **Human approval on the rationale, not just the metric.** The same confirmation-token machinery as trade approval — the human is shown the diff and the agent's stated rationale, not just a "metrics improved, approve?" button.

### Fix 5 — Structural immutability of risk/breaker thresholds, not a written rule

**Problem:** v1 says risk thresholds shouldn't be learnable. "Shouldn't" isn't a mechanism — it's exactly the same gap that let `basicRiskReview` exist as an unenforced bypass in the current code.

**Fix:** Risk and breaker thresholds (`maxDailyLoss`, `maxDrawdown`, `maxOpenPositions`, the `LIVE_TRADING_ENABLED`/`TRADING_MODE` double-gate) live in a **separate config surface that no loop has a write path to at runtime, full stop** — not a database table any loop's code could theoretically `UPDATE`, but a file loaded once at process start from outside the loop runtime (the existing `.env`-based mechanism is actually already correct for this — the fix is to *not* let any future config-unification effort move these values into the same table the Strategy Evolution Loop writes to). The `ChallengerConfig`/`ChampionConfig` tables the evolution loop owns are schematically incapable of containing these fields — they're a different TypeScript type with a different, smaller set of keys (`signalConfidenceThreshold`, `sizingMultiplier`, `regimeBandWidth`, symbol lists), and that type has no field for anything risk-related. A change to a risk threshold requires a code change and a redeploy, the same as today — it is permanently outside the loop system's own write surface, by type, not by policy.

### Fix 6 — Explicit, bounded, fail-closed staleness contracts

**Problem:** Independent loop cadences mean every consumer is implicitly reading slightly-stale upstream data. v1 doesn't say how stale is too stale, so a Candidate Builder could silently act on a 40-minute-old Regime Assessment if that loop happened to be backed off or failing.

**Fix:** Every `*Assessment` type (`RegimeAssessment`, `PortfolioAssessment`, `PortfolioBreakerState`) carries `asOf: timestamp` and a declared `maxAgeMs`. Any consumer checks `now - asOf <= maxAgeMs` before using it; on violation, it fails closed exactly like an invalid numeric input does (`block_new_buys`, audit event, not a silent stale read). This turns an implicit tradeoff into an explicit, audited, fail-closed one — staleness becomes a *visible* system state (already partially true for Regime — v1's `marketMode: unclear` — this generalizes that same pattern to every assessment type, including Portfolio).

## Revised inventory — three tiers instead of one flat list

```text
TIER 1 — Observers (read-only, many concurrent instances OK, eventually consistent)
  Signal Ingestion Loop
  Signal Review Loop
  Regime Detection Loop
  Portfolio Observer Loop
  Portfolio Drawdown Breaker Loop      (computes go/no-go flag; doesn't write trades)
  Fill Monitor Loop
  Reconciliation Loop
  Exit Monitor Loop                    (produces exit TradeCandidates into the same inbox as entries)
  Outcome Attribution & Calibration Loop
  Telegram Control Loop                (read-only commands; trade-affecting commands enqueue
                                         into the Trade Execution Actor's inbox like any other candidate)

TIER 2 — Trade Execution Actor (exactly one logical writer, serialized, transactional)
  Candidate intake -> Sizing -> Risk Review -> Exit Plan -> Approval(+re-validate) -> Broker Writer
  This is Fix 1. It is the only thing in the system allowed to write BrokerOrder/Fill state
  or call the broker. Everything upstream proposes into its inbox; nothing downstream of it
  exists except Fill Monitor/Reconciliation reading broker truth back in (Tier 1).

TIER 3 — Evolution (propose-only, structurally walled off from Tier 2's thresholds — Fix 5)
  Strategy Evolution Loop    -> writes ChallengerConfig only (Fix 5's narrow type)
  Shadow Evaluation Loop     -> runs ChallengerConfig through Tier 1+2's logic in a
                                 read-only replica path; ShadowIntent type, not accepted
                                 by the real Trade Execution Actor's inbox
  Promotion Gate             -> Fix 4's statistical gate; only output is a new ChampionConfig
                                 version, never a threshold change
```

Net effect on loop count versus the earlier proposal: collapsing five execution-path loops (Candidate Builder through Broker Writer) into one actor with internal stages actually *reduces* the number of independently-racing writers from the prior design — fewer things that can interleave, not more, even though the total feature surface (Tier 3) grew.

## Data model additions

On top of v1's tables, v2 adds:

- `correlation_id` column on every existing audit-adjacent table (Fix 3)
- `strategy_version`, `prompt_version` columns on `sized_trade_intents`, `risk_decisions` (Fix 3)
- `decision_lineage` view joining the above by `correlation_id` (Fix 3)
- `champion_configs`, `challenger_configs` — narrow schema, no risk/breaker fields possible by type (Fix 5)
- `shadow_decisions`, `performance_attribution`, `promotion_events` (from the prior review's Tier 3 loops)
- `as_of` / `max_age_ms` fields on `regime_assessments`, `portfolio_assessments`, `portfolio_breaker_states` (Fix 6)

## Revised implementation sequence

v1's Phases 1–6 (fail-closed hardening → loop infra → read-only loops → candidate/dry-run → paper broker loops → live gate) stay as-is, with two insertions:

- **Phase 2 (Loop Infrastructure)** also includes: branded `FiniteNumber` type + shared safety property test suite (Fix 2), `correlation_id` plumbing (Fix 3). These are foundational, not features — retrofitting them after Phase 5 is much more expensive.
- **Phase 5 (Controlled Paper Broker Loops)** is implemented as the single Trade Execution Actor (Fix 1) from the start, not as five separate polling loops later merged — building it as five loops first and atomicizing it later is strictly more work and risks shipping the race condition during paper trading.
- **New Phase 7 (Self-Learning Layer)**, unchanged in sequencing intent from the prior review (strictly after Phase 6's live-readiness gate passes), now specified with Fix 4's statistical gate and Fix 5's structural immutability from day one rather than added after the fact.

## Problem → mechanism summary

| Risk identified earlier | v1's answer | v2's mechanism |
|---|---|---|
| TOCTOU between risk approval and broker submit | Implicit (separate loops, hope nothing changes in between) | Fix 1 — single serialized actor, fresh state re-read at submit time, approval re-validates rather than skips |
| NaN-class bugs proliferating across more loops | A written rule ("fail closed") | Fix 2 — branded type makes the bug a compile error; shared property-test suite run against every loop |
| Hard to trace why a trade happened across loops | Audit events exist but unindexed for this | Fix 3 — `correlationId` + `decision_lineage` view, built in Phase 2 |
| Strategy evolution finds a metric-gaming degenerate config | Unspecified | Fix 4 — multi-metric, walk-forward, minimum-sample, magnitude-capped, rate-limited, human-approved-on-rationale |
| Risk/breaker thresholds drift via the learning loop | A written rule ("forbidden to propose") | Fix 5 — different type, no write path exists, requires code change + redeploy |
| Stale upstream data silently consumed by decisions | Partially addressed for Regime only | Fix 6 — every Assessment carries `asOf`/`maxAgeMs`, fails closed on violation, generalized everywhere |

This is the same "agents propose, deterministic core decides" principle v1 opened with — v2 just stops treating that principle as a sentence in a document and turns each instance of it into a type, a lock, a statistical test, or a schema boundary that a bug (human or agent-written) can't quietly cross.
