# Quantpaca

An automated, safety-first stock trading system for **paper trading** on [Alpaca](https://alpaca.markets). Quantpaca ingests trading theses from ZipTrader email newsletters and YouTube sentiment, analyzes them with the Claude API, and routes every resulting trade intent through a centralized, fail-closed risk pipeline before anything reaches the broker — with a React dashboard, Telegram command plane, and full audit trail.

> ⚠️ **Paper trading by design.** Live trading is double-gated behind two environment variables that cannot be changed at runtime, and the default configuration only ever talks to Alpaca's paper endpoint. Nothing in this repository is financial advice.

## How it works

```
Gmail (ZipTrader letters) ─┐
                           ├─► Claude analysis ─► Signal engine ─► Sizing engine
YouTube sentiment ─────────┘    (structured        (validation)     (position caps)
(Claude web search)              outputs)                │
                                                         ▼
Telegram commands ◄── Audit log ◄── Trade pipeline ◄── Risk engine ◄── Breaker engine
      │                                   │            (central,        (drawdown,
      ▼                                   ▼             fail-closed)     daily loss)
React dashboard                    Alpaca paper API
```

Each sync cycle:

1. **Ingest** — scan Gmail for ZipTrader theses; pull YouTube channel sentiment via Claude's server-side web search.
2. **Analyze** — Claude (`claude-opus-4-8`) evaluates each thesis with API-enforced structured outputs: ticker, growth score, sentiment score, risk profile, whipsaw-vs-reversal check, and a BUY/SELL/HOLD/NONE decision.
3. **Gate** — signals pass through validation, position sizing, the portfolio drawdown breaker, and the central risk engine. Any invalid input **rejects the trade rather than skipping the check**.
4. **Execute & record** — approved intents go to Alpaca paper trading; every state transition appends an audit event; Telegram receives alerts and accepts admin commands.

## Safety architecture

This codebase treats trading safety as a structural property, not a convention:

- **One risk gate.** A single central risk engine (`src/server/riskEngine.ts`) reviews every trade; weaker duplicate paths were deleted, and only explicitly **allowlisted** risk statuses can reach the broker.
- **Fail-closed numerics.** `NaN`, `Infinity`, `null`, `""`, or unparsable values in any risk comparison reject the trade or trip the breaker — never silently pass (`src/server/numericSafety.ts`, verified by a property test suite).
- **Immutable risk limits.** Daily-loss, trade-count, position, and drawdown limits load once from env at boot and are not writable via API, UI, or Telegram.
- **Double-gated live trading.** Live orders require both `TRADING_MODE=live` and `LIVE_TRADING_ENABLED=true` in the environment; there is no runtime path to enable it.
- **Breakers.** Portfolio drawdown breakers block all new buys when equity falls past configured thresholds; sell-side risk reduction stays available even when metrics are degraded.
- **Hardened ops.** The server refuses to boot on placeholder/weak admin tokens, uses timing-safe token comparison on admin routes, serializes writes behind a DB mutex, and installs crash guards with graceful shutdown.

## Getting started

**Prerequisites:** Node.js 24+ (uses built-in `node:sqlite` and `node:test`).

```bash
git clone https://github.com/highwatermark/quantpaca.git
cd quantpaca
npm install
cp .env.example .env   # then fill in your keys — see below
npm run dev            # serves the API + dashboard on http://localhost:3000
```

### Configuration

All secrets and limits live in `.env` (gitignored — **never commit real keys**). See [`.env.example`](.env.example) for the full annotated list. The essentials:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API calls (thesis analysis + web-search sentiment). Falls back to simulated analysis if unset. |
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | Alpaca credentials (paper keys recommended). |
| `ALPACA_BASE_URL` | Defaults to the paper endpoint `https://paper-api.alpaca.markets`. |
| `ADMIN_API_TOKEN` | Required for sync/trade/close-all/config routes. Generate with `openssl rand -hex 24` — the server refuses to boot on the placeholder value. |
| `TRADING_MODE` / `LIVE_TRADING_ENABLED` | The live-trading double gate. Keep `paper` / `false`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_ROLES` | Optional Telegram command plane with per-user roles and confirmation tokens. |
| `QUANTPACA_MAX_DAILY_LOSS`, `QUANTPACA_MAX_DRAWDOWN_FROM_PEAK_PERCENT`, … | Risk limits, loaded once at boot. |

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the Express server + Vite dev frontend |
| `npm test` | Run the full test suite (`node:test` via tsx) |
| `npm run lint` | Typecheck (`tsc --noEmit`) |
| `npm run build` | Production build (Vite + esbuild server bundle) |
| `npm start` | Run the production bundle |

## Testing & CI

The suite covers the safety-critical paths: risk-engine fail-closed behavior, breaker logic, risk-limit env parsing, trade-pipeline allowlisting, admin-route auth, Telegram mutex serialization, sqlite persistence, and a property suite asserting that invalid numerics always reject or trip the breaker.

CI (GitHub Actions) runs `npm ci && npm run lint && npm test` on every push to `main` and every pull request.

## Architecture docs

Deeper design docs live in [`docs/`](docs/):

- [`LOOP_ARCHITECTURE.md`](docs/LOOP_ARCHITECTURE.md) — target loop/tier architecture and the numeric fail-closed policy
- [`PRODUCTION_READINESS_REVIEW.md`](docs/PRODUCTION_READINESS_REVIEW.md) — the review that drove the Track 0/1 hardening work
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — executed implementation plans

## Disclaimer

Quantpaca is an educational/experimental system operated in paper mode. It is not financial advice, and no guarantee is made about the correctness of any signal, analysis, or trade decision. Do not point it at a live brokerage account without understanding every gate described above — and probably not even then.
