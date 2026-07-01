# Quantpaca — Production Readiness Review

**Date:** 2026-06-30
**Scope:** Full codebase (`server.ts`, `src/server/*`, `src/components/*`, `src/services/*`, `tests/*`, build/ops config)
**Method:** Six independent reviews run in parallel — API/server layer, trading engine logic, persistence layer, integrations (Telegram/Google/Gemini), frontend, and tests/build/ops — each reading full source files rather than excerpts. Several findings below were independently surfaced by two unrelated reviews, which is noted where it happened and increases confidence those are real.

## Bottom line

**Not production-ready, and not close.** Quantpaca (Alpaca broker integration + Gemini-driven signal analysis + Telegram control plane) has sound instincts in places — but critical gaps exist in exactly the areas that matter for handling real money: authentication, fail-safe risk logic, and data-write concurrency. There is also no version control at all (no `.git` present), so there is no rollback path if a bad change ships.

## Critical — fix before touching real capital

1. **`POST /api/config` has zero authentication.** Every other mutating route requires `x-admin-token` via `requireAdminCommand`; this one doesn't (`server.ts:555-565`). Anyone who can reach the server can flip `autoTrading=true`, zero out `stopLossPercent`, or set `maxPositionSizePercent=100` with no credential. The handler also has no `catch` block, so a thrown/rejected error here is an unhandled promise rejection that **crashes the entire Node process** — a single bad request takes the whole trading bot offline, including its own stop-loss monitoring.

2. **The central risk kill-switch fails open, not safe.**
   - `tradingSafety.ts:263` (`submitTradeThroughPipeline`) blocks orders only on a *blacklist* of bad statuses (`"rejected"`, `"requires_human_approval"`) instead of allowlisting good ones — any unexpected/`undefined`/typo'd status value passes through and gets submitted.
   - `riskEngine.ts` limit checks (e.g. `maxDailyLoss`, `maxOpenPositions`) use direct numeric comparison with no validation that the limit is actually a number. `Math.abs(undefined)` is `NaN`, and any comparison against `NaN` is `false` in JS — so a missing/misconfigured limit **silently disables that specific guardrail** rather than rejecting the trade.
   - A malformed `qty`/`price` submitted to `POST /api/override/trade` (`Number("garbage")` → `NaN`) sails through every numeric risk guard the same way, since `NaN <= 0` and `NaN < limit` both evaluate to `false`.
   - A second, materially weaker risk-check function (`basicRiskReview` in `tradingSafety.ts:187-211`) exists alongside the real `riskEngine.reviewRisk`, with no daily-loss, drawdown, or open-position checks — anything that calls it instead bypasses every real guardrail.
   - *(Independently confirmed by both the trading-engine and API-layer reviews.)*

3. **The Telegram poller bypasses the database write-lock.** `dbMutex` protects the four HTTP mutation routes (`/api/config`, `/api/sync`, `/api/override/trade`, `/api/override/close-all`), but `handleTelegramCommand` — polled every 5 seconds — reads and writes `db.json` directly with no lock (`server.ts:373-454`). An operator's `/pause` command issued mid-sync can be silently overwritten when the in-flight sync flushes its stale in-memory snapshot, re-enabling auto-trading despite an explicit pause. *(Independently confirmed by both the persistence and integrations reviews.)*

4. **No process-level crash protection.** Zero `process.on('uncaughtException'|'unhandledRejection'|'SIGTERM')` handlers anywhere in `server.ts`. Any unguarded async error (e.g. in the Telegram polling loop) kills the bot outright and silently — nothing is watching open positions until a human notices it's down.

5. **"Emergency Close All" does not work from the UI.** The frontend never sends the `x-admin-token` header on any admin-gated action (`src/App.tsx:148,171,197`). In any deployment where `ADMIN_API_TOKEN` is actually configured, the one button an operator needs in a crisis returns 401 and silently does nothing — confirmed alongside manual trade override and force-sync having the same gap.

6. **`ADMIN_API_TOKEN` defaults to the literal string `"change-me"`**, shipped in `.env.example`, with no startup check rejecting that value. An operator who copies the example file without editing that one line leaves live-order and liquidation endpoints behind a publicly documented, guessable string.

## High severity

