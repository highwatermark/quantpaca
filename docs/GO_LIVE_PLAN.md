# Quantpaca Go-Live Plan: Paper → Real Money

> **Goal:** Take Quantpaca from a manually-triggered paper-trading prototype to a system
> that can be trusted with real money — by fixing the wiring defects, building the
> operational spine, expanding signal sources, and proving positive expectancy over a
> mandatory paper-validation window before the live gate is ever flipped.
>
> **How to use this document:** Work phases strictly in order. Every task has acceptance
> criteria — a task is not done until its criteria are verified (test passing, behavior
> observed, or data recorded). Check boxes as you go. Phases 1–2 are code. Phase 3 is
> time + measurement and cannot be compressed. Phase 4 is a human decision.

---

## Current status (audited 2026-07-12)

**Done and solid (Track 0/1):** fail-closed numeric risk pipeline with property tests
(`src/server/numericSafety.ts`, `tests/safetyProperties.test.ts`); one central risk engine
with allowlisted statuses (`src/server/riskEngine.ts`); triple-enforced live double gate;
immutable env-loaded risk limits; drawdown breakers; hardened admin auth; crash guards;
CI gate.

**Verdict:** Not ready for real money. The risk *evaluation* layer is production-grade;
everything around it is not:

| Dimension | Status |
|---|---|
| Alpha validation | **None.** No backtest, win rate, P&L attribution. Dashboard "alpha curve" is a hardcoded SVG (`src/App.tsx:369-384`) |
| Signal dedup | Engine exists + tested but bypassed live — empty `seenKeys` each call (`server.ts:1144`); same thesis can re-buy every sync |
| Signal freshness | Timestamps overwritten with "now" (`server.ts:1132`) — staleness check structurally blind |
| Exits | Only a 5% polling stop-loss fires. Take-profit / time / thesis-invalidation exits computed but `evaluateExitPlan` has **zero callers** |
| Regime detection | Engine complete but called as `detectRegime({})` (`server.ts:656`) — permanently "unclear / 0.5×". No market data feed |
| Execution | Market orders only, no `client_order_id`, no status polling, no partial-fill handling, no broker-native stops |
| Breakers | Auto-reset with no latch — buys re-enable on equity bounce mid-drawdown |
| Portfolio | Exposure cap hardcoded 100% (`server.ts:1223`); no sector/correlation limits; manual paths skip sizing |
| Reconciliation | Manual-only, order-status-only (`brokerPositions` param ignored), never gates trading |
| Scheduler | **None.** `runIntervalMins` wired to nothing; trading only on manual Force Sync |
| Ops | No supervisor, no backups, no metrics/heartbeats, no HTTP timeouts, mock Google OAuth token |
| Track record | ~Zero. One manual SGOV emergency-close test (2026-07-01). Repo is days old |

---

## Non-negotiable rules (apply to every phase)

1. **Live trading stays double-gated off** (`TRADING_MODE=paper`, `LIVE_TRADING_ENABLED=false`) until Phase 4 sign-off by the human operator. No task in Phases 1–3 touches these.
2. **Fail closed.** Any new numeric input path goes through `parseFiniteNumber`; any new gate rejects on invalid input rather than skipping the check.
3. **Every behavior change ships with a test** that exercises the *wiring* (the integrated path through `server.ts`), not just the pure engine.
4. **No silent fallbacks that can trade.** Simulated/demo/canned data must never reach the trade pipeline.
5. Run `npm run lint && npm test` before considering any task complete.

---

## Execution guardrails — bounded autonomy

These rules bound any agent (or human) executing this plan. The plan must terminate, not
run open-endedly.

**Stop points (mandatory):**
1. **One phase per run.** Complete the current phase's tasks, verify its exit criteria,
   check the boxes, write a short completion report at the bottom of this file — then
   **stop and wait for human sign-off** before starting the next phase. Never begin
   Phase N+1 in the same session that finished Phase N.
2. **Bounded retries.** A task whose acceptance criterion fails after **3 distinct
   attempts** is marked `⛔ BLOCKED` with a one-paragraph note (what was tried, what
   failed) and skipped. Do not loop on it.
