# Review: LOOP_ARCHITECTURE.md vs. Current Implementation, Evaluated as an AI-Native Self-Learning/Self-Evolving Design

**Date:** 2026-06-30
**Reviewed:** `docs/LOOP_ARCHITECTURE.md` (target design, not yet implemented — no loop runner, checkpoint table, or heartbeat mechanism exists anywhere in `src/` or `server.ts` today)
**Compared against:** current monolithic `server.ts` implementation, and the findings in `docs/PRODUCTION_READINESS_REVIEW.md`
**Framing requested:** evaluate as a foundation for an AI-native system that is *in the loop* — i.e. one that self-learns and self-evolves its trading behavior over time — with the guardrails that requires.

## 1. What this document actually is

This is a target architecture, not a description of shipped code. Today, `server.ts` is a single 1415-line file where one HTTP handler (`/api/sync`) inline-calls Gemini, sizing, risk, Telegram, Sheets, Notion, and the broker, holding one in-memory `db` snapshot across all of it. `LOOP_ARCHITECTURE.md` proposes decomposing that into ~15 independently-scheduled, checkpointed, audited loops feeding a single deterministic execution chokepoint (Broker Writer). The core rule it states up front —

> Agents and loops may propose. Deterministic services decide, validate, approve, submit, reconcile, and audit.

— is the correct organizing principle for any system that wants AI involved in decisions but not in execution authority. That sentence is doing a lot of work and is worth preserving exactly as-is through every later design decision, including the ones this review proposes adding.

## 2. How directly it resolves the production-readiness findings

This document reads as a direct, point-by-point response to `docs/PRODUCTION_READINESS_REVIEW.md`, and it's worth confirming the mapping is real rather than aspirational hand-waving:

| Production review finding | Loop architecture's answer | Assessment |
|---|---|---|
| Risk kill-switch fails open on `NaN`/missing config | §"Numeric Fail-Closed Policy" — shared `parseFiniteNumber`, explicit forbidden/required code patterns | Correct fix, and notably the doc shows the *exact* buggy pattern (`if (dailyLoss < maxDailyLoss)`) and its replacement — this is a real fix, not a platitude |
| Second, weaker `basicRiskReview` bypasses real guardrails | §"Central Risk Review Loop" rule: "There must be no weaker backup risk function" + "UI, Telegram, automation, stop-loss, and emergency paths call this same risk engine" | Directly closes the gap, contingent on actually deleting `basicRiskReview` rather than leaving it dead-but-callable |
| No portfolio-level drawdown breaker | New loop #5, "Portfolio Drawdown Breaker Loop," independent of per-trade risk, with daily/peak/baseline drawdown checks | Correct and necessary; good that it's a separate loop rather than a flag inside the risk engine, since it needs its own cadence and its own audit trail |
| Reconciliation computed but never enforced | §"Reconciliation Loop" rule: "Mismatch may force `block_new_buys` until resolved" | Closes the gap — current code computes `ReconciliationReport` but nothing reads `status: "mismatch"` to gate trading |
| Telegram poller races the HTTP mutex on `db.json` | Move to SQLite as sole operational store (`db.json` becomes seed/demo-only), every loop follows the same load/validate/write/checkpoint/audit contract | Directionally right, but **underspecified** — see §4 below |
| No process-level crash handling / silent death | §"Loop Execution Contract" + heartbeats + "loop failure policy" (stop loop, alert operator on write failure) | Addresses the *loop* version of this; doesn't yet address the HTTP server process itself (see §5) |
| Broker failure/timeout could become local `Filled` incorrectly | §"Non-Negotiable Safety Constraints": "Broker failure, timeout, unknown response, or rejected order must never become local `Filled`" + `UnknownBrokerState` as a first-class state | Good — this is a subtle, easy-to-get-wrong correctness property and it's called out explicitly |
| `POST /api/config` unauthenticated; admin token defaults to `"change-me"`; UI doesn't send admin header | Not addressed | **Gap** — see §5 |
| No CI/git/test coverage of the HTTP layer | Not addressed | **Gap** — see §5 |

