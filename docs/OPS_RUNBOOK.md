# Quantpaca Ops Runbook

Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5): supervisor + heartbeat
operations. This is the operator-facing half; the code-facing reasoning lives
in `src/server/crashLoopGuard.ts`, `src/server/heartbeat.ts`, and the wiring
in `server.ts`.

Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): SQLite backups, outbound
HTTP timeouts, read-endpoint auth + rate limiting. Code-facing reasoning
lives in `src/server/backupEngine.ts`, `src/server/httpDefaults.ts`,
`src/server/rateLimiter.ts`, and the wiring in `server.ts`.

Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
`db.json` operational state (config, sync logs, the legacy UI trades/analyses
lists, the offline simulated portfolio) has moved into SQLite. `db.json` is
now **frozen legacy state** — read exactly once, at boot, by a one-time
migration, and never written again. Code-facing reasoning lives in
`src/server/appStore.ts` (the Store facade + migration) and
`src/server/persistence.ts` (the new `config`/`sync_logs`/`analyses`/
`ui_trades`/`simulated_portfolio` tables).

## Deploy / start

```bash
# One-time: put real secrets in .env (gitignored; see .env.example).
cp .env.example .env   # then edit

docker compose build
docker compose up -d
docker compose logs -f quantpaca
curl -s http://localhost:3000/api/health | jq .
```

State (SQLite, `signal-sources.json`) lives in `./data` on the host,
volume-mounted to `/app/data` — it survives container replacement. Never
delete `./data` casually: it holds trade intents, exit plans, audit history,
config, sync logs, and the crash-loop/heartbeat state. `db.json` also still
lives in `./data` as frozen legacy state (see the Task 14 note above and the
"Store consolidation" section below) — it is not deleted, but nothing reads
or writes it after the very first boot's migration.

### Store consolidation (Task 14) — what changed, what to expect

- **First boot after upgrading to this version:** if `data/db.json` exists
  and SQLite's `config` table is still empty, the process migrates
  config/sync-logs (newest 5,000)/analyses/legacy-trades/simulated-portfolio
  into SQLite on boot, before startup reconciliation runs. This is logged
  (`[migration] db.json migrated into SQLite: ...`) and audited (`GET
  /api/audit`, `actor: dbjson_migration`). A sibling marker file,
  `data/db.json.MIGRATED`, is written next to `db.json` documenting this
  (informational only — nothing reads it back; the real idempotency gate is
  an internal SQLite `app_state` marker).
- **A fresh install** (no `data/db.json` at all) initializes SQLite with
  clean first-boot defaults instead — same marker, same one-time gate.
- **Every boot after the first** is a no-op: the migration is gated on the
  marker and never re-runs, even if `db.json` is later edited by hand (it
  won't be — see below).
- **`db.json` is never deleted.** It is left on disk, untouched, as a
  conservative rollback safety net (see the restore-drill note below) — it
  simply stops being read or written by anything in this codebase after that
  first boot.
- **Backups:** the `db.json` sibling copy in each backup set
  (`data/backups/db-<stamp>.json`) is now conditional on the migration marker
  — it rides along only for a PRE-migration boot (marker absent); once
  migrated, `db.json` is frozen and never changes again, so copying it into
  every future backup would be pointless. Post-migration, the SQLite snapshot
  alone is the complete, current system of record.

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

## Backups

- **Cadence:** once at boot (right after startup reconciliation completes),
  then every 48th completed scheduled cycle (~half a day at the default
  15-minute interval). Both triggers call the same `runBackup` logic
  (`src/server/backupEngine.ts`).
- **What's captured:** `data/backups/quantpaca-<ISO-stamp>.sqlite` via
  SQLite's own `VACUUM INTO` (safe against a live, open WAL-mode connection —
  not a raw file copy, which could race a concurrent writer). Every operational
  state class (config, sync logs, audit, trades, signals, exit plans, etc.) now
  lives in SQLite (Task 14, "Store consolidation") — this one file is the
  complete, current system of record post-migration.
  `data/backups/db-<ISO-stamp>.json` rides alongside **only pre-migration**
  (the `dbjson_migrated_at` app_state marker is absent) as a best-effort file
  copy of `db.json`, which is still live interim state at that point. Once the
  one-time migration has run, `db.json` is frozen legacy state that never
  changes again, so it's no longer copied into new backups — see the "Store
  consolidation" section above. Either way, a `db.json` copy failure never
  fails the SQLite backup itself — only the SQLite snapshot is load-bearing.
- **Retention:** the newest 14 backup sets are kept; older ones are deleted
  (bounded, logged). A set is both files sharing one timestamp — pruning
  always removes the pair together.
- **Failure handling:** a failed backup attempt is logged and recorded as an
  audit event (`GET /api/audit`, `actor: backup_engine`) — it **never**
  crashes or blocks a scheduled cycle. If backups have been failing
  continuously for more than 24h, Telegram gets one alert for that failure
  streak (not repeated every cycle); a subsequent success clears the streak,
  so a later failure alerts fresh.
- **Verify backups are happening:**
  ```bash
  ls -la ./data/backups/
  sqlite3 ./data/backups/quantpaca-<latest-stamp>.sqlite "SELECT COUNT(*) FROM audit_events;"
  ```

### Restore drill

Expected: after restoring a backup, the process boots cleanly, startup
reconciliation runs, and `/api/health` reports OK.

**Rollback note (Task 14, "Store consolidation"):** a backup set taken
*before* the store-consolidation migration ran contains a real, live
`db-<stamp>.json` alongside its `.sqlite` file — restoring that pair restores
the pre-migration split-store state exactly as it was (the restored process
will itself re-run the migration on next boot, same as any pre-migration
boot). A backup set taken *after* migration has no `db-<stamp>.json` at
all — post-migration state lives **fully** inside the `.sqlite` snapshot, so
restoring just the SQLite file is complete and sufficient; there is nothing
else to restore. Check which kind of backup you're restoring with
`ls ./data/backups/ | grep <chosen-stamp>` — a `.json` file next to the
`.sqlite` one means it's a pre-migration backup.

