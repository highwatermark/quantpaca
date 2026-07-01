# Multi-Lens Review: docs/LOOP_ARCHITECTURE.md

**Date:** 2026-06-30
**Reviewed:** `docs/LOOP_ARCHITECTURE.md` (v3 — tiered loop design + Traces/Evals/Telemetry)
**Method:** Three critique lenses, each grounded in a well-documented public engineering philosophy, applied to the same document. These are not actual statements from these individuals — they're a structured way to stress-test the design against three genuinely different value systems: production-LLM-systems discipline (AI Engineer), simplicity/type-safety/agent-harness pragmatism (Boris Cherny, creator of Claude Code, author of *Programming TypeScript*), and solo-shipper velocity/real-world-stakes pragmatism (Peter Steinberger, PSPDFKit founder, prolific public builder with AI coding tools). Each section cites the specific part of the document it's reacting to.

---

## Lens 1: AI Engineer (production LLM systems discipline)

This lens optimizes for: reliable behavior from a fundamentally nondeterministic component, eval-driven development, observable failure modes, and treating model calls as unreliable network dependencies — not for trading-domain correctness or shipping speed, which the other two lenses cover.

### What holds up well

- **`callModel()` as the only sanctioned LLM entry point** (Traces, Evals & Telemetry §2) is exactly right. Centralizing redaction, timeout, and schema validation in one wrapper instead of trusting every call site to remember all three is the correct mechanism, and it mirrors the same "make the bug a type error" instinct already used for `FiniteNumber`.
- **Separating reasoning blobs from structured spans** with different retention policies is a real production pattern (the same split tools like LangSmith/Helicone use) — large unindexed text shouldn't live in the same hot table as the small structured records calibration depends on.
- **Calibration tracking independent of active evolution** (online evals catching provider-side drift even when Tier 3 is idle) is the single most underrated point in the whole document. Most teams only think about eval regressions when *they* change a prompt; almost nobody designs for the model provider silently changing behavior under them. This is the right instinct and it's correctly tied to the same fail-closed alerting as the drawdown breaker.
- **Golden-set + adversarial/prompt-injection eval gate before any prompt version touches live signal review** is the correct ordering, and explicitly testing prompt-injection resistance for untrusted email/video content is not optional for a system that parses arbitrary external text — good that it's named, not assumed.

### What's missing or underspecified

- **No structured-output mechanism is specified.** "Validate the raw response against `schema`" doesn't say *how* — function-calling/tool-use schemas, JSON mode, or regex extraction from free text have meaningfully different reliability profiles, and the choice should be pinned in the design, not left as an implementation detail. This is the difference between a 2% and a 20% schema-failure rate in practice.
- **No retry/circuit-breaker policy for the LLM call itself**, distinct from the trading circuit breakers. "Add a timeout" is stated, but what happens on the third consecutive Gemini timeout — backoff and retry, or open the circuit and degrade to "no signal this cycle"? Without this, a degraded Gemini endpoint either silently stalls the actor's downstream loops or gets hammered with retries that compound cost.
- **No cost ceiling, only cost measurement.** `costEstimateUsd` is tracked per span, but there's no proposed budget/alert/kill-switch on aggregate spend. A bug in Signal Ingestion's polling cadence (or a runaway Strategy Evolution Loop generating many candidate proposals) is a cost incident, not just a correctness one, and the design has no answer for it.
- **No golden-set maintenance process.** A static eval set silently goes stale as the production signal distribution shifts (new tickers, new source types, market regime changes). The design needs an explicit flywheel: periodically sample production disagreements (human override vs. AI decision, or low-confidence-but-correct cases) back into the golden set. As written, the eval set is a one-time artifact, which is a known failure mode in eval-driven systems.
- **Single-provider dependency with no fallback.** The entire signal pipeline depends on one model provider (Gemini). For a system whose stated goal is resilience and self-evolution, there's no secondary model path or graceful multi-provider degradation considered anywhere — a provider outage doesn't just degrade quality, per the design's own "decoupled from execution" principle it should be a no-signal cycle, but that's never stated explicitly for the *Gemini-down* case the way it is for *Notion/Sheets-down*.
- **Replay evals don't address non-determinism.** Comparing a new prompt/model version's output against a historical decision implies a meaningful diff, but nothing pins temperature/sampling for offline eval reproducibility — without that, a "regression" could just be sampling noise.

### Verdict (AI Engineer lens)

The observability and gating *shape* is right — trace/span model, eval-before-shadow-before-promotion sequencing, drift detection independent of active changes. What's missing is the operational detail that turns "we have an eval layer" into "the eval layer actually catches what it's supposed to": structured-output mechanism, retry/circuit-breaker policy for model calls, a cost ceiling, and a golden-set maintenance loop. None of these are large additions, but without them the eval layer is a schema, not yet a safety mechanism.

---