The trading-domain half of this document is strong. It's the right shape, it cites the actual bugs it's fixing rather than generic best practices, and the phased rollout (dry-run → paper → live, each gated on the previous phase's acceptance criteria) is a sound, conservative sequencing.

## 3. Does it hold up as a foundation for *self-learning / self-evolving*?

This is the part the document doesn't yet attempt, and it's worth being precise about what's missing, because "agents propose, deterministic core decides" is necessary but not sufficient for safe self-learning. As written, that principle is applied only to the **trade-execution path** (one signal → one candidate → one order). A self-learning system needs the same discipline applied one level up, to **the parameters and prompts that govern that path** — otherwise the system can execute individual trades safely while still drifting into a worse strategy over time with no one watching.

Concretely, four capabilities are absent:

**a. No closed loop from outcomes back to decisions.** Every loop in the inventory flows forward (signal → candidate → order → fill). Nothing in the document reads `Closed`/`Reconciled` trades back out and asks "was the signal that produced this any good?" Without that, there's no self-*learning* — there's only safe self-*execution*. The state machine doesn't even carry the information needed to ask that question later: a `SizedTradeIntent` or `RiskDecision` has no field tying it to the exact parameter set, signal-confidence model, or Gemini prompt version that produced it, so even a future analysis pass couldn't reliably attribute outcomes to causes.

**b. No versioned, evaluable parameter/strategy store.** "Deterministic services decide" currently means a single live `Config`. If that config is going to evolve based on performance, it needs to become a *lineage* — a champion config, one or more proposed challenger configs, and a record of which one any given trade ran under. Nothing in the current persistence model (`audit_events`, `risk_decisions`, etc.) supports this.

**c. No shadow/backtest evaluation before a learned change affects anything.** The existing phase gating (dry-run → paper → live) is the right pattern for *trading the same strategy more seriously over time*. It has no equivalent for *evaluating whether a proposed strategy change is actually better* before it touches even paper capital. Without a shadow stage, "self-evolving" means directly mutating the live config based on a proposal, which is precisely the kind of fail-open risk this document otherwise goes out of its way to eliminate elsewhere.

**d. No explicit immutability boundary between "what the system may learn" and "what only a human may change."** The document forbids a *weaker risk function* but never states that risk/breaker *thresholds themselves* (`maxDailyLoss`, `maxDrawdown`, `maxOpenPositions`, the live-trading double-gate) are off-limits to any learning/evolution process. For a system that's explicitly meant to evolve itself, this needs to be said as plainly as the `NaN` rule is said — otherwise "self-evolving" eventually includes "the breaker thresholds drifted because the optimizer found that loosening them improved backtest Sharpe."

## 4. Recommended additions

These extend the document's own format (purpose / inputs / outputs / cadence / rules) so they can be merged into the Loop Inventory directly, slotted in after the existing 15 loops.

### 16. Outcome Attribution & Calibration Loop

Purpose: tie every closed trade back to the exact decision that produced it, and track whether the system's stated confidence matches reality.

Inputs: `Closed`/`Reconciled` trades, the `ReviewedSignal` confidence, `RegimeAssessment`, and `RiskDecision` active at entry, realized P/L, holding duration, exit reason.

Outputs: `PerformanceAttributionRecord` per trade; rolling calibration metrics (hit-rate by confidence bucket, Brier score, P/L by regime, P/L by signal source, P/L by strategy version); audit event.

Cadence: on every terminal state transition, plus an aggregate rollup every 1–24h.

Rules:
- Read/aggregate only — never writes trade-affecting state.
- Requires tagging `SizedTradeIntent`/`RiskDecision` with a `strategyVersion` and, where relevant, a `promptVersion` at creation time — this is a state-machine change, not just a new loop.
- A sustained drop in calibration (confidence no longer predicting outcome) is itself an audited signal, independent of any human noticing.

### 17. Strategy Evolution Loop

Purpose: propose bounded parameter changes — signal-confidence thresholds, sizing multipliers, regime-band widths, symbol allow/deny lists — based on attribution history. May use an LLM/agent to generate candidates; never proposes code changes, and never touches risk or breaker thresholds.

Inputs: `PerformanceAttributionRecord` history, current `ChampionConfig`.

Outputs: `ChallengerConfig` (versioned, inert until promoted), audit event with machine-written rationale and a diff against the champion.

Rules:
- Hard-forbidden from proposing changes to: `maxDailyLoss`, `maxDrawdown`, `maxOpenPositions`, exit-plan requirements, `LIVE_TRADING_ENABLED`/`TRADING_MODE` gating, admin auth, or anything in the Broker Writer. These remain human-owned constants, structurally outside the learnable parameter space — not just outside it by convention.
- A `ChallengerConfig` never executes against real or paper capital directly.

### 18. Shadow Evaluation Loop

Purpose: run a `ChallengerConfig` through the full dry-run pipeline in parallel with the live champion, on identical incoming signals, with no path to the broker.

Inputs: the same `RawSignal`/`ReviewedSignal`/`RegimeAssessment`/`PortfolioAssessment` stream production already sees, plus the challenger config.

Outputs: shadow `TradeCandidate`/`SizedTradeIntent`/`RiskDecision` (a distinct `ShadowIntent` type, not the live one), `ShadowPerformanceReport` comparing challenger vs. champion decisions on the same inputs.

Rules:
- Blocked from the Broker Writer **at the type level** — `ShadowIntent` should not be a type the Broker Writer's input accepts, so this isn't enforceable-by-convention the way the `basicRiskReview` bypass wasn't.
- Minimum sample size and elapsed time before a challenger is eligible for promotion review.

### 19. Promotion Gate

Purpose: decide whether a `ChallengerConfig` becomes the new champion.

Inputs: `ShadowPerformanceReport`, paper track record if already promoted to paper, explicit human approval.

Outputs: new `ChampionConfig` version, audit event, an auto-rollback condition attached to the promotion.

Rules:
- Promotion always requires explicit human approval through the same confirmation-token machinery as trade approval — never fully automatic, by design, the same way `/close_all` requires a human to "submit through the admin API" rather than self-executing.
- Every promotion carries a rollback rule (e.g. "revert to previous champion if realized drawdown exceeds X over the next N trades") that is enforced by the existing Portfolio Drawdown Breaker Loop, not by the learning loop itself — the breaker should not need to know or care that a config change caused the drawdown.
- A promoted config is still paper-only until the existing Phase 6 live-readiness gate separately passes for it; promotion to champion and promotion to live capital are two different gates.

Persistence additions this implies: `strategy_versions`, `challenger_configs`, `shadow_decisions`, `performance_attribution`, `promotion_events`, and a `prompt_versions` table if Gemini prompt text is going to change over time (it should be versioned the same way config is — a prompt edit changes system behavior just as much as a parameter edit does, and outcome attribution needs to know which prompt produced which signal).

## 5. Gaps the document doesn't claim to cover, but that block "production-ready" regardless of loop design

Worth stating plainly so this isn't read as solved by the architecture change: none of the API-layer findings in `PRODUCTION_READINESS_REVIEW.md` are addressed here, because this document is scoped to the trading-decision pipeline, not the HTTP/admin surface. Specifically still open after this architecture ships:

- `POST /api/config` (or whatever replaces it) still needs authentication and a startup check rejecting `ADMIN_API_TOKEN="change-me"`.
- The frontend still needs to actually send the admin token, or Emergency Close All remains a dead button no matter how good the loop pipeline behind it is.
- SQLite concurrency needs to be stated explicitly, not implied. With 15+ loops now writing concurrently instead of one HTTP handler holding a mutex, the document should say outright: `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=<n>`, and either one writer per table or a serialized write queue — "SQLite is the local operational store" alone doesn't prevent the same class of lost-update race the current `db.json` mutex gap causes, it just moves where it could happen.
- No git repository and no CI exists yet to actually gate this rewrite — given the scope of this refactor (15 new loops, a new state machine, a new persistence model), shipping it without version control is materially riskier than the current monolith, not less.
- Any loop step that calls an LLM (signal review, candidate building, and now the proposed Strategy Evolution Loop) should explicitly require a timeout and schema-validated output with a fail-to-no-action default — the document says "AI output is untrusted input" but doesn't yet say what bounds that distrust operationally (today's Gemini calls have no timeout at all).