3. **Stop the line** — end the run immediately and report — if any of these occur:
   - 2 or more tasks in the current phase are BLOCKED
   - the full test suite cannot be brought back to green within 3 attempts after a change
   - a fix appears to require touching the live-trading gate, risk-limit defaults, or
     breaker thresholds (these require human approval first)
   - work is drifting into the "Out of scope" list or into a later phase's tasks

**Change-scope bounds:**
4. **This file is the contract.** The executor may check boxes, mark BLOCKED, and append
   completion reports — but may not rewrite tasks, weaken acceptance criteria, or edit
   these guardrails. Plan changes are proposed in the report, decided by the human.
5. **No new dependencies, deleted tests, or schema migrations** without listing them
   explicitly in the phase completion report. Never loosen a permission, auth check, or
   validation to make a test pass.
6. **Paper only, and quiet.** During Phases 1–2, no order may be placed except from an
   explicit acceptance test, and total broker orders per session are capped at 10.

**Runtime bounds for the trading system itself** (in addition to the existing daily-loss,
daily-trade-count, breaker, and cooldown limits):
7. **Auto-pause on repeated failure** (built in Phase 2.1): if **3 consecutive scheduled
   sync cycles** fail (ingestion, analysis, or broker errors), the scheduler sets
   `autoTrading=false`, alerts Telegram, and stays paused until a human resumes. The loop
   never retries indefinitely against a failing dependency.
8. **Per-cycle caps:** at most **2 new BUY orders per sync cycle** and the existing
   `QUANTPACA_MAX_DAILY_TRADES` (10) per day; Claude API calls per cycle bounded by the
   source registry size (no unbounded fan-out over email backlogs — `maxResults` stays ≤ 5
   per source per cycle).
9. **Watchdog, not immortality:** the supervisor (2.5) restarts crashes, but after
   **3 restarts within 1 hour** it stops restarting and alerts — a crash-looping trading
   process must stay down, not thrash. (Positions remain protected by broker-native
   bracket orders from 2.2.)

All thresholds above (retry counts, caps, windows) are defaults — the human operator may
tune them, the executor may not.

---

## Phase 1 — Fix the wiring defects (target: days)

The engines are good; the monolithic `server.ts` bypasses them. Fix the wiring.

### 1.1 Signal integrity
- [x] **Persist dedup state.** Load `seenKeys` for `reviewSignal` from the SQLite store (derive from prior `reviewed_signals` rows) instead of a fresh empty `Set` per call (`server.ts:1144`, `signalEngine.ts:37`).
  *Accept:* syncing twice on the same email produces `duplicate` rejection the second time — proven by an integration test.
- [x] **Use real source timestamps.** Capture the Gmail `internalDate`/`Date` header during ingestion (`server.ts:1006-1012`) and set `sourceTimestamp` from it, not `new Date()` (`server.ts:1132,1138`).
  *Accept:* a thesis older than `maxAgeHours` (72h) is rejected as `stale` in an integration test.
- [x] **Ingest full email bodies**, not just the snippet (`server.ts:1007`). Decode the message payload; cap length before sending to Claude.
  *Accept:* analysis prompt contains body text for a multi-paragraph fixture email.
- [x] **Delete trade-capable fallbacks.** Remove the hardcoded MARA demo thesis (`server.ts:1026-1033`) and the canned bullish YouTube fallback (`server.ts:1057`). On ingestion failure: log, alert via Telegram, produce zero signals.
  *Accept:* with Gmail unavailable, a sync produces no signals and no trades; a test asserts this.
- [x] **Per-symbol cooldown.** After any executed trade or rejected/failed order for a symbol, populate `cooldownSymbols` (already supported at `riskEngine.ts:92`) for a configurable window (default 24h).
  *Accept:* a second BUY for the same symbol within the window returns `requires_human_approval`.
- [x] **Gate on the whipsaw check.** The LLM's `whipsawCheck` must become a structured field (e.g., `whipsawVerdict: "whipsaw" | "reversal" | "unclear"`) that the signal engine gates on for SELL decisions and haircuts confidence for BUYs — not just pasted into reasoning text (`server.ts:1140`).
  *Accept:* unit test shows a "reversal-unverified" SELL is downgraded to HOLD.