## Lens 2: Boris Cherny (type-level enforcement, agent-harness pragmatism, simplicity bias)

This lens optimizes for: making invalid states unrepresentable through the type system rather than through process/policy, minimal necessary abstraction, and — drawing on direct experience building an agent harness (Claude Code) — a sharp distinction between what an agent should be allowed to propose versus what a deterministic core should own.

### What holds up well

- **The `FiniteNumber` branded type** (Numeric Fail-Closed Policy) is exactly the right move and exactly the right granularity — converting "remember to validate" into "the compiler won't let you skip validation" is the same philosophy that underlies strict TypeScript usage generally: push correctness into the type system so a code reviewer doesn't have to be the safety net.
- **`ChallengerConfig` having no risk/breaker fields by type, not by convention** (Structural Immutability of Risk Thresholds) is the same instinct applied one level up, and it's the single best idea in the document — it directly fixes the exact class of bug (`basicRiskReview` existing as an unenforced bypass) that a written rule already failed to prevent once in this codebase.
- **Collapsing five polling loops into one serialized Trade Execution Actor** (Tier 2) is the correct simplification — recognizing that "decoupled" and "safe" aren't the same thing, and that atomicity matters more than independent schedulability for the one path that touches money, is a mature call against the more "distributed-systems-flavored" instinct that produced the original five-loop version.
- **"Agents propose, deterministic core decides"** as a literal core rule is the same boundary a tool-permission system draws between a model's tool call and the harness's decision to execute it — recognizable, and correctly applied to the trading domain.

### What this lens pushes back on

- **This is a lot of architecture for zero lines of implementation.** Three tiers, 19+ components, ~25 SQLite tables, a 7-phase rollout, a full eval/trace subsystem — for a single developer, no git repository, and a codebase where `npm test` isn't even wired into `package.json` yet. The instinct here would be to question whether the document is solving a real, present problem or designing against problems that don't exist yet. Ship the smallest version that proves the core loop end-to-end; let real operation reveal what Phase 2 actually needs to be.
- **Most of "loops" here don't need to be loops.** The vocabulary — checkpoints, heartbeats, independently-scheduled polling — is distributed-systems vocabulary borrowed for what is currently one Node process with one user and one broker account. A well-typed, well-tested module with a single scheduler calling synchronous functions in sequence gets most of the same safety properties (especially after Tier 2 is collapsed to one actor) without the operational surface of 19 independently-monitored components. The "Phase 2: split into workers if scale demands it" language already in the document is the right instinct — it should probably extend further: don't build the loop abstraction at all until there's an actual concurrency or latency reason to.
- **The urgent fixes shouldn't be gated behind the full redesign.** `FiniteNumber`, deleting `basicRiskReview`, and the drawdown breaker (Phase 1) are fixes to the *existing* `server.ts` — they don't require any of Tiers 1–3, the trace schema, or the eval layer to exist first. As written, Phase 1 is correctly sequenced first in the document, but the framing throughout reads as "this all ships together" rather than "the safety-critical fix ships today, independent of the architecture rewrite." Those should be explicitly decoupled: one is an emergency patch, the other is a multi-month rewrite, and conflating them risks the urgent fix waiting on the rewrite's timeline.
- **Question whether Tier 3 needs to be automated at all, yet.** The Strategy Evolution Loop exists to propose bounded parameter nudges (±10%, weekly-rate-limited) based on calibration data. That's a five-minute task for a human looking at the Outcome Attribution dashboard. Before building an LLM-driven proposal loop, shadow evaluation, and a multi-metric statistical promotion gate for it, the stronger move is: ship the calibration/attribution telemetry, let a human tune those same parameters manually for a few months, and only automate the *proposal* step if manual tuning is observably the bottleneck. As designed, Tier 3 automates a problem that hasn't been shown to need automating.
- **"Shared Deterministic Services" naming implies more than is warranted.** Fourteen items labeled "services" for a single-process app suggests independent deployment lifecycles that don't exist yet. These are mostly plain modules/functions; calling them services invites premature boundary-drawing (separate repos, separate deploys, network calls between them) before there's a reason for any of that.

### Verdict (Boris Cherny lens)

The type-level enforcement mechanisms in this document are genuinely excellent and should ship regardless of anything else — they're the actual fix for the actual bugs found. The surrounding architecture, though, reads as solving for scale and autonomy the project doesn't have yet. Strip the loop/checkpoint/heartbeat ceremony down to what a single well-tested process actually needs, ship Phase 1's type fixes this week against current `server.ts` without waiting for the rewrite, and treat Tier 3 as something to build only after a human has manually done its job long enough to prove it's worth automating.

---

## Lens 3: Peter Steinberger (solo-shipper velocity, real-stakes pragmatism, agentic-coding-forward)

This lens optimizes for: time-to-real-feedback, matching engineering rigor to actual capital/risk at stake, and — as someone who builds in public with heavy use of AI coding agents — a default toward using exactly that kind of agent-assisted execution to compress a roadmap like this from months to days, while still taking hard guardrails seriously when real money or real users are involved.

