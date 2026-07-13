# Quantpaca Ops Runbook

Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5): supervisor + heartbeat
operations. This is the operator-facing half; the code-facing reasoning lives
in `src/server/crashLoopGuard.ts`, `src/server/heartbeat.ts`, and the wiring
in `server.ts`.

## Deploy / start

```bash
# One-time: put real secrets in .env (gitignored; see .env.example).
cp .env.example .env   # then edit

docker compose build
docker compose up -d
docker compose logs -f quantpaca
curl -s http://localhost:3000/api/health | jq .
```

State (SQLite, `db.json`, `signal-sources.json`) lives in `./data` on the
host, volume-mounted to `/app/data` — it survives container replacement.
Never delete `./data` casually: it holds trade intents, exit plans, audit
history, and the crash-loop/heartbeat state.

## How supervision works (read once)

- **Restart policy:** `restart: on-failure` (docker-compose.yml). Any crash
  (non-zero exit) → Docker restarts the container → boot runs startup
  reconciliation (Phase 2.2) → scheduler resumes. No manual action needed.
- **Crash-loop limit (guardrail 9):** enforced *in-process*, not by Docker.
  On boot, the process records its boot timestamp in the `restart_history`
  app_state key. If **3 boots land within 1 hour**, the process sends a
  Telegram alert ("crash loop detected; staying down"), logs, and **exits 0
  without starting anything**. Exit 0 is deliberate: `on-failure` restarts
  every non-zero exit, so a clean exit is the only way to stay down. **The
  Telegram alert is your signal** — do not expect a distinctive exit code.
- **Clean shutdowns don't count:** a graceful `SIGTERM`/`SIGINT` (e.g.
  `docker compose stop`, `docker compose restart`) stamps a clean-shutdown
  marker; the following boot is excused from the crash window. Deliberate
  restarts will never trip the breaker. `kill -9` bypasses the marker (no
  signal handler runs), so it counts — as it should.
- **Heartbeat:** every 12 completed scheduled cycles (~3h at the default
  15-minute interval), Telegram gets "Alive: cycle N, last regime X, open
  positions Y". Market-closed (reduced) cycles still count — exit monitoring
  and regime detection run in them.
- **Missed-cycle watchdog:** an independent 5-minute check inside the
  scheduler. If autoTrading is ON and no scheduled cycle has completed in
  more than 2× the configured interval, Telegram gets "Scheduled cycle
  overdue" — once per gap, not repeatedly.

## Drill: single-crash auto-restart (acceptance test)

Expected: process restarts, runs startup reconciliation, resumes the loop —
no manual action.

```bash
docker compose up -d
# Kill the node process hard (bypasses graceful shutdown, simulates a crash):
docker kill --signal=SIGKILL quantpaca
# Docker restarts it (may take a few seconds):
docker compose ps                       # should show Up / restarting -> Up
docker compose logs --since 2m quantpaca | grep -E "reconciliation|scheduler"
curl -s http://localhost:3000/api/health | jq .startupReconciliation
```

## Drill: three rapid kills → stays down + alert (guardrail 9 acceptance)

Expected: after the 3rd boot within the hour, the container exits 0 and does
**not** come back; Telegram receives the crash-loop alert; an audit event
(`actor: crash_loop_guard`) is recorded.

```bash
docker compose up -d
for i in 1 2 3; do
  sleep 10   # let it boot far enough to record the boot timestamp
  docker kill --signal=SIGKILL quantpaca
done
sleep 15
docker compose ps -a                    # quantpaca should be Exited (0)
docker compose logs quantpaca | grep "crash-loop"
# Expect: "[crash-loop] 3 boots within 60 minutes ... Staying down"
# And a Telegram message: "Crash loop detected; staying down."
```

Note the timing subtlety: the boot timestamp is recorded at the START of each
boot, so the kills only need to land after boot, not at any precise moment.
Three boots inside one hour is the trigger, however they happened.

## Recover from a crash-loop stay-down

1. Investigate first: `docker compose logs quantpaca`, the Telegram alert,
   `curl -s localhost:3000/api/audit` history from before the loop, and the
   audit event with `actor: crash_loop_guard`.
2. Fix the cause (bad config edit, broken dependency, full disk, ...).
3. Restart deliberately:

```bash
docker compose up -d
```

That boot counts toward the window too. If two of the three crash-boots are
still inside the last hour, a genuinely-fixed process will boot fine (it's
the 3rd+ *within an hour* that trips) — but if you restart into a still-broken
state it will correctly trip again on the next crash cycle. If you need to
reset the window manually (e.g. repeated *deliberate* hard kills during an
incident, not real crashes):

```bash
sqlite3 ./data/quantpaca.sqlite \
  "DELETE FROM app_state WHERE key = 'restart_history';"
```

Positions remain protected the whole time the process is down: exits are
broker-native bracket orders (stop-loss/take-profit legs) held server-side
at Alpaca, not software checks in this process.

## Normal operations

```bash
docker compose stop        # graceful: SIGTERM -> clean-shutdown marker ->
                           # next boot does NOT count toward the crash window
docker compose restart     # graceful stop + start (also excused)
docker compose down        # stop + remove container (data/ volume persists)
docker compose logs -f     # tail logs
```

`stop_grace_period: 15s` gives the graceful path (stop scheduler, close HTTP,
5s internal grace) room before Docker escalates to SIGKILL.

## Heartbeat / watchdog expectations

| Signal | Cadence | Meaning if missing |
| --- | --- | --- |
| "Alive: cycle N ..." | every 12 completed cycles (~3h at 15-min interval) | scheduler stopped, autoTrading off, or Telegram broken |
| "Scheduled cycle overdue" | once per gap, when a cycle is >2× interval late (autoTrading on) | the loop is stuck/dead — check logs, consider a restart |

Both are informational sends: if Telegram is unconfigured or a send fails,
the event is logged (`[heartbeat]` / `[watchdog]` prefixes) and life goes on.
The watchdog only stamps a gap as "alerted" after a *delivered* alert, so a
Telegram outage during a gap re-alerts once Telegram recovers.

Silence check: heartbeats stop when autoTrading is off — that is expected,
not an incident (the watchdog is also autoTrading-gated).

## Verification status of these artifacts

`docker build` / `docker compose config` were not runnable in the development
environment where this task was implemented (no Docker daemon; hadolint not
installed). The Dockerfile/compose files were syntax-reviewed manually, and
all in-process behavior (crash-loop decision, exit-0 branch, clean-shutdown
marker, heartbeat, watchdog) is covered by the automated test suite
(`tests/crashLoopGuard.test.ts`, `tests/heartbeat.test.ts`,
`tests/scheduler.test.ts`, `tests/processGuards.test.ts`,
`tests/supervisorHeartbeatIntegration.test.ts`). Before first production use,
an operator should run:

```bash
docker compose config -q      # compose file validation
docker compose build          # full image build
```

and then the two drills above.