### 1.2 Exits actually execute
- [x] **Wire `evaluateExitPlan` into the monitoring loop.** In the portfolio controller (`server.ts:908-979`), load open exit plans and evaluate stop-loss, take-profit, time-exit, and thesis-invalidation against live positions; execute resulting closes through `executeTradeIntent`.
  *Accept:* integration tests for each exit type (position at +take-profit closes; position past `timeExitAt` closes).
- [x] **Trailing stop.** Populate and evaluate `trailingStopPercent` (`tradingSafety.ts:43`) in the exit plan.
  *Accept:* unit test: stop ratchets up with price, triggers on retrace.

### 1.3 Regime engine gets real data
- [x] **Build a market-data fetcher** for SPY & QQQ trend (e.g., 20d vs 50d), broad-market drawdown, and a volatility proxy (VIX or realized SPY vol), using the Alpaca market-data API already configured. Feed the result into `detectRegime(...)` each sync instead of `{}` (`server.ts:656,1208`). Persist each assessment.
  *Accept:* regime assessments in SQLite show non-"unclear" modes with real inputs recorded; staleness > 30 min falls back to conservative default (fail closed).
- [x] **Regime-change exit hook.** When regime transitions to `close_only`, the exit monitor evaluates `regimeChangeAction` on open plans.
  *Accept:* test simulating regime flip closes flagged positions.

### 1.4 Risk-gate corrections
- [x] **Latch the breaker.** Once tripped, `block_new_buys`/`close_only` persists until explicit admin reset (Telegram command + admin API route), regardless of equity recovery (`breakerEngine.ts`, state persisted via `saveBreakerState`).
  *Accept:* test — equity dips past threshold then recovers; buys remain blocked until reset is called.
- [x] **Fix the portfolio exposure cap.** Replace the hardcoded `100` (`server.ts:1223`) with an env limit (`QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT`, default 60), loaded once at boot like the others in `riskLimits.ts`.
  *Accept:* sizing rejects/shrinks when aggregate exposure would exceed the cap; parse test in `riskLimits.test.ts` style.
- [x] **Route every buy path through sizing.** Manual override (`server.ts:1357`) must go through `sizeTradeIntent` (or at minimum enforce the same per-position/exposure caps).
  *Accept:* manual override of an oversized qty is clamped/rejected — test proves it.
- [x] **Idempotent orders.** Send a deterministic `client_order_id` (hash of intent id) on every Alpaca order (`server.ts:378-384`).
  *Accept:* resubmitting the same intent cannot create a second broker order (mock-Alpaca test).

**Phase 1 exit criteria:** all boxes checked, `npm run lint && npm test` green, and a
manual paper sync demonstrates: dedup rejection on re-sync, a real regime mode recorded,
and an exit plan evaluated in the loop (visible in audit events).

---

## Phase 2 — Operational spine + new signal sources (target: 1–2 weeks)

### 2.1 Autonomous loop
- [x] **Scheduler.** Wire `runIntervalMins` (default 15) to an internal interval that runs the sync pipeline when `autoTrading` is on; respect market hours via Alpaca `/clock` (skip order placement when closed). Manual `POST /api/sync` remains for on-demand runs.
  *Accept:* server left running executes ≥2 unattended cycles, visible in sync logs and audit events.
- [x] **Market-hours & tradability guard.** Before any order: check Alpaca clock is open and the asset is `tradable`/not halted.
  *Accept:* order attempt while market closed is rejected with an audited reason.
- [x] **PDT guard.** Enforce day-trade count against the 3-in-5 limit when equity < $25k (`daytrade_count` already read at `server.ts:322`).
  *Accept:* test — 4th would-be day trade is blocked.
- [x] **Auto-pause on repeated failure** (guardrail 7). 3 consecutive failed sync cycles → `autoTrading=false`, Telegram alert, stays paused until human resume. **Per-cycle BUY cap** (guardrail 8): max 2 new BUY orders per cycle.
  *Accept:* tests — third consecutive simulated cycle failure pauses trading; a cycle with 3 BUY-decision signals places only 2 orders.

### 2.2 Order lifecycle
- [ ] **Broker-native protective orders.** Submit entries as Alpaca bracket orders carrying the exit plan's stop-loss and take-profit, so protection survives process death. Keep the software exit monitor as a second layer.
  *Accept:* paper order shows attached legs in the Alpaca order record.