- **No auth on read endpoints.** `/api/trades`, `/api/portfolio`, `/api/audit`, `/api/risk-decisions`, etc. require no token — live balances, positions, and trade history are world-readable by anyone who reaches the URL.
- **No rate limiting anywhere**, including on the route that calls the paid Gemini API twice per sync cycle.
- **No portfolio-level drawdown breaker** — only a daily-loss check that resets every day, so a steady bleed that stays under the daily cap each day compounds indefinitely with nothing to stop it.
- **Reconciliation is computed but never enforced.** `reconcileBrokerState` produces a mismatch report, but nothing in the reviewed code gates new trading on a prior mismatch; position-level (as opposed to order-status) drift is never actually checked despite the type system supporting it (`brokerPositions` parameter is accepted but unused).
- **Two advertised integrations are non-functional as shipped.** Notion logging secrets are unconditionally stripped on every `/api/config` save (`stripPersistedSecrets`), so it can never be configured through the running app. Google Sheets export and Gmail scanning run on a **hardcoded mock OAuth token** (`src/services/googleAuth.ts:11-23`) — there is no real Google auth implementation in the codebase at all.
- **No version control, no CI, no Dockerfile.** No rollback path, no automated gate before a change reaches the running instance.
- **Zero test coverage of `server.ts`** (1415 lines — the entire HTTP/admin-auth surface). The 14 passing tests cover only pure engine logic; `npm test` isn't even wired up (`package.json` has no `test` script).

## Medium / Low

- Money math uses raw floats with `Math.round(x*100)/100` instead of integer-cents — classic compounding rounding-error risk over time.
- `data/db.json` grows unboundedly (`.push`/`.unshift` with no trimming/rotation) and is fully read and rewritten synchronously on every request.
- SQLite store has no `PRAGMA journal_mode=WAL` / `busy_timeout` — concurrent access throws an uncaught `SQLITE_BUSY` rather than retrying.
- No backups or replication for either data store — local disk is a single point of failure for all trade/audit history.
- Two independent, non-transactional persistence stores (`db.json` and `quantpaca.sqlite`) can silently diverge if the process crashes between the two writes.
- Frontend silently swallows errors on config-save and trade-confirmation paths (`console.error` only, no UI feedback) — a user cannot tell whether their action actually succeeded.
- No outbound timeouts on Telegram/Notion/Sheets/Gemini HTTP calls — a hung third party stalls request handling (though trade execution itself is correctly decoupled from these failures, which is good).
- Non-constant-time admin token comparison (`!==` instead of `crypto.timingSafeEqual`) — low-probability timing side channel, compounded by the lack of rate limiting.

## What's actually solid

- `LIVE_TRADING_ENABLED` is read only from `process.env` (can't be flipped via the unauthenticated config route) and is independently re-verified at three separate layers, including immediately before the broker call — genuinely well-hardened.
- Trade execution is correctly decoupled from logging/notification failures: a down Notion/Sheets/Telegram never blocks or rolls back an actual trade.
- Secrets are correctly stripped before every persistence write and never echoed back to the client — verified true in code, not just claimed in `.env.example`.
- Telegram command authorization fails closed (empty role map → every command rejected), and Telegram can only *request* trades via confirmation tokens — it can never execute one directly; execution always requires the separate admin-token HTTP path.
- `tsc --noEmit` passes clean, and `/api/health` performs a real upstream Alpaca connectivity check rather than a bare liveness ping.

## Recommended path

Treat this as a real punch-list, not a quick patch, roughly in this order:

1. Auth-gate `POST /api/config` and add a `catch` block.
2. Flip the risk kill-switch logic to allowlist-and-reject-on-`NaN`/missing-config instead of blacklist-and-pass-through.
3. Put the Telegram DB writer behind the same `dbMutex` as the HTTP routes.
4. Add process-level crash handlers and a startup check that refuses to boot on `ADMIN_API_TOKEN="change-me"`.
5. Fix the frontend to actually send the admin token so Emergency Close All works.
6. Initialize git and stand up at minimum a typecheck + test CI gate before merging further changes.

See `docs/LOOP_ARCHITECTURE_REVIEW.md` for an evaluation of the proposed loop-driven architecture against these findings, and against the additional bar of being a safe foundation for a self-learning/self-evolving system.