### What holds up well

- **The hard guardrails for AI-driven decisions are taken seriously, not performatively.** Confirmation tokens, structural immutability of risk thresholds, and "agents propose, deterministic core decides" reflect the right level of paranoia for a system an LLM partially drives and that touches real capital — this isn't naive "let the agent trade" design, and that distinction matters.
- **The reasoning/trace model is something worth wanting for yourself, not just for compliance.** Being able to open one `decision_lineage` view and see exactly what an agent "was thinking" when it made a call is genuinely useful for debugging an agentic system day-to-day, independent of any self-learning ambition — this is a feature a solo developer would actually use constantly, not just a nice-to-have for an audit.
- **Eval-before-shadow-before-promotion (cheap/fast before expensive/slow)** is the right shape for fast iteration too — it means a bad prompt change gets caught in seconds via the golden set, not after a slow live shadow run.

### What this lens pushes back on

- **Time-to-first-real-signal is the actual metric, and this document doesn't optimize for it.** This represents a large amount of design work for a system that — per the production review — hasn't placed a single paper trade through any version of this pipeline yet. The stronger move: get Phases 1–3 running against paper trading *this week*, let it run for a month, and let real operational pain (not hypothetical failure modes) tell you whether Tier 3's statistical promotion gate is actually necessary or whether it's solving a problem you'll never hit at this scale.
- **The rigor should match the capital at risk, and right now it doesn't match the basics.** The production review found the system can't even send its own admin token from the UI — Emergency Close All is a dead button — and there's no git repository at all. Building a statistical promotion gate with walk-forward validation and adversarial prompt-injection eval suites for a self-evolving learning loop, while the emergency stop doesn't work and there's no version control, is solving next year's problem before this year's is closed. Close the boring, urgent gaps first — they're what actually causes losses in practice, not the absence of a sophisticated evolution loop.
- **Use the same kind of agent-driven execution this document is designing for to actually build it.** Given how much of this conversation has involved dispatching agents to do focused review work, the natural next step is the same pattern applied to implementation: have agents build Phase 1 and Phase 2 in parallel against a clear spec (this document already provides one), with a human reviewing diffs, rather than treating this as a sequential multi-month roadmap. The phases can stay phases; the calendar time per phase doesn't need to be measured in months for a project this size.
- **Some of this is buildable, not hand-rolled.** `trace_spans`/`reasoning_blobs`/`eval_runs` as bespoke SQLite tables is a reasonable Phase 1 choice, but if this project is still actively evolving in six months, evaluate whether an existing lightweight tracing library covers 80% of this for less maintenance burden than a hand-rolled schema — don't over-invest in building observability infrastructure that's a commodity.
- **A repeated, sharper version of the same point as the other two lenses:** none of this matters if the project stays in a folder with no version control. That's the cheapest, highest-leverage fix available and it's still not done.

### Verdict (Peter Steinberger lens)

The instincts about guardrails are right, and the trace/reasoning model is something worth building because it's actually useful day-to-day, not just because it's a "best practice." But the document is currently optimized for designing a system that's correct ahead of time rather than getting a small, safe version running and learning from it fast. Ship the unglamorous fixes (git, auth, Phase 1 safety hardening, one paper trade) this week; let real usage — not upfront design — decide whether Tier 3's full statistical apparatus is worth building at all.

---

## Where the three lenses converge

All three independently land on the same two points, which is the strongest signal in this review:

1. **Ship Phase 1 (the `FiniteNumber` type, deleting `basicRiskReview`, the drawdown breaker) immediately, decoupled from the rest of the architecture.** None of the three lenses think this should wait for Tiers 1–3, the trace schema, or the eval layer.
2. **The unglamorous production gaps (no git, no auth on `/api/config`, the dead Emergency Close All button) are higher priority than anything in this document.** A self-evolving learning loop on top of a system whose emergency stop doesn't work is solving the wrong problem first.

## Where they diverge

- **AI Engineer** wants *more* operational rigor inside the eval/trace layer specifically (structured-output mechanism, cost ceilings, golden-set maintenance) — the gap is depth, not scope.
- **Boris Cherny** wants *less* architectural scope overall — fewer loops, less "service" vocabulary, Tier 3 deferred until manual tuning proves it's needed — the gap is over-abstraction relative to actual scale.
- **Peter Steinberger** wants *faster iteration* over the same scope — get something running this week and let real usage decide what Phase 7 needs to look like, using agent-assisted implementation to compress the timeline rather than treating this as a sequential, months-long plan.

None of the three think the document is wrong about *what* good looks like for a financial AI-agent system. The disagreement is about *how much to build before the first real trade*, and on that question, all three would rather you build less, faster, and let the system's actual behavior — not a design doc — tell you what Tier 3 needs to be.