- [ ] **Order-status polling.** Poll non-terminal orders each cycle; update local trade state (filled/partial/canceled/rejected); act on partial fills (track remaining qty; cancel-or-complete policy).
  *Accept:* mock-Alpaca tests for fill, partial fill, rejection, and timeout → `UnknownBrokerState` (never invent a fill).
- [ ] **Startup reconciliation.** On boot, reconcile open orders/positions against Alpaca before enabling trading.
  *Accept:* test — an order accepted pre-crash is recovered into local state on restart.

### 2.3 Reconciliation that gates
- [ ] **Scheduled position-level reconciliation.** Run each cycle; actually use the `brokerPositions` parameter (`reconciliationEngine.ts:24`) to detect share-count drift (manual trades, offline fills).
  *Accept:* injected drift in a test produces a mismatch report.
- [ ] **Mismatch halts buys.** Any unresolved mismatch sets `block_new_buys` (latched) and alerts Telegram.
  *Accept:* test — drift blocks the next BUY until reconciled/reset.

### 2.4 New email signal sources
Extend Gmail ingestion (`server.ts:984-1033`) from the single hardcoded ZipTrader query to
a **per-source registry** — each source declares its Gmail query, parser hints, trust tier,
and how its decisions map to actions. Store `source` on every signal (schema already
supports it) so Phase 3 attribution can compare sources.

- [ ] **Source registry structure.** Config-driven list (env/JSON, not code) of `{ id, gmailQuery, senderAllowlist, trustTier, maxAgeHours, enabled }`. Sender allowlist is exact-match on From; anything else in the thread is ignored.
- [ ] **Priority 1 — Motley Fool premium** (`from:fool@motley.fool.com`). Paid membership; explicit dated BUY recommendations (Epic Portfolio, Hidden Gems, Rule Breakers) **and explicit SELLs** ("5 Sells…", Penalty Box updates) — currently the system's only external source of exit signals. Parse recommendation emails only; **blocklist `fool@premiuminfo.fool.com`** (marketing teasers that must not reach Claude as theses).
  *Accept:* fixture Fool recommendation email yields a structured signal with `source: "motley-fool"`; fixture `premiuminfo` email yields nothing.
- [ ] **Priority 2 — Michael Burry Substack** (`from:michaeljburry@substack.com`). "Trading Post" issues contain explicit buys/position adds; "Short Thoughts" contain bearish theses. **Mapping rule (long-only system):** bullish → BUY candidate; bearish/short thesis on a *held* symbol → thesis-invalidation exit; bearish on an *unheld* symbol → add to a do-not-buy list for N days (default 30). Do not open shorts.
  *Accept:* fixture "Short Thoughts NVDA" email while holding NVDA triggers exit evaluation; while not holding, NVDA lands on the avoid list and a subsequent BUY signal for it is rejected.
- [ ] **Cross-source confirmation bonus.** When ≥2 enabled sources are bullish on the same symbol within 72h, boost `confidenceScore` (bounded); conflicting directions → `requires_human_approval`.
  *Accept:* unit tests for agreement boost and conflict flag.
- [ ] **Trade-confirmation blocklist.** Explicitly exclude brokerage notification senders (`noreply@robinhood.com`, `Titan@investordelivery.com`) so broadened queries can never parse account emails as theses.
  *Accept:* fixture confirmation email produces zero signals.

*Deferred (do not build now):* Yellowbrick Road (candidate firehose — needs heavier filtering), Lead-Lag Report (regime input, not trade source — revisit after 1.3), ARK commentary.

### 2.5 Ops hardening
- [ ] **Supervisor.** Dockerfile + restart policy (or systemd unit). Crash → auto-restart → startup reconciliation (2.2) → resume. **Crash-loop limit** (guardrail 9): after 3 restarts within 1 hour, stay down and alert instead of thrashing.
  *Accept:* `kill -9` the process; it restarts and resumes the loop without manual action. Three rapid kills → stays down + alert.
- [ ] **Heartbeat.** Telegram (or equivalent) heartbeat every N cycles + alert if a scheduled cycle is missed by >2× interval.
- [ ] **SQLite backups.** Periodic `VACUUM INTO`/copy to a backups dir with retention; document restore.
  *Accept:* backup file exists after a cycle; restore drill documented in `docs/`.