```bash
docker compose stop                      # graceful stop (see "Normal operations" below)

# Pick a backup (newest is usually correct):
ls -t ./data/backups/quantpaca-*.sqlite | head -1

cp ./data/quantpaca.sqlite ./data/quantpaca.sqlite.pre-restore.bak   # safety copy of the CURRENT db first
cp ./data/backups/quantpaca-<chosen-stamp>.sqlite ./data/quantpaca.sqlite
# Only if a db-<chosen-stamp>.json file also exists for this stamp (a
# pre-migration backup -- see the rollback note above):
cp ./data/backups/db-<chosen-stamp>.json ./data/db.json

docker compose up -d
docker compose logs --since 2m quantpaca | grep -E "reconciliation|scheduler|backup"
curl -s http://localhost:3000/api/health | jq .            # expect ok: true
curl -s http://localhost:3000/api/health | jq .startupReconciliation
```

Verify the restored state looks right (adjust the token — see "Read-endpoint
auth" below):

```bash
curl -s -H "x-admin-token: $ADMIN_API_TOKEN" http://localhost:3000/api/trades | jq length
curl -s -H "x-admin-token: $ADMIN_API_TOKEN" http://localhost:3000/api/audit | jq length
```

If something looks wrong, you still have `./data/quantpaca.sqlite.pre-restore.bak`
to roll back to.

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

## Read-endpoint auth

Every `GET /api/*` route requires a token EXCEPT `/api/health` (unauthenticated
by design — Docker healthcheck + uptime monitors need it; its payload is kept
sanitized, no equity/position/token fields, only booleans and counts).

- Accepts either header: `x-admin-token: $ADMIN_API_TOKEN` (an operator with
  admin access can read too) or `x-read-token: $QUANTPACA_READ_TOKEN` (a
  lower-privilege credential for dashboards/monitors that should not be able
  to place trades or change config).
- If `QUANTPACA_READ_TOKEN` is unset, reads fall back to requiring
  `ADMIN_API_TOKEN` — the server logs a boot warning recommending you set a
  dedicated read token instead of handing out the admin one.
- Same placeholder/short-value boot validation as `ADMIN_API_TOKEN`
  (`src/server/startupChecks.ts`): the server refuses to boot if
  `QUANTPACA_READ_TOKEN` is set to `"change-me"` or is under 16 characters.
- The bundled dashboard (`src/App.tsx`) reuses the SAME admin token already
  entered in Settings for its own read calls — there is no separate
  read-token field in the UI. If you want to hand a monitoring tool
  lower-privilege access, set `QUANTPACA_READ_TOKEN` and have that tool send
  `x-read-token` directly (curl, a Grafana datasource, etc.) rather than
  through the bundled dashboard.

```bash
curl -s -H "x-read-token: $QUANTPACA_READ_TOKEN" http://localhost:3000/api/trades | jq length
curl -s http://localhost:3000/api/trades                 # -> 401, no token
```

## Rate limiting

A simple in-memory fixed-window limiter caps every IP at 120 requests/minute
across `/api/*` (`/api/health` exempt); beyond that, `429`. This is process-
local, in-memory state — it resets on restart and does **not** coordinate
across multiple replicas. Memory is bounded: entries for IPs not seen for
more than two windows are swept out (amortized, at most one sweep per
window), so a months-long process does not keep a permanent entry per
distinct client IP ever seen. **In a real (multi-instance, internet-facing)
deployment, put a reverse proxy (nginx, Caddy, a cloud load balancer) in
front of this app and rate-limit there too** — this limiter is a
defense-in-depth backstop for a single-instance deployment, not a substitute
for one.

## Outbound HTTP timeouts

Alpaca trading calls, Telegram (send + the `getUpdates` long-poll loop),
Gmail ingestion fetches, and the Notion/Google Sheets export POSTs all go
through `src/server/httpDefaults.ts`'s `fetchWithTimeout` (10s bound). **GET requests get exactly one retry on
failure; POST/PUT/PATCH/DELETE are never retried** — order submission and
Telegram sends must not double-fire. A Telegram poll timeout is caught and
logged; the poll loop itself keeps running (it does not need a restart to
recover once Telegram is reachable again). The Anthropic SDK manages its own
transport and is configured with a 30s client-level `timeout` instead
(`ANTHROPIC_CLIENT_TIMEOUT_MS` in `server.ts`) — long enough for a
web-search-assisted analysis call, short enough that a sync cycle can't hang
indefinitely on it. `marketDataFetcher.ts` and `tradabilityGuard.ts` already
had their own `AbortSignal.timeout(10s)` + fail-closed logic before this task
and were left as-is (no churn) rather than migrated to the new helper.

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

Task 13's backups/timeouts/read-auth/rate-limiting are covered by
`tests/backupEngine.test.ts`, `tests/httpDefaults.test.ts`,
`tests/rateLimiter.test.ts`, `tests/rateLimitIntegration.test.ts`,
`tests/readEndpointAuth.test.ts`, `tests/startupChecks.test.ts`, and
`tests/googleAuth.test.ts`. The restore drill above (an actual
stop/swap/restart against a real Docker container) was not run in the
development environment (same no-Docker-daemon constraint as Task 12); the
underlying backup file (`VACUUM INTO` output) IS verified to be a valid,
queryable SQLite database by the automated tests. An operator should run the
restore drill for real before relying on it in production.