## 6. Sequencing recommendation

Add the four new loops as **Phase 7: Self-Learning Layer**, strictly after the existing Phase 6 live-readiness gate, not interleaved with it. The reasoning: everything in Phases 1–6 is about proving the deterministic execution core is trustworthy on a fixed strategy. Self-learning only makes sense to introduce once that core is already proven safe — introducing a system that changes its own parameters before the execution path that enforces those parameters has been validated compounds two unproven things at once. The existing document already has good instincts about this kind of staged trust-building (dry-run → tiny paper trade → reconciliation → live gate); apply the same discipline one layer up.

## 7. Verdict

`LOOP_ARCHITECTURE.md` is a strong, specific answer to the trading-engine and concurrency findings in the production review, and its core discipline — agents propose, a small deterministic core decides and executes — is exactly the right pattern for putting AI in the loop of a financial system without putting it in control of one. It is not yet, on its own, a self-learning or self-evolving design: it has no feedback path from trade outcomes back to strategy, no versioned champion/challenger structure, and no explicit statement that risk/breaker thresholds are permanently outside the system's own learnable surface. Add the outcome-attribution, strategy-evolution, shadow-evaluation, and promotion-gate loops above — sequenced after, not alongside, the existing live-readiness gate — and the same "propose vs. decide" discipline that makes the trade-execution design trustworthy will also make the *learning* trustworthy, rather than just relocating the fail-open risk from the risk engine into the optimizer.