- [ ] **Outbound HTTP timeouts** on all fetches (Alpaca, Telegram, Anthropic) with bounded retry; **rate limiting + auth on read endpoints**; retire or fix the mock Google OAuth (`src/services/googleAuth.ts:19`) — remove the integration if unused.
- [ ] **Store consolidation.** Migrate remaining `db.json` operational state (config, sync logs) into SQLite; `db.json` becomes legacy/read-only.

**Phase 2 exit criteria:** system runs unattended for 5 consecutive market days in paper
mode — scheduler firing, orders bracketed, statuses polled, reconciliation green, heartbeats
arriving, at least one auto-restart drill passed. All new sources producing attributed signals.

---

## Phase 3 — Prove the alpha (60–90 days paper, cannot be compressed)

The gate from `docs/LOOP_ARCHITECTURE.md`: **90 days of operation or 200 closed trades,
whichever comes first — currently at zero.** This phase is measurement, not features.

### 3.1 Build the measurement layer (week 1 of the window)
- [ ] **Equity curve.** Persist an equity snapshot per cycle; expose as a real chart replacing the decorative SVG (`src/App.tsx:357-384`).
- [ ] **Per-trade P&L attribution.** Join every entry to its exit (`correlationId` threading per the loop docs): realized P&L, holding period, exit reason (stop/TP/time/thesis/signal/manual), signal source, confidence bucket, regime at entry.
- [ ] **Signal scoreboard.** Win rate, avg win/loss, expectancy, and max drawdown **per source** (ZipTrader vs Motley Fool vs Burry vs YouTube-sentiment) and per regime.
- [ ] **Decay metric.** Newsletter publish time → order time latency, recorded per trade (unblocked by 1.1's real timestamps).

### 3.2 Run and review
- [ ] Weekly review ritual (human): scoreboard, drawdown, breaker events, reconciliation mismatches, any manual interventions. Log each review in `docs/paper-log/`.
- [ ] **Disable losing sources**: any source with negative expectancy after ≥30 trades gets disabled in the registry (config change, recorded).
- [ ] **Mid-window audit** (~day 45): re-run a code review of order lifecycle + risk paths; fix anything found before the window continues.

**Phase 3 exit criteria (ALL required):**
- [ ] ≥ 60 days unattended operation **and** ≥ 100 closed trades (stretch: 90d/200)
- [ ] Positive total expectancy after assumed slippage (apply a per-trade haircut, e.g. 10bps, to paper fills)
- [ ] Max drawdown within breaker limits; **zero** unexplained reconciliation mismatches; **zero** orders in `UnknownBrokerState` unresolved > 1 cycle
- [ ] At least one real drawdown-breaker trip + latched-reset exercised (forced drill acceptable)
- [ ] Emergency Close All drill executed successfully from both UI and Telegram

---

## Phase 4 — Live enablement (human decision)

Only after Phase 3 criteria are met, and only by the human operator:

- [ ] Written go/no-go review against Phase 3 data, committed to `docs/`
- [ ] Live config: small capital; `QUANTPACA_MAX_DAILY_LOSS` and per-trade notional set to survivable numbers; `maxOpenPositions` 2–3; exposure cap ≤ 30%
- [ ] Flip `TRADING_MODE=live` + `LIVE_TRADING_ENABLED=true` (env only, requires restart — by design)
- [ ] **Shadow paper instance keeps running in parallel**; weekly live-vs-paper divergence review (fills, slippage, P&L)
- [ ] Scale capital only after 30 live days tracking paper within tolerance; any breaker trip → halve size and review

---

## Out of scope until after live stabilization

Portfolio optimization (target weights, rebalancing, correlation/sector limits beyond the
exposure cap), Track 3 self-learning loops, options/short strategies, additional signal
sources beyond the registry above. These are explicitly deferred — do not build them
during Phases 1–3.

---

## Phase 1 completion report (2026-07-12, branch `phase1-wiring-fixes`, HEAD `e86c93b`)

**Status: all 14 Phase 1 checkboxes complete.** 20 commits, 49 → 185 tests, `npm run lint
&& npm test` green (verified independently at HEAD). Every task went through a fresh
implementer, an adversarial spec+quality review, and fix/re-review loops; a final
whole-branch review (verdict: "Ready to merge") caught and fixed two cross-task defects
no per-task review could see.

**Exit-criteria verification (mix of live sync + integration tests):**
- *Real regime mode recorded* — ✅ LIVE: manual paper sync persisted `risk_on / allow /
  0.8×` with real inputs (SPY trend +0.87%, QQQ +2.48%, drawdown −1.69%, realized vol
  18.1%, BTC −12.8%).
- *Exit plan evaluated in the loop* — ✅ LIVE: the risk evaluator ran plan evaluation in
  the sync cycle (no open positions, so no exits fired); each exit type (take-profit,
  time, plan-stop, trailing, regime-change, legacy fallback) proven by integration tests
  through the real `/api/sync` path.
- *Dedup rejection on re-sync* — ✅ by integration tests (incl. same-email +
  different-LLM-wording case); ⚠️ NOT demonstrable live: no real Gmail OAuth token
  exists (`googleAuth.ts` is still a mock). Re-demonstrate live once Gmail OAuth is real.
- Also live-demonstrated: honest zero-signal degradation with Gmail absent (zero
  fabricated targets, logged), Claude analysis HOLD → no trade. Zero broker orders
  placed during all demonstration syncs; `autoTrading` restored to `false`.

**Live-sync discoveries (found only because the plan mandated a real sync):**
1. Daily-bars fetch omitted `start` → Alpaca returns `bars: null` on weekends/holidays →
   regime permanently degraded. Fixed (`e86c93b`) + regression tests.
2. Final-review finding M1 confirmed live: a failed fetch caches the conservative default
   with `asOf = now`, suppressing retry for 30 min, while a successful fetch stamps
   `asOf` from the newest daily bar (usually > 30 min) so the cache rarely engages on
   success. Both directions fail safe. **Fix folded into Phase 2.1's first task.**

**Schema migrations shipped (guardrail 5 disclosure):** `reviewed_signals.duplicate_key`
(+ dedup persistence), `exit_plans.high_water_mark`, `trade_intents.client_order_id`
(+ index), new `symbol_cooldowns` table. All PRAGMA-guarded, safe on fresh and existing
DBs. New env vars: `QUANTPACA_SYMBOL_COOLDOWN_HOURS` (default 24, 0 disables),
`QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT` (default 60). No new dependencies.

**Decisions requiring explicit human sign-off (do not start Phase 2 without reading):**
1. *(Carried from Track 0/1, made while you were AFK)* `dailyLoss` metric is required for
   BUYs but optional for SELLs in the risk engine — degraded broker data can't block a
   de-risking sell. Confirm or reverse.
2. *client_order_id derivation* is a content hash (`symbol|side|qty|source|day`) because
   no stable intent id exists — two legitimately different same-day trades with identical
   params would silently dedupe. Mostly masked by the 24h cooldown; replace with a stable
   signal id in Phase 2. Sign off before live.
3. *Sell trades also record a cooldown* — after a take-profit exit, a legitimate same-day
   re-entry BUY on that symbol is blocked for 24h (judged desirable anti-whipsaw; your
   call).
4. *Manual-override buys* are clamped by hard caps and blocked by a latched breaker, but
   NOT by regime `close_only` (deliberate: caps yes, signal-quality gating of human
   orders no). Confirm the asymmetry or ask for the gate in Phase 2.
5. *Alpaca duplicate-order error wording* is inferred from docs, not yet observed against
   a real paper duplicate; verify during Phase 2.2 order-lifecycle work.

**Deferred to Phase 2 (agreed by final review):** M1 asOf semantics (→ 2.1 scheduler
task); daily-trade-cap currently also blocks protective sells once hit (→ 2.2 brackets);
Telegram alert fires on every empty sync — must fix before the 15-min scheduler or it's
~96 alerts/day (→ 2.1); HWM re-seed on successful same-day resubmission (→ 2.2);
thesis-invalidation exit reason has no live signal source until Phase 2.4's Burry
mapping (regime-change source is live as of Task 9).

**Branch decision needed:** `phase1-wiring-fixes` is ready to merge to `main` per the
final review. Options: (a) merge locally, (b) open a PR for your own review first,
(c) hold. The executor stopped here per guardrail 1 — Phase 2 begins only after your
sign-off.
