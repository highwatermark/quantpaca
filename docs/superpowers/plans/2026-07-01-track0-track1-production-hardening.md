# Quantpaca Track 0 + Track 1 Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Quantpaca monolith safe to operate in paper mode by closing every Track 0 (security/ops) and Track 1 (fail-closed risk) item from `docs/LOOP_ARCHITECTURE.md` and `docs/PRODUCTION_READINESS_REVIEW.md`, without starting the Track 2 loop rewrite.

**Architecture:** All changes apply to the current single-process Express monolith (`server.ts` + `src/server/*` engines). No new services, no loop/tier decomposition — that is the next plan (Track 2). New modules are small pure-function engines following the existing `src/server/*.ts` pattern, tested with `node:test` via `tsx --test`.

**Tech Stack:** Node v24 (built-in `node:sqlite`, `node:test`), TypeScript 5.8 (`tsc --noEmit`), tsx, Express 4, React 19 + Vite 6.

## Global Constraints

- `LIVE_TRADING_ENABLED` + `TRADING_MODE` double-gate must remain env-only and unchanged (`tradingSafety.ts:93-108`); nothing in this plan may make it configurable at runtime.
- No `NaN`, `Infinity`, `undefined`, `null`, `""`, or unparsable string may reach a risk comparison; invalid input rejects the trade or trips the breaker (fail closed), never silently passes.
- One central risk engine (`src/server/riskEngine.ts`); duplicate/weaker risk-check functions are deleted, not deprecated.
- Every trade state transition appends an audit event (existing `submitTradeThroughPipeline` pattern — preserve it).
- Risk/breaker thresholds load once from env at process start; they are never writable via `/api/config`, Telegram, or any runtime path.
- All new env vars must be added to `.env.example` in the same task that introduces them.
- Test runner is `tsx --test tests/*.test.ts`; type gate is `npm run lint` (`tsc --noEmit`). Both must pass at the end of every task.
- Commit after every task. The repo has no git history until Task 1 creates it.

---

### Task 1: Version control, ignore rules, and `npm test`

**Files:**
- Modify: `.gitignore`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Produces: a git repository on branch `main`; `npm test` running the existing 14 tests. Every later task's commit step depends on this.

- [ ] **Step 1: Extend .gitignore so operational data and secrets never enter history**

Append to `.gitignore` (current content covers `node_modules`, `build`, `dist`, `coverage`, `.env*`):

```bash
cat >> .gitignore <<'EOF'
data/
*.sqlite
*.tmp
EOF
```

- [ ] **Step 2: Wire up `npm test`**

In `package.json`, change the scripts block to add the `test` line (keep every existing script):

```json
"scripts": {
  "dev": "tsx server.ts",
  "build": "vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs",
  "start": "node dist/server.cjs",
  "preview": "vite preview",
  "clean": "rm -rf dist server.js",
  "lint": "tsc --noEmit",
  "test": "tsx --test tests/*.test.ts"
},
```

- [ ] **Step 3: Verify the suite runs**

Run: `npm test`
Expected: `ℹ tests 14` / `ℹ pass 14` / `ℹ fail 0` (an `ExperimentalWarning: SQLite` line is normal on Node 24).

- [ ] **Step 4: Initialize the repository and make the first commit**

```bash
git init -b main
git add -A
git status   # verify data/, .env, dist/, node_modules/ are NOT staged
git commit -m "chore: initial commit with test script and ignore rules"
```

---

### Task 2: Startup environment validation (refuse to boot on `change-me`)

**Files:**
- Create: `src/server/startupChecks.ts`
- Test: `tests/startupChecks.test.ts`
- Modify: `server.ts` (top of the `run()` function, `server.ts:1393`)
- Modify: `.env.example`

**Interfaces:**
- Produces: `validateStartupEnv(env: NodeJS.ProcessEnv): StartupIssue[]` where `StartupIssue = { level: "fatal" | "warn"; message: string }`. Task 11 adds risk-limit checks alongside this call site.

- [ ] **Step 1: Write the failing test**

Create `tests/startupChecks.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { validateStartupEnv } from "../src/server/startupChecks";

test("placeholder admin token is fatal", () => {
  const issues = validateStartupEnv({ ADMIN_API_TOKEN: "change-me" } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal" && i.message.includes("change-me")));
});

test("short admin token is fatal", () => {
  const issues = validateStartupEnv({ ADMIN_API_TOKEN: "abc123" } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal")); 
});

test("missing admin token is a warning, not fatal, in paper mode", () => {
  const issues = validateStartupEnv({ TRADING_MODE: "paper" } as NodeJS.ProcessEnv);
  assert.ok(issues.every((i) => i.level === "warn"));
  assert.ok(issues.some((i) => i.message.includes("ADMIN_API_TOKEN")));
});

test("live trading without an admin token is fatal", () => {
  const issues = validateStartupEnv({
    TRADING_MODE: "live",
    LIVE_TRADING_ENABLED: "true",
  } as NodeJS.ProcessEnv);
  assert.ok(issues.some((i) => i.level === "fatal"));
});

test("a strong token in paper mode produces no issues", () => {
  const issues = validateStartupEnv({
    ADMIN_API_TOKEN: "a-real-secret-token-0123456789",
    TRADING_MODE: "paper",
  } as NodeJS.ProcessEnv);
  assert.equal(issues.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/startupChecks.test.ts`
Expected: FAIL — `Cannot find module '../src/server/startupChecks'`.

- [ ] **Step 3: Implement**

Create `src/server/startupChecks.ts`:

```ts
export interface StartupIssue {
  level: "fatal" | "warn";
  message: string;
}

const MIN_TOKEN_LENGTH = 16;

export function validateStartupEnv(env: NodeJS.ProcessEnv): StartupIssue[] {
  const issues: StartupIssue[] = [];
  const token = (env.ADMIN_API_TOKEN || "").trim();
  const liveRequested = env.TRADING_MODE === "live" || env.LIVE_TRADING_ENABLED === "true";

  if (token === "change-me") {
    issues.push({
      level: "fatal",
      message:
        'ADMIN_API_TOKEN is still the placeholder "change-me" from .env.example. Set a real secret before starting.',
    });
  } else if (token.length > 0 && token.length < MIN_TOKEN_LENGTH) {
    issues.push({
      level: "fatal",
      message: `ADMIN_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`,
    });
  } else if (!token) {
    issues.push({
      level: liveRequested ? "fatal" : "warn",
      message: liveRequested
        ? "Live trading requires ADMIN_API_TOKEN to be configured."
        : "ADMIN_API_TOKEN is unset; all admin command routes will return 503 until it is configured.",
    });
  }

  if (env.LIVE_TRADING_ENABLED === "true" && env.TRADING_MODE !== "live") {
    issues.push({
      level: "warn",
      message: 'LIVE_TRADING_ENABLED=true but TRADING_MODE is not "live"; live trading stays blocked.',
    });
  }

  return issues;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/startupChecks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into server startup**

In `server.ts`, add to the imports at the top:

```ts
import { validateStartupEnv } from "./src/server/startupChecks";
```

At the very top of `async function run()` (`server.ts:1393`, before the `distPath` line), add:

```ts
  const startupIssues = validateStartupEnv(process.env);
  for (const issue of startupIssues) {
    const log = issue.level === "fatal" ? console.error : console.warn;
    log(`[startup:${issue.level}] ${issue.message}`);
  }
  if (startupIssues.some((issue) => issue.level === "fatal")) {
    console.error("[startup] Fatal configuration issues found. Refusing to start.");
    process.exit(1);
  }
```

In `.env.example`, change the admin token comment block to:

```text
# Required for POST /api/sync and broker-affecting command routes.
# The server REFUSES TO BOOT while this is set to the placeholder value.
# Generate one with: openssl rand -hex 24
ADMIN_API_TOKEN="change-me"
```

- [ ] **Step 6: Verify boot refusal and normal boot**

Run: `ADMIN_API_TOKEN=change-me npx tsx server.ts; echo "exit=$?"`
Expected: `[startup:fatal] ...change-me...` then `exit=1`.
Run: `npm run lint && npm test`
Expected: clean typecheck, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/startupChecks.ts tests/startupChecks.test.ts server.ts .env.example
git commit -m "feat: refuse to boot on placeholder or unsafe ADMIN_API_TOKEN"
```

---

### Task 3: Process-level crash guards and graceful shutdown

**Files:**
- Create: `src/server/processGuards.ts`
- Test: `tests/processGuards.test.ts`
- Modify: `server.ts` (`app.listen` block at `server.ts:1409-1412`)

**Interfaces:**
- Produces: `createProcessGuardHandlers(deps)` (pure, testable) and `installProcessGuards(deps)` (registers on `process`). `deps = { log(message, error?), exit(code), closeServer?(onClosed) }`.
- Policy: crash → log + `exit(1)`; restart is the supervisor's job (pm2 / systemd / launchd / Docker restart policy). This plan does not add in-process resurrection.

- [ ] **Step 1: Write the failing test**

Create `tests/processGuards.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createProcessGuardHandlers } from "../src/server/processGuards";

function makeDeps() {
  const calls: { logs: string[]; exitCodes: number[]; closed: boolean } = {
    logs: [],
    exitCodes: [],
    closed: false,
  };
  return {
    calls,
    deps: {
      log: (message: string) => calls.logs.push(message),
      exit: (code: number) => calls.exitCodes.push(code),
      closeServer: (onClosed: () => void) => {
        calls.closed = true;
        onClosed();
      },
    },
  };
}

test("uncaught exception logs and exits 1", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onUncaughtException(new Error("boom"));
  assert.deepEqual(calls.exitCodes, [1]);
  assert.ok(calls.logs.some((l) => l.includes("Uncaught exception")));
});

test("unhandled rejection logs and exits 1", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onUnhandledRejection("reason");
  assert.deepEqual(calls.exitCodes, [1]);
});

test("shutdown signal closes the server then exits 0 exactly once", () => {
  const { calls, deps } = makeDeps();
  const handlers = createProcessGuardHandlers(deps);
  handlers.onShutdownSignal("SIGTERM");
  assert.equal(calls.closed, true);
  assert.deepEqual(calls.exitCodes, [0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/processGuards.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/server/processGuards.ts`:

```ts
export interface ProcessGuardDeps {
  log: (message: string, error?: unknown) => void;
  exit: (code: number) => void;
  closeServer?: (onClosed: () => void) => void;
}

const SHUTDOWN_GRACE_MS = 5000;

export function createProcessGuardHandlers(deps: ProcessGuardDeps) {
  return {
    onUncaughtException(error: unknown) {
      deps.log("[fatal] Uncaught exception — shutting down.", error);
      deps.exit(1);
    },
    onUnhandledRejection(reason: unknown) {
      deps.log("[fatal] Unhandled promise rejection — shutting down.", reason);
      deps.exit(1);
    },
    onShutdownSignal(signal: string) {
      deps.log(`[shutdown] Received ${signal}; closing HTTP server.`);
      let exited = false;
      const finish = () => {
        if (exited) return;
        exited = true;
        deps.exit(0);
      };
      if (!deps.closeServer) return finish();
      deps.closeServer(finish);
      const timer = setTimeout(finish, SHUTDOWN_GRACE_MS);
      timer.unref?.();
    },
  };
}

export function installProcessGuards(deps: ProcessGuardDeps) {
  const handlers = createProcessGuardHandlers(deps);
  process.on("uncaughtException", handlers.onUncaughtException);
  process.on("unhandledRejection", handlers.onUnhandledRejection);
  process.on("SIGTERM", () => handlers.onShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => handlers.onShutdownSignal("SIGINT"));
  return handlers;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/processGuards.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into server.ts**

Add to imports:

```ts
import { installProcessGuards } from "./src/server/processGuards";
```

Replace the listen block at `server.ts:1409-1412`:

```ts
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server starting on port ${PORT}`);
    startTelegramRuntime();
  });
```

with:

```ts
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server starting on port ${PORT}`);
    startTelegramRuntime();
  });

  installProcessGuards({
    log: (message, error) => (error === undefined ? console.error(message) : console.error(message, error)),
    exit: (code) => process.exit(code),
    closeServer: (onClosed) => httpServer.close(onClosed),
  });
```

- [ ] **Step 6: Verify manually**

Run: `npx tsx server.ts` (with a valid `.env`), then in another shell `kill -TERM <pid>`.
Expected: `[shutdown] Received SIGTERM; closing HTTP server.` and a clean exit.
Run: `npm run lint && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/server/processGuards.ts tests/processGuards.test.ts server.ts
git commit -m "feat: process crash guards and graceful SIGTERM shutdown"
```

---

### Task 4: Auth-gate `POST /api/config`, timing-safe token compare, and route testability

**Files:**
- Modify: `server.ts` (data-dir constants `server.ts:33-34`, `requireAdminCommand` `server.ts:74-87`, `POST /api/config` `server.ts:555-565`, bottom-of-file `run()` call `server.ts:1415`)
- Test: `tests/apiConfigAuth.test.ts`

**Interfaces:**
- Produces: `export { app, dbMutex, handleTelegramCommand, readDB }` from `server.ts`; `run()` only executes when `NODE_ENV !== "test"`; data directory overridable via `QUANTPACA_DATA_DIR`. Task 5's test consumes these exports.

- [ ] **Step 1: Make the server importable by tests**

In `server.ts`, replace lines 33-34:

```ts
const DB_PATH = path.join(process.cwd(), "data", "db.json");
const productionStore = createProductionStore(path.join(process.cwd(), "data", "quantpaca.sqlite"));
```

with:

```ts
const DATA_DIR = process.env.QUANTPACA_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const productionStore = createProductionStore(path.join(DATA_DIR, "quantpaca.sqlite"));
```

Replace the bare `run();` at `server.ts:1415` with:

```ts
export { app, dbMutex, handleTelegramCommand, readDB };

if (process.env.NODE_ENV !== "test") {
  run();
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/apiConfigAuth.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-test-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";

const { app } = await import("../server");

test("POST /api/config requires the admin token", async (t) => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  t.after(() => listener.close());

  const noToken = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: { autoTrading: true } }),
  });
  assert.equal(noToken.status, 401);

  const badToken = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": "wrong" },
    body: JSON.stringify({ system: { autoTrading: true } }),
  });
  assert.equal(badToken.status, 401);

  const goodToken = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": "test-admin-token-0123456789",
    },
    body: JSON.stringify({ system: { autoTrading: false } }),
  });
  assert.equal(goodToken.status, 200);
  const body = await goodToken.json();
  assert.equal(body.success, true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test tests/apiConfigAuth.test.ts`
Expected: FAIL — the no-token request returns 200 because the route is currently unauthenticated.

- [ ] **Step 4: Harden `requireAdminCommand` and the config route**

Add `import crypto from "crypto";` to the top of `server.ts`. Replace `requireAdminCommand` (`server.ts:74-87`) with:

```ts
function tokensMatch(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdminCommand(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expectedToken = process.env.ADMIN_API_TOKEN;
  if (!expectedToken) {
    res.status(503).json({
      error: "Admin command routes are disabled until ADMIN_API_TOKEN is configured.",
    });
    return;
  }
  const providedToken = req.header("x-admin-token") || "";
  if (!tokensMatch(providedToken, expectedToken)) {
    res.status(401).json({ error: "Unauthorized command request." });
    return;
  }
  next();
}
```

Replace `POST /api/config` (`server.ts:555-565`) with:

```ts
app.post("/api/config", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    db.config = stripPersistedSecrets({ ...db.config, ...req.body });
    writeDB(db);
    res.json({ success: true, config: redactConfigForClient(db.config) });
  } catch (error) {
    console.error("Config update failed:", error);
    res.status(500).json({ error: "Failed to update configuration." });
  } finally {
    release();
  }
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test tests/apiConfigAuth.test.ts`
Expected: PASS.
Run: `npm run lint && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server.ts tests/apiConfigAuth.test.ts
git commit -m "fix: auth-gate POST /api/config with timing-safe compare; make server importable in tests"
```

---

### Task 5: Put the Telegram command handler behind the DB mutex

**Files:**
- Modify: `server.ts` (`handleTelegramCommand`, `server.ts:373-455`)
- Test: `tests/telegramMutex.test.ts`

**Interfaces:**
- Consumes: `app`/`dbMutex`/`handleTelegramCommand`/`readDB` exports and `QUANTPACA_DATA_DIR` from Task 4.
- Produces: `handleTelegramCommand` acquires `dbMutex` for all read-modify-write work; outbound Telegram sends and broker reads happen strictly *after* the lock is released (a hung Telegram/Alpaca call must never stall other writers).

- [ ] **Step 1: Write the failing test**

Create `tests/telegramMutex.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-tg-test-"));
process.env.TELEGRAM_ADMIN_ROLES = "42:admin";
delete process.env.TELEGRAM_BOT_TOKEN; // sendTelegramBotMessage no-ops without it

const { dbMutex, handleTelegramCommand, readDB } = await import("../server");

test("telegram /pause waits for the db mutex instead of racing it", async () => {
  const release = await dbMutex.acquire(); // simulate an in-flight sync holding the lock

  const pause = handleTelegramCommand({
    update_id: 1,
    message: { text: "/pause", chat: { id: 42 }, from: { id: 42 } },
  });

  // Give the handler a chance to (incorrectly) write while the lock is held.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The command must not have been applied yet: no audit event written while the lock is held.
  assert.equal(readDB().auditEvents.length, 0);

  release();
  await pause;

  const db = readDB();
  assert.equal(db.config.system.autoTrading, false);
  assert.ok(db.auditEvents.some((e: any) => e.type === "telegram"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/telegramMutex.test.ts`
Expected: FAIL — with the current code the audit event is written while the lock is held (`auditEvents.length` is already 1 before `release()`).

- [ ] **Step 3: Restructure `handleTelegramCommand`**

Replace the whole function (`server.ts:373-455`) with:

```ts
async function handleTelegramCommand(update: any) {
  const message = update.message;
  const text = String(message?.text || "").trim();
  const chatId = String(message?.chat?.id || "");
  const userId = String(message?.from?.id || "");
  if (!text || !chatId || !userId) return;

  const command = text.split(/\s+/)[0];
  const roles = parseTelegramAdminRoles(process.env.TELEGRAM_ADMIN_ROLES);
  const auth = authorizeTelegramCommand({ userId, command, roles });

  const outbound: string[] = [];
  let needsReadOnlyReply = false;

  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const auditEvent: AuditEvent = {
      id: `tg-${update.update_id || Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "telegram",
      actor: userId,
      message: `Telegram command ${command} ${auth.allowed ? "accepted" : "rejected"}`,
      details: { command, chatId, auth },
    };
    appendAuditEvents(db, [auditEvent]);

    if (!auth.allowed) {
      outbound.push(`Rejected: ${auth.reason || "unauthorized"}.`);
    } else if (command === "/confirm") {
      const tokenValue = text.split(/\s+/)[1];
      const token = pendingTelegramConfirmations.get(tokenValue);
      if (!token) {
        outbound.push("Confirmation rejected: unknown token.");
      } else {
        const consumed = consumeConfirmationToken({ token, userId, action: token.action });
        if (!consumed.accepted) {
          outbound.push(`Confirmation rejected: ${consumed.reason}.`);
        } else {
          pendingTelegramConfirmations.delete(tokenValue);
          outbound.push(`Confirmed action: ${token.action}. Submit through the admin API to execute.`);
        }
      }
    } else if (command === "/close_all") {
      const token = createConfirmationToken({ userId, action: "close_all" });
      pendingTelegramConfirmations.set(token.token, token);
      outbound.push(`Close-all requires confirmation. Reply: /confirm ${token.token}`);
    } else if (command === "/pause" || command === "/block_buys") {
      db.config.system.autoTrading = false;
      outbound.push("Auto trading paused. New buys are blocked.");
    } else if (command === "/resume") {
      db.config.system.autoTrading = true;
      outbound.push("Auto trading resumed subject to risk checks.");
    } else {
      needsReadOnlyReply = true;
    }

    writeDB(db);
  } finally {
    release();
  }

  if (needsReadOnlyReply) {
    // Read-only replies may hit the broker; never do this while holding the db lock.
    const portfolio = command === "/positions" ? await getAlpacaPortfolio().catch(() => null) : null;
    const reply = {
      "/status": "Quantpaca online. Broker writes require pipeline approval.",
      "/health": `Broker configured: ${getBrokerConfig().configured}; mode: ${getBrokerConfig().tradingMode}; live enabled: ${getBrokerConfig().liveTradingEnabled}.`,
      "/positions": portfolio ? JSON.stringify(portfolio.positions || []).slice(0, 3500) : "Positions unavailable.",
      "/orders": JSON.stringify(await getAlpacaOpenOrders().catch(() => [])).slice(0, 3500),
      "/trades": JSON.stringify(productionStore.listTradeIntents(10)).slice(0, 3500),
      "/sync": "Sync command accepted. Use admin API with ADMIN_API_TOKEN for execution.",
      "/dry_run": "Dry-run path available through reviewed signals, sizing, risk, and audit endpoints.",
      "/risk": JSON.stringify(productionStore.listRiskDecisions(10)).slice(0, 3500),
      "/regime": JSON.stringify(productionStore.latestRegimeAssessment() || detectRegime({})).slice(0, 3500),
    }[command] || "Command recognized.";
    outbound.push(reply);
  }

  for (const reply of outbound) {
    await sendTelegramBotMessage(chatId, reply);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/telegramMutex.test.ts`
Expected: PASS.
Run: `npm run lint && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/telegramMutex.test.ts
git commit -m "fix: serialize telegram command writes behind the db mutex"
```

---

### Task 6: Frontend sends `x-admin-token` (make Emergency Close All actually work)

**Files:**
- Create: `src/components/AdminTokenCard.tsx`
- Modify: `src/App.tsx` (state block `src/App.tsx:56-64`, handlers `src/App.tsx:125-210`, settings pane `src/App.tsx:414-431`)

**Interfaces:**
- Produces: admin token kept in `localStorage` key `quantpaca_admin_token`, sent as `x-admin-token` on `POST /api/config`, `/api/sync`, `/api/override/trade`, `/api/override/close-all`. Failures now surface via `alert`, never silently.
- Note: storing the token in `localStorage` is an accepted paper-mode tradeoff; the UI is same-origin with the server and Track 2's UI rework revisits session auth.

- [ ] **Step 1: Create the token card component**

Create `src/components/AdminTokenCard.tsx`:

```tsx
import { useState } from "react";
import { KeyRound } from "lucide-react";

export default function AdminTokenCard({
  token,
  onSaveToken,
}: {
  token: string;
  onSaveToken: (token: string) => void;
}) {
  const [draft, setDraft] = useState(token);
  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#94A3B8]">
          Admin API Token
        </h3>
        <KeyRound className="h-4 w-4 text-[#1A1A1A]" />
      </div>
      <p className="text-xs text-[#64748B] mb-3">
        Required for Sync, Manual Trade, Emergency Close, and saving settings. Stored only in this
        browser (localStorage), never sent to any third party.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Paste ADMIN_API_TOKEN"
          className="flex-1 text-xs font-mono border border-[#E2E8F0] rounded px-3 py-2 bg-[#F8F9FA]"
        />
        <button
          onClick={() => onSaveToken(draft.trim())}
          className="text-[11px] font-bold uppercase tracking-wider bg-[#1A1A1A] text-white rounded px-4 py-2 cursor-pointer"
        >
          Save
        </button>
      </div>
      <div className="mt-3 text-[10px] font-mono text-[#94A3B8] uppercase tracking-wider">
        Status: {token ? "Token configured" : "Not configured — admin actions will fail"}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add token state and header helper to App.tsx**

In `src/App.tsx`, add the import:

```tsx
import AdminTokenCard from "./components/AdminTokenCard";
```

After the Google auth state block (`src/App.tsx:56-58`), add:

```tsx
  // Admin command token (localStorage-backed; sent as x-admin-token on admin routes)
  const [adminToken, setAdminToken] = useState<string>(
    () => localStorage.getItem("quantpaca_admin_token") || "",
  );
  const saveAdminToken = (token: string) => {
    localStorage.setItem("quantpaca_admin_token", token);
    setAdminToken(token);
  };
  const adminHeaders = (): Record<string, string> =>
    adminToken ? { "x-admin-token": adminToken } : {};
```

- [ ] **Step 3: Send the header from all four admin actions and surface failures**

Replace `handleSaveConfig` (`src/App.tsx:125-141`) with:

```tsx
  const handleSaveConfig = async (updated: AppConfig) => {
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        const data = await res.json();
        setConfigs(data.config);
        fetchAllStates();
        alert("Settings configuration saved successfully.");
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Saving settings failed (HTTP ${res.status}). Check the admin token in Settings.`);
      }
    } catch (err) {
      console.error("Save config error:", err);
      alert("Saving settings failed: network error.");
    }
  };
```

In `handleForceSync` (`src/App.tsx:144-164`), replace the headers line:

```tsx
      const headers: HeadersInit = googleToken ? { Authorization: `Bearer ${googleToken}` } : {};
```

with:

```tsx
      const headers: HeadersInit = {
        ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}),
        ...adminHeaders(),
      };
```

In `handleManualTrade` (`src/App.tsx:167-191`), replace:

```tsx
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (googleToken) headers["Authorization"] = `Bearer ${googleToken}`;
```

with:

```tsx
      const headers: HeadersInit = { "Content-Type": "application/json", ...adminHeaders() };
      if (googleToken) headers["Authorization"] = `Bearer ${googleToken}`;
```

In `handleEmergencyClose` (`src/App.tsx:194-210`), replace:

```tsx
      const res = await fetch("/api/override/close-all", { method: "POST" });
```

with:

```tsx
      const res = await fetch("/api/override/close-all", {
        method: "POST",
        headers: adminHeaders(),
      });
```

- [ ] **Step 4: Render the card in the settings pane**

In the settings pane (`src/App.tsx:414-431`), add the card above `SettingsCard`:

```tsx
          <div className="space-y-6">
            <AdminTokenCard token={adminToken} onSaveToken={saveAdminToken} />
            {configs ? (
              <SettingsCard
                ...unchanged props...
              />
            ) : (
              ...unchanged fallback...
            )}
          </div>
```

- [ ] **Step 5: Verify end to end**

Run: `npm run lint` — expected clean.
Run: `ADMIN_API_TOKEN=test-admin-token-0123456789 npx tsx server.ts`, open `http://localhost:3000`, paste the token in Settings → Admin API Token → Save, then click Emergency Close All on the dashboard.
Expected: alert "Emergency close request submitted through the risk pipeline." — not a silent no-op; without the token, an explicit 401 alert.

- [ ] **Step 6: Commit**

```bash
git add src/components/AdminTokenCard.tsx src/App.tsx
git commit -m "fix: UI sends x-admin-token so emergency close, sync, trade, and config save work"
```

---

### Task 7: `FiniteNumber` branded type and `parseFiniteNumber`

**Files:**
- Create: `src/server/numericSafety.ts`
- Test: `tests/numericSafety.test.ts`

**Interfaces:**
- Produces: `type FiniteNumber = number & { readonly __brand: "FiniteNumber" }` and `parseFiniteNumber(value: unknown, fieldName: string): { ok: true; value: FiniteNumber } | { ok: false; fieldName: string }`. Tasks 10–14 consume both.

- [ ] **Step 1: Write the failing test**

Create `tests/numericSafety.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseFiniteNumber } from "../src/server/numericSafety";

const INVALID_VALUES: unknown[] = [NaN, Infinity, -Infinity, undefined, null, "", "garbage", {}, [1, 2]];

test("rejects every invalid numeric shape", () => {
  for (const value of INVALID_VALUES) {
    const result = parseFiniteNumber(value, "field");
    assert.equal(result.ok, false, `expected rejection for ${String(value)}`);
    if (!result.ok) assert.equal(result.fieldName, "field");
  }
});

test("accepts finite numbers and numeric strings", () => {
  for (const value of [0, -12.5, 1e6, "42", "3.14"]) {
    const result = parseFiniteNumber(value, "field");
    assert.equal(result.ok, true, `expected acceptance for ${String(value)}`);
    if (result.ok) assert.equal(Number.isFinite(result.value), true);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/numericSafety.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (verbatim from `docs/LOOP_ARCHITECTURE.md` "Numeric Fail-Closed Policy")**

Create `src/server/numericSafety.ts`:

```ts
export type FiniteNumber = number & { readonly __brand: "FiniteNumber" };

export type ParsedFiniteNumber =
  | { ok: true; value: FiniteNumber }
  | { ok: false; fieldName: string };

export function parseFiniteNumber(value: unknown, fieldName: string): ParsedFiniteNumber {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(n)
    ? { ok: true, value: n as FiniteNumber }
    : { ok: false, fieldName };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/numericSafety.test.ts` — PASS. Then `npm run lint && npm test` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/numericSafety.ts tests/numericSafety.test.ts
git commit -m "feat: FiniteNumber branded type with fail-closed parser"
```

---

### Task 8: Delete the weaker duplicate risk path (`basicRiskReview`, `createDefaultExitPlan`)

**Files:**
- Modify: `src/server/tradingSafety.ts:173-211` (delete both functions)

**Interfaces:**
- Consumes: nothing — both functions have zero callers (verified: no imports in `server.ts`, `src/**`, or `tests/**`).
- Produces: `riskEngine.reviewRisk` is structurally the only risk gate; there is no dead-but-callable bypass left.

- [ ] **Step 1: Verify both functions are unreferenced**

Run: `grep -rn "basicRiskReview\|createDefaultExitPlan" --include="*.ts" --include="*.tsx" . --exclude-dir=node_modules --exclude-dir=dist`
Expected: hits only inside `src/server/tradingSafety.ts` itself (the definitions).

- [ ] **Step 2: Delete `tradingSafety.ts:173-211`**

Remove the entire `createDefaultExitPlan` and `basicRiskReview` function bodies. If `assertPositiveNumber` or `roundMoney` (helpers earlier in the file) now have zero remaining callers, delete them too — check with:

Run: `grep -n "assertPositiveNumber\|roundMoney" src/server/tradingSafety.ts`

- [ ] **Step 3: Verify nothing broke**

Run: `npm run lint && npm test`
Expected: clean typecheck, all tests pass (no test imports these functions).

- [ ] **Step 4: Commit**

```bash
git add src/server/tradingSafety.ts
git commit -m "refactor: delete duplicate weaker risk-check path (basicRiskReview, createDefaultExitPlan)"
```

---

### Task 9: Allowlist approved risk statuses in `submitTradeThroughPipeline`

**Files:**
- Modify: `src/server/tradingSafety.ts` (blacklist check, currently at `tradingSafety.ts:263-266`)
- Test: `tests/tradingSafety.test.ts` (add one test)

**Interfaces:**
- Consumes: `RiskDecision.status` values: `"approved" | "approved_with_reduced_size" | "rejected" | "requires_human_approval"`.
- Produces: any status outside the two approved values — including `undefined` or a typo — blocks submission.

- [ ] **Step 1: Write the failing test**

Append to `tests/tradingSafety.test.ts`:

```ts
test("unknown or missing risk status never reaches the broker", async () => {
  for (const status of [undefined, "aproved", "APPROVED", "ok", 42] as any[]) {
    let brokerCalled = false;
    const result = await submitTradeThroughPipeline({
      request: {
        source: "manual",
        symbol: "PLTR",
        side: "buy",
        qty: 1,
        estimatedPrice: 20,
        reasoning: "allowlist test",
      },
      brokerConfig: {
        configured: true,
        tradingMode: "paper",
        liveTradingEnabled: false,
        baseUrl: "https://paper-api.alpaca.markets",
      },
      riskDecision: { status, reason: "synthetic" } as any,
      exitPlan: {
        initialStopLossPrice: 19,
        takeProfitPrice: 23,
        timeExitAt: new Date().toISOString(),
        thesisInvalidation: "n/a",
        regimeChangeAction: "close",
        emergencyAction: "market_sell",
      },
      brokerSubmit: async () => {
        brokerCalled = true;
        return { id: "should-never-happen", status: "accepted" };
      },
    });
    assert.equal(brokerCalled, false, `broker was called for status ${String(status)}`);
    assert.equal(result.trade.status, "RiskRejected");
  }
});
```

(Match the exact `brokerConfig`/`exitPlan` object shapes already used by the existing tests in this file — if the existing tests construct them differently, reuse that file's fixture shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/tradingSafety.test.ts`
Expected: FAIL — statuses like `"aproved"` currently pass the blacklist and reach `brokerSubmit`.

- [ ] **Step 3: Flip blacklist to allowlist**

In `src/server/tradingSafety.ts`, replace:

```ts
  if (input.riskDecision.status === "rejected" || input.riskDecision.status === "requires_human_approval") {
    audit("RiskRejected", input.riskDecision.reason, "PendingApproval");
    return { trade: baseTrade, auditEvents };
  }
```

with:

```ts
  const APPROVED_RISK_STATUSES: ReadonlyArray<RiskDecision["status"]> = [
    "approved",
    "approved_with_reduced_size",
  ];
  if (!APPROVED_RISK_STATUSES.includes(input.riskDecision.status)) {
    audit(
      "RiskRejected",
      input.riskDecision.reason ||
        `Risk status "${String(input.riskDecision.status)}" is not an approved status.`,
      "PendingApproval",
    );
    return { trade: baseTrade, auditEvents };
  }
```

- [ ] **Step 4: Run tests**

Run: `npm run lint && npm test`
Expected: all pass, including the new allowlist test.

- [ ] **Step 5: Commit**

```bash
git add src/server/tradingSafety.ts tests/tradingSafety.test.ts
git commit -m "fix: allowlist approved risk statuses instead of blacklisting bad ones"
```

---

### Task 10: Fail-closed numeric validation inside the risk engine

**Files:**
- Modify: `src/server/riskEngine.ts` (full-file rewrite below)
- Test: `tests/riskEngineFailClosed.test.ts`

**Interfaces:**
- Consumes: `parseFiniteNumber` from Task 7.
- Produces: `reviewRisk` rejects (never approves) when any metric, limit, or intent number fails `parseFiniteNumber`. Public signature is unchanged (`RiskInput` fields stay `number`) so `server.ts` callers keep compiling; the branded-type signature migration happens with the Track 2 Tier-2 actor rewrite. This is a deliberate, documented deviation from the doc's compile-time ideal — behavior is fail-closed now, the compile-time guarantee lands with the actor.

- [ ] **Step 1: Write the failing test**

Create `tests/riskEngineFailClosed.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { reviewRisk } from "../src/server/riskEngine";

const baseInput = () => ({
  intent: {
    id: "sti-1",
    symbol: "PLTR",
    side: "buy" as const,
    qty: 5,
    notional: 100,
    estimatedPrice: 20,
    sizingReason: "test",
    capsApplied: [],
  },
  brokerConfig: {
    configured: true,
    tradingMode: "paper" as const,
    liveTradingEnabled: false,
    baseUrl: "https://paper-api.alpaca.markets",
  },
  portfolio: {
    equity: 100000,
    buyingPower: 50000,
    longMarketValue: 0,
    pendingOrderNotional: 0,
    totalLongExposurePercent: 0,
    perSymbolConcentration: {},
    positions: [],
    openOrders: [],
    source: "alpaca" as const,
  },
  exitPlan: {
    initialStopLossPrice: 19,
    takeProfitPrice: 23,
    timeExitAt: new Date().toISOString(),
    thesisInvalidation: "n/a",
    regimeChangeAction: "close" as const,
    emergencyAction: "market_sell" as const,
  },
  metrics: { dailyLoss: 0, dailyTradeCount: 0, openPositionCount: 0 },
  limits: { maxDailyLoss: 500, maxDailyTradeCount: 10, maxOpenPositions: 10, minBuyingPower: 100 },
});

const BAD: unknown[] = [NaN, Infinity, -Infinity, undefined, null, "", "garbage"];

test("invalid metric values reject instead of silently passing", () => {
  for (const bad of BAD) {
    const input = baseInput() as any;
    input.metrics.dailyLoss = bad;
    assert.equal(reviewRisk(input).status, "rejected", `dailyLoss=${String(bad)} must reject`);
  }
});

test("invalid limit values reject instead of disabling the guardrail", () => {
  for (const bad of BAD) {
    const input = baseInput() as any;
    input.limits.maxDailyLoss = bad;
    assert.equal(reviewRisk(input).status, "rejected", `maxDailyLoss=${String(bad)} must reject`);
  }
});

test("NaN qty from a malformed request rejects", () => {
  const input = baseInput() as any;
  input.intent.qty = Number("garbage");
  input.intent.notional = Number("garbage") * 20;
  assert.equal(reviewRisk(input).status, "rejected");
});

test("valid input still approves", () => {
  assert.equal(reviewRisk(baseInput() as any).status, "approved");
});
```

(If `PortfolioAssessment` in `src/server/domainTypes.ts` has different field names than the `portfolio` fixture above, mirror the shape used by the existing `tests/productionPipeline.test.ts` fixture instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/riskEngineFailClosed.test.ts`
Expected: FAIL — e.g. `dailyLoss=NaN` currently returns `approved` because `NaN <= -500` is `false`.

- [ ] **Step 3: Rewrite `src/server/riskEngine.ts`**

```ts
import { BrokerConfig, ExitPlan, RiskDecision, validateSymbol } from "./tradingSafety";
import { PortfolioAssessment, SizedTradeIntent } from "./domainTypes";
import { parseFiniteNumber } from "./numericSafety";

type RiskInput = {
  intent: SizedTradeIntent;
  brokerConfig: BrokerConfig;
  portfolio: PortfolioAssessment;
  exitPlan?: ExitPlan;
  metrics: {
    dailyLoss: number;
    dailyTradeCount: number;
    openPositionCount: number;
  };
  limits: {
    maxDailyLoss: number;
    maxDailyTradeCount: number;
    maxOpenPositions: number;
    minBuyingPower: number;
    cooldownSymbols?: string[];
  };
};

export function reviewRisk(input: RiskInput): RiskDecision {
  // Fail-closed numeric boundary: every number used in a comparison below must
  // parse as finite here first. An unparsable value rejects the trade — it never
  // silently disables the guardrail it feeds (see docs/LOOP_ARCHITECTURE.md,
  // "Numeric Fail-Closed Policy").
  const numericFields: Array<[unknown, string]> = [
    [input.intent.qty, "intent.qty"],
    [input.intent.notional, "intent.notional"],
    [input.intent.estimatedPrice, "intent.estimatedPrice"],
    [input.portfolio.buyingPower, "portfolio.buyingPower"],
    [input.metrics.dailyLoss, "metrics.dailyLoss"],
    [input.metrics.dailyTradeCount, "metrics.dailyTradeCount"],
    [input.metrics.openPositionCount, "metrics.openPositionCount"],
    [input.limits.maxDailyLoss, "limits.maxDailyLoss"],
    [input.limits.maxDailyTradeCount, "limits.maxDailyTradeCount"],
    [input.limits.maxOpenPositions, "limits.maxOpenPositions"],
    [input.limits.minBuyingPower, "limits.minBuyingPower"],
  ];
  const parsed = new Map<string, number>();
  for (const [value, fieldName] of numericFields) {
    const result = parseFiniteNumber(value, fieldName);
    if (!result.ok) {
      return { status: "rejected", reason: `Risk input "${fieldName}" is not a finite number; failing closed.` };
    }
    parsed.set(fieldName, result.value);
  }
  const num = (fieldName: string): number => parsed.get(fieldName)!;

  const symbol = validateSymbol(input.intent.symbol);
  if (!symbol.valid) return { status: "rejected", reason: symbol.reason || "Invalid symbol." };
  if (input.brokerConfig.tradingMode === "live" && !input.brokerConfig.liveTradingEnabled) {
    return { status: "rejected", reason: "Live trading is blocked unless LIVE_TRADING_ENABLED=true." };
  }
  if (!input.exitPlan) return { status: "rejected", reason: "No order may be submitted without an exit plan." };
  if (num("intent.qty") <= 0 || num("intent.notional") <= 0) {
    return { status: "rejected", reason: "Sized trade intent has no executable quantity." };
  }
  if (num("metrics.dailyLoss") <= -Math.abs(num("limits.maxDailyLoss"))) {
    return { status: "rejected", reason: "Maximum daily loss reached." };
  }
  if (num("metrics.dailyTradeCount") >= num("limits.maxDailyTradeCount")) {
    return { status: "rejected", reason: "Maximum daily trade count reached." };
  }
  if (num("metrics.openPositionCount") >= num("limits.maxOpenPositions") && !hasPosition(input.portfolio, input.intent.symbol)) {
    return { status: "rejected", reason: "Maximum open positions reached." };
  }
  if (num("portfolio.buyingPower") - num("intent.notional") < num("limits.minBuyingPower")) {
    return { status: "rejected", reason: "Insufficient buying power after required reserve." };
  }
  if (input.portfolio.openOrders.some((order) => order.symbol === input.intent.symbol && order.side === input.intent.side && !isTerminal(order.status))) {
    return { status: "rejected", reason: "Duplicate open order protection triggered." };
  }
  if (input.limits.cooldownSymbols?.includes(input.intent.symbol)) {
    return { status: "requires_human_approval", reason: "Symbol is in cooldown after a rejected or failed trade." };
  }
  return { status: "approved", reason: "Centralized risk checks passed." };
}

function hasPosition(portfolio: PortfolioAssessment, symbol: string) {
  return portfolio.positions.some((position) => position.symbol === symbol && Number(position.qty) > 0);
}

function isTerminal(status: string) {
  return ["filled", "canceled", "cancelled", "expired", "rejected"].includes(status.toLowerCase());
}
```

- [ ] **Step 4: Run tests**

Run: `npm run lint && npm test`
Expected: all pass, including the existing `productionPipeline.test.ts` risk tests (behavior for valid input is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/server/riskEngine.ts tests/riskEngineFailClosed.test.ts
git commit -m "fix: risk engine fails closed on any non-finite metric, limit, or intent number"
```

---

### Task 11: Risk limits load from env once at startup (no more hardcoded literals)

**Files:**
- Create: `src/server/riskLimits.ts`
- Test: `tests/riskLimits.test.ts`
- Modify: `server.ts` (`executeTradeIntent` limits at `server.ts:129-134`; startup wiring in `run()` from Task 2)
- Modify: `.env.example`

**Interfaces:**
- Produces: `loadRiskLimits(env): { ok: true; limits: RiskLimits } | { ok: false; errors: string[] }` with `RiskLimits = { maxDailyLoss, maxDailyTradeCount, maxOpenPositions, minBuyingPower, maxDailyLossPercent, maxDrawdownFromPeakPercent, maxDrawdownFromBaselinePercent: FiniteNumber; baselineEquity: FiniteNumber | null }`. `server.ts` exposes module-level `let riskLimits: RiskLimits` initialized in `run()`; Tasks 12–13 consume it.
- **Operator decision:** the default values below encode risk appetite (max $500/day loss, 3%/day, 10% from peak, 15% from baseline). They are deliberately conservative placeholders — the account owner should set real values in `.env`.

- [ ] **Step 1: Write the failing test**

Create `tests/riskLimits.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadRiskLimits } from "../src/server/riskLimits";

test("defaults load when env is empty", () => {
  const result = loadRiskLimits({} as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.limits.maxDailyLoss, 500);
    assert.equal(result.limits.baselineEquity, null);
  }
});

test("env overrides win", () => {
  const result = loadRiskLimits({
    QUANTPACA_MAX_DAILY_LOSS: "250",
    QUANTPACA_BASELINE_EQUITY: "100000",
  } as NodeJS.ProcessEnv);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.limits.maxDailyLoss, 250);
    assert.equal(result.limits.baselineEquity, 100000);
  }
});

test("an unparsable limit is a startup error, not a silent default", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_DAILY_LOSS: "lots" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors[0].includes("QUANTPACA_MAX_DAILY_LOSS"));
});

test("a non-positive limit is a startup error", () => {
  const result = loadRiskLimits({ QUANTPACA_MAX_OPEN_POSITIONS: "0" } as NodeJS.ProcessEnv);
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/riskLimits.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/server/riskLimits.ts`:

```ts
import { FiniteNumber, parseFiniteNumber } from "./numericSafety";

export interface RiskLimits {
  maxDailyLoss: FiniteNumber;
  maxDailyTradeCount: FiniteNumber;
  maxOpenPositions: FiniteNumber;
  minBuyingPower: FiniteNumber;
  maxDailyLossPercent: FiniteNumber;
  maxDrawdownFromPeakPercent: FiniteNumber;
  maxDrawdownFromBaselinePercent: FiniteNumber;
  baselineEquity: FiniteNumber | null;
}

const REQUIRED_POSITIVE: Array<[keyof RiskLimits, string, string]> = [
  ["maxDailyLoss", "QUANTPACA_MAX_DAILY_LOSS", "500"],
  ["maxDailyTradeCount", "QUANTPACA_MAX_DAILY_TRADES", "10"],
  ["maxOpenPositions", "QUANTPACA_MAX_OPEN_POSITIONS", "10"],
  ["minBuyingPower", "QUANTPACA_MIN_BUYING_POWER", "100"],
  ["maxDailyLossPercent", "QUANTPACA_MAX_DAILY_LOSS_PERCENT", "3"],
  ["maxDrawdownFromPeakPercent", "QUANTPACA_MAX_DRAWDOWN_FROM_PEAK_PERCENT", "10"],
  ["maxDrawdownFromBaselinePercent", "QUANTPACA_MAX_DRAWDOWN_FROM_BASELINE_PERCENT", "15"],
];

export function loadRiskLimits(
  env: NodeJS.ProcessEnv,
): { ok: true; limits: RiskLimits } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const limits = {} as RiskLimits;

  for (const [key, envName, fallback] of REQUIRED_POSITIVE) {
    const raw = env[envName] ?? fallback;
    const parsed = parseFiniteNumber(raw, envName);
    if (!parsed.ok || parsed.value <= 0) {
      errors.push(`${envName}="${String(raw)}" must be a positive finite number.`);
      continue;
    }
    (limits[key] as FiniteNumber) = parsed.value;
  }

  // Optional: when unset, the baseline-drawdown breaker check is skipped (conservative
  // mode is enforced by the daily-loss and peak-drawdown checks, which never skip).
  const rawBaseline = env.QUANTPACA_BASELINE_EQUITY;
  if (rawBaseline === undefined || rawBaseline === "") {
    limits.baselineEquity = null;
  } else {
    const parsed = parseFiniteNumber(rawBaseline, "QUANTPACA_BASELINE_EQUITY");
    if (!parsed.ok || parsed.value <= 0) {
      errors.push(`QUANTPACA_BASELINE_EQUITY="${String(rawBaseline)}" must be a positive finite number or unset.`);
    } else {
      limits.baselineEquity = parsed.value;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, limits };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/riskLimits.test.ts` — PASS.

- [ ] **Step 5: Wire into server.ts**

Add imports and a module-level holder near the top of `server.ts` (after `const dbMutex = ...`):

```ts
import { loadRiskLimits, RiskLimits } from "./src/server/riskLimits";
```

```ts
let riskLimits: RiskLimits;
{
  const loaded = loadRiskLimits(process.env);
  if (!loaded.ok) {
    for (const error of loaded.errors) console.error(`[startup:fatal] ${error}`);
    console.error("[startup] Invalid risk limit configuration. Refusing to start.");
    process.exit(1);
  }
  riskLimits = loaded.limits;
}
```

(Module scope, not inside `run()`, so test imports of `server.ts` also get valid limits.)

In `executeTradeIntent`, replace the hardcoded limits (`server.ts:129-134`):

```ts
    limits: {
      maxDailyLoss: 500,
      maxDailyTradeCount: 10,
      maxOpenPositions: 10,
      minBuyingPower: 100,
    },
```

with:

```ts
    limits: {
      maxDailyLoss: riskLimits.maxDailyLoss,
      maxDailyTradeCount: riskLimits.maxDailyTradeCount,
      maxOpenPositions: riskLimits.maxOpenPositions,
      minBuyingPower: riskLimits.minBuyingPower,
    },
```

Append to `.env.example`:

```text
# Risk limits — loaded ONCE at process start; not configurable at runtime by design
# (docs/LOOP_ARCHITECTURE.md "Structural Immutability of Risk Thresholds").
# Defaults are conservative placeholders; set values matching your risk appetite.
QUANTPACA_MAX_DAILY_LOSS="500"
QUANTPACA_MAX_DAILY_TRADES="10"
QUANTPACA_MAX_OPEN_POSITIONS="10"
QUANTPACA_MIN_BUYING_POWER="100"
QUANTPACA_MAX_DAILY_LOSS_PERCENT="3"
QUANTPACA_MAX_DRAWDOWN_FROM_PEAK_PERCENT="10"
QUANTPACA_MAX_DRAWDOWN_FROM_BASELINE_PERCENT="15"
# Optional: account baseline for the baseline-drawdown breaker. Unset = check skipped.
QUANTPACA_BASELINE_EQUITY=""
```

- [ ] **Step 6: Run everything**

Run: `npm run lint && npm test` — clean.
Run: `QUANTPACA_MAX_DAILY_LOSS=lots npx tsx server.ts; echo "exit=$?"` — expected fatal startup error, `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add src/server/riskLimits.ts tests/riskLimits.test.ts server.ts .env.example
git commit -m "feat: env-loaded immutable risk limits replace hardcoded literals"
```

---

### Task 12: Portfolio drawdown breaker

**Files:**
- Create: `src/server/breakerEngine.ts`
- Test: `tests/breakerEngine.test.ts`
- Modify: `src/server/persistence.ts` (add `breaker_states` table + two methods)
- Modify: `server.ts` (`executeTradeIntent` `server.ts:89-148`; new `GET /api/breaker/latest` route next to `/api/regime/latest` at `server.ts:589`)
- Modify: `src/server/riskEngine.ts` (add `breaker` input field)

**Interfaces:**
- Consumes: `parseFiniteNumber`/`FiniteNumber` (Task 7), `riskLimits` (Task 11), fail-closed `reviewRisk` (Task 10).
- Produces:
  - `evaluateBreaker(input: BreakerInput): BreakerState` where `BreakerState = { status: "ok" | "block_new_buys" | "close_only"; reasons: string[]; asOf: string; peakEquity: number | null; metrics: { equity: number | null; dailyLossPercent: number | null; drawdownFromPeakPercent: number | null; drawdownFromBaselinePercent: number | null } }`.
  - `ProductionStore.saveBreakerState(state: unknown): void` and `latestBreakerState<T>(): T | undefined`.
  - `reviewRisk` gains a required `breaker: { status: "ok" | "block_new_buys" | "close_only" }` input; buys reject unless `status === "ok"`; sells are always allowed through the breaker (closing risk reduces exposure).

- [ ] **Step 1: Write the failing engine test**

Create `tests/breakerEngine.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBreaker } from "../src/server/breakerEngine";

const limits = {
  maxDailyLossPercent: 3,
  maxDrawdownFromPeakPercent: 10,
  maxDrawdownFromBaselinePercent: 15,
} as any;

test("healthy account is ok and tracks the peak", () => {
  const state = evaluateBreaker({
    equity: 105000,
    lastEquity: 104000,
    previousPeakEquity: 104000,
    baselineEquity: 100000,
    limits,
  });
  assert.equal(state.status, "ok");
  assert.equal(state.peakEquity, 105000);
});

test("daily loss beyond the percent limit blocks new buys", () => {
  const state = evaluateBreaker({
    equity: 96000,
    lastEquity: 100000, // -4% on the day vs 3% limit
    previousPeakEquity: 100000,
    baselineEquity: 100000,
    limits,
  });
  assert.equal(state.status, "block_new_buys");
  assert.ok(state.reasons.some((r) => r.includes("daily")));
});

test("drawdown from peak beyond the limit blocks new buys", () => {
  const state = evaluateBreaker({
    equity: 89000,
    lastEquity: 89500, // small daily move, big cumulative drawdown
    previousPeakEquity: 100000, // -11% from peak vs 10% limit
    baselineEquity: null,
    limits,
  });
  assert.equal(state.status, "block_new_buys");
});

test("drawdown from baseline beyond the limit goes close-only", () => {
  const state = evaluateBreaker({
    equity: 84000,
    lastEquity: 84500,
    previousPeakEquity: 85000,
    baselineEquity: 100000, // -16% from baseline vs 15% limit
    limits,
  });
  assert.equal(state.status, "close_only");
});

test("unparseable equity fails closed to block_new_buys", () => {
  for (const bad of [NaN, undefined, null, "", "garbage"]) {
    const state = evaluateBreaker({
      equity: bad,
      lastEquity: 100000,
      previousPeakEquity: 100000,
      baselineEquity: 100000,
      limits,
    });
    assert.equal(state.status, "block_new_buys", `equity=${String(bad)}`);
    assert.ok(state.reasons.some((r) => r.includes("unparseable")));
  }
});

test("null baseline skips only the baseline check", () => {
  const state = evaluateBreaker({
    equity: 99000,
    lastEquity: 100000,
    previousPeakEquity: 100000,
    baselineEquity: null,
    limits,
  });
  assert.equal(state.status, "ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/breakerEngine.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement the engine**

Create `src/server/breakerEngine.ts`:

```ts
import { FiniteNumber, parseFiniteNumber } from "./numericSafety";

export type BreakerStatus = "ok" | "block_new_buys" | "close_only";

export interface BreakerLimits {
  maxDailyLossPercent: FiniteNumber;
  maxDrawdownFromPeakPercent: FiniteNumber;
  maxDrawdownFromBaselinePercent: FiniteNumber;
}

export interface BreakerInput {
  equity: unknown; // current account equity (broker truth)
  lastEquity: unknown; // prior-close equity (Alpaca account.last_equity)
  previousPeakEquity: unknown; // high-water mark from the last persisted state; null on first run
  baselineEquity: FiniteNumber | null; // configured account baseline; null = check skipped
  limits: BreakerLimits;
}

export interface BreakerState {
  status: BreakerStatus;
  reasons: string[];
  asOf: string;
  peakEquity: number | null;
  metrics: {
    equity: number | null;
    dailyLossPercent: number | null;
    drawdownFromPeakPercent: number | null;
    drawdownFromBaselinePercent: number | null;
  };
}

export function evaluateBreaker(input: BreakerInput): BreakerState {
  const asOf = new Date().toISOString();
  const equity = parseFiniteNumber(input.equity, "equity");
  const lastEquity = parseFiniteNumber(input.lastEquity, "lastEquity");

  if (!equity.ok || !lastEquity.ok || equity.value <= 0 || lastEquity.value <= 0) {
    return {
      status: "block_new_buys",
      reasons: ["unparseable_or_nonpositive_equity_inputs"],
      asOf,
      peakEquity: null,
      metrics: { equity: null, dailyLossPercent: null, drawdownFromPeakPercent: null, drawdownFromBaselinePercent: null },
    };
  }

  const previousPeak = parseFiniteNumber(input.previousPeakEquity, "previousPeakEquity");
  const peakEquity = Math.max(previousPeak.ok ? previousPeak.value : equity.value, equity.value);

  const reasons: string[] = [];
  let status: BreakerStatus = "ok";

  const dailyLossPercent = ((lastEquity.value - equity.value) / lastEquity.value) * 100;
  if (dailyLossPercent >= input.limits.maxDailyLossPercent) {
    reasons.push(`daily loss ${dailyLossPercent.toFixed(2)}% >= limit ${input.limits.maxDailyLossPercent}%`);
    status = "block_new_buys";
  }

  const drawdownFromPeakPercent = ((peakEquity - equity.value) / peakEquity) * 100;
  if (drawdownFromPeakPercent >= input.limits.maxDrawdownFromPeakPercent) {
    reasons.push(`drawdown from peak ${drawdownFromPeakPercent.toFixed(2)}% >= limit ${input.limits.maxDrawdownFromPeakPercent}%`);
    status = "block_new_buys";
  }

  let drawdownFromBaselinePercent: number | null = null;
  if (input.baselineEquity !== null) {
    drawdownFromBaselinePercent = ((input.baselineEquity - equity.value) / input.baselineEquity) * 100;
    if (drawdownFromBaselinePercent >= input.limits.maxDrawdownFromBaselinePercent) {
      reasons.push(`drawdown from baseline ${drawdownFromBaselinePercent.toFixed(2)}% >= limit ${input.limits.maxDrawdownFromBaselinePercent}%`);
      status = "close_only";
    }
  }

  return {
    status,
    reasons,
    asOf,
    peakEquity,
    metrics: { equity: equity.value, dailyLossPercent, drawdownFromPeakPercent, drawdownFromBaselinePercent },
  };
}
```

- [ ] **Step 4: Run engine tests**

Run: `npx tsx --test tests/breakerEngine.test.ts` — PASS (6 tests).

- [ ] **Step 5: Persist breaker states**

In `src/server/persistence.ts`, add to the `ProductionStore` type (after `latestReconciliationReport`):

```ts
  saveBreakerState(state: { asOf: string; status: string }): void;
  latestBreakerState<T = unknown>(): T | undefined;
```

Add to the `CREATE TABLE` block:

```sql
    CREATE TABLE IF NOT EXISTS breaker_states (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
```

Add to the returned object (following the `saveReconciliationReport` pattern):

```ts
    saveBreakerState(state) {
      db.prepare("INSERT OR REPLACE INTO breaker_states (id, timestamp, status, payload_json) VALUES (?, ?, ?, ?)")
        .run(`breaker-${state.asOf}`, state.asOf, state.status, JSON.stringify(state));
    },
    latestBreakerState() {
      return rowToPayload(db.prepare("SELECT payload_json FROM breaker_states ORDER BY timestamp DESC LIMIT 1").get());
    },
```

Also enable WAL + busy timeout while touching this file (production review, medium-severity finding) — after `const db = new NodeDatabaseSync(...)`:

```ts
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
```

- [ ] **Step 6: Gate trades on the breaker in `executeTradeIntent`**

In `src/server/riskEngine.ts`, add to `RiskInput`:

```ts
  breaker: {
    status: "ok" | "block_new_buys" | "close_only";
  };
```

and add this check immediately after the numeric-validation block in `reviewRisk`:

```ts
  if (input.intent.side === "buy" && input.breaker.status !== "ok") {
    return { status: "rejected", reason: `Portfolio drawdown breaker is ${input.breaker.status}; new buys are blocked.` };
  }
```

Update the two existing `reviewRisk` call fixtures in `tests/productionPipeline.test.ts` and the fixture in `tests/riskEngineFailClosed.test.ts` to include `breaker: { status: "ok" }`.

In `server.ts` `executeTradeIntent`, import the engine:

```ts
import { evaluateBreaker } from "./src/server/breakerEngine";
```

and insert between the `portfolioAssessment` computation and `createExitPlan` (`server.ts:102-103`):

```ts
  const previousBreaker = productionStore.latestBreakerState<{ peakEquity: number | null }>();
  const breakerState = evaluateBreaker({
    equity: portfolio.equity,
    // Simulated portfolios have no prior-close equity; treating equity as last_equity
    // zeroes the daily-loss check offline. A REAL broker account must supply last_equity —
    // no fallback when brokerConfig.configured is true.
    lastEquity: brokerConfig.configured ? portfolio.last_equity : (portfolio.last_equity ?? portfolio.equity),
    previousPeakEquity: previousBreaker?.peakEquity ?? null,
    baselineEquity: riskLimits.baselineEquity,
    limits: {
      maxDailyLossPercent: riskLimits.maxDailyLossPercent,
      maxDrawdownFromPeakPercent: riskLimits.maxDrawdownFromPeakPercent,
      maxDrawdownFromBaselinePercent: riskLimits.maxDrawdownFromBaselinePercent,
    },
  });
  productionStore.saveBreakerState(breakerState);
```

and pass it into the `reviewRisk` call (alongside `metrics`/`limits`):

```ts
    breaker: { status: breakerState.status },
```

Also replace the hardcoded `dailyLoss: 0` metric (`server.ts:125`) with the real value:

```ts
      dailyLoss: (() => {
        // Same fallback rule as the breaker input above: a REAL broker must supply
        // last_equity (missing -> NaN -> reviewRisk fails closed); the simulated
        // portfolio treats equity as prior close (daily loss 0).
        const lastEquityForDaily = brokerConfig.configured
          ? Number(portfolio.last_equity)
          : Number(portfolio.last_equity ?? portfolio.equity);
        return breakerState.metrics.equity !== null
          ? breakerState.metrics.equity - lastEquityForDaily
          : Number.NaN;
      })(),
```

(For the unconfigured/simulated broker, `portfolio.last_equity ?? portfolio.equity` above keeps this finite at 0.)

- [ ] **Step 7: Expose the breaker state**

Next to `GET /api/regime/latest` (`server.ts:589`), add:

```ts
app.get("/api/breaker/latest", (req, res) => {
  res.json(productionStore.latestBreakerState() || { status: "ok", reasons: ["no_evaluation_yet"], asOf: null });
});
```

- [ ] **Step 8: Run everything**

Run: `npm run lint && npm test`
Expected: clean; the updated fixtures pass.

- [ ] **Step 9: Commit**

```bash
git add src/server/breakerEngine.ts src/server/persistence.ts src/server/riskEngine.ts server.ts tests/breakerEngine.test.ts tests/productionPipeline.test.ts tests/riskEngineFailClosed.test.ts
git commit -m "feat: portfolio drawdown breaker gates all new buys; WAL mode for sqlite"
```

---

### Task 13: Replace inline sync-loop sizing with the sizing engine; fix the price source; kill `|| 10`

**Files:**
- Modify: `server.ts` (auto-trade BUY block, `server.ts:1084-1141`; add `sizeTradeIntent` import)
- Test: `tests/productionPipeline.test.ts` (add one sizing regression test)
- Modify: `.env.example` (add `ALPACA_DATA_URL`)

**Interfaces:**
- Consumes: `sizeTradeIntent` (`src/server/sizingEngine.ts:18` — currently dead in production), `reviewedSignal` already in scope at `server.ts:1071`, `riskLimits` (Task 11).
- Produces: one sizing implementation for the whole system; price comes from the Alpaca market-data host (`https://data.alpaca.markets/v2/stocks/{symbol}/trades/latest`), not the trading host; a sub-one-share allocation skips the trade instead of buying 10 shares.

- [ ] **Step 1: Write the failing regression test**

Append to `tests/productionPipeline.test.ts` (reuse that file's existing fixture helpers for `ReviewedSignal`/`RegimeAssessment`/`PortfolioAssessment`):

```ts
test("sizing a sub-one-share allocation yields qty 0, never a fallback quantity", () => {
  const sized = sizeTradeIntent({
    reviewedSignal: acceptedSignalFixture("NVDA"), // use this file's existing accepted-signal fixture
    regime: regimeFixture({ tradePermission: "allow", sizeMultiplier: 1 }),
    portfolio: portfolioFixture({ equity: 1000, buyingPower: 1000 }),
    side: "buy",
    estimatedPrice: 900, // max position 10% of $1000 = $100 < one $900 share
    stopLossPrice: 855,
    limits: {
      maxSinglePositionPercent: 10,
      maxPortfolioExposurePercent: 100,
      maxNotionalPerTrade: 100,
      minBuyingPowerAfterTrade: 0,
    },
  });
  assert.equal(sized.qty, 0);
});
```

(Adapt fixture-helper names to what the file actually defines; if it builds objects inline, build them inline here with the same shapes.)

- [ ] **Step 2: Run to verify it passes already at the engine level, then confirm the server-side bug**

Run: `npx tsx --test tests/productionPipeline.test.ts`
Expected: PASS — `sizeTradeIntent` is already correct (`Math.max(0, Math.floor(...))` at `sizingEngine.ts:63`). The bug is that `server.ts:1126` doesn't use it: `const qty = Math.floor(purchaseAmount / price) || 10;`. This test pins the engine behavior the server is about to adopt.

- [ ] **Step 3: Rewrite the BUY sizing block in server.ts**

Add to the imports at the top of `server.ts`:

```ts
import { sizeTradeIntent } from "./src/server/sizingEngine";
```

Replace the block from the portfolio-value computation through the end of the BUY branch (`server.ts:1088-1141`) with:

```ts
          // Verify current position size limit
          const portfolio = await getAlpacaPortfolio();
          const parsedPortfolioValue = Number(portfolio.portfolio_value);
          if (!Number.isFinite(parsedPortfolioValue) || parsedPortfolioValue <= 0) {
            addLog("error", `Order skipped for ${item.symbol}. Portfolio value is not a finite number; failing closed.`);
            continue;
          }
          const maxPositionValue = parsedPortfolioValue * (currentConfig.system.maxPositionSizePercent / 100);

          let price = 0;
          try {
            const brokerConfig = getBrokerConfig();
            if (brokerConfig.configured) {
              // Market data lives on data.alpaca.markets, not the trading host.
              const dataBaseUrl = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
              const latestTrade = await fetch(`${dataBaseUrl}/v2/stocks/${item.symbol}/trades/latest`, {
                headers: {
                  "APCA-API-KEY-ID": brokerConfig.apiKey || "",
                  "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
                },
              });
              if (latestTrade.ok) {
                const body = await latestTrade.json();
                price = Number(body.trade?.p || 0);
              }
            } else {
              const simulatedPos = (portfolio.positions || []).find((p: any) => p.symbol === item.symbol);
              price = Number(simulatedPos?.current_price || 0);
            }
          } catch (e) {
            addLog("error", `Price lookup failed for ${item.symbol}: ${e instanceof Error ? e.message : String(e)}`);
          }

          if (!price || !Number.isFinite(price) || price <= 0) {
            addLog("error", `Order skipped for ${item.symbol}. No deterministic market price was available.`);
            continue;
          }

          if (item.decision === "BUY") {
            const portfolioAssessment = assessPortfolio({
              account: portfolio,
              positions: portfolio.positions || [],
              openOrders: await getAlpacaOpenOrders(),
              source: getBrokerConfig().configured ? "alpaca" : "local_simulated_snapshot",
            });
            const regime = productionStore.latestRegimeAssessment() || detectRegime({});
            const stopLossPercent = Number(currentConfig.system.stopLossPercent);
            if (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0) {
              addLog("error", `Order skipped for ${item.symbol}. stopLossPercent is not a positive finite number.`);
              continue;
            }
            const sized = sizeTradeIntent({
              reviewedSignal,
              regime,
              portfolio: portfolioAssessment,
              side: "buy",
              estimatedPrice: price,
              stopLossPrice: price * (1 - stopLossPercent / 100),
              limits: {
                maxSinglePositionPercent: currentConfig.system.maxPositionSizePercent,
                maxPortfolioExposurePercent: 100,
                maxNotionalPerTrade: maxPositionValue,
                minBuyingPowerAfterTrade: riskLimits.minBuyingPower,
              },
            });

            if (sized.qty < 1) {
              addLog("error", `Order skipped for ${item.symbol}. Sizing produced no executable quantity (${sized.sizingReason}; caps: ${sized.capsApplied.join(", ")}).`);
            } else {
              addLog("sync", `Submitting buy intent for ${sized.qty} shares of ${item.symbol} at approx $${price} through safety pipeline...`);
              const newTrade = await executeTradeIntent({
                db,
                config: currentConfig,
                request: {
                  source: "automation",
                  symbol: item.symbol,
                  qty: sized.qty,
                  estimatedPrice: price,
                  side: "buy",
                  reasoning: `ZipTrader thesis validated. Whipsaw check: ${item.whipsawCheck}. Fundamentals: ${item.reasoning}`,
                },
                maxNotional: maxPositionValue,
              });
```

Keep the rest of the BUY branch (Telegram/Sheets/Notion notifications, `db.trades.unshift`, the simulated-portfolio update — substituting `sized.qty` for the old `qty` variable) and the existing SELL branch unchanged.

Append to `.env.example`:

```text
# Alpaca market data host (separate from the trading API host).
ALPACA_DATA_URL="https://data.alpaca.markets"
```

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm test`
Expected: clean. Manually verify: `grep -n "|| 10" server.ts` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/productionPipeline.test.ts .env.example
git commit -m "fix: sync loop uses the central sizing engine, correct market-data host, no fallback quantity"
```

---

### Task 14: Safety property test suite

**Files:**
- Test: `tests/safetyProperties.test.ts`

**Interfaces:**
- Consumes: `reviewRisk` (Task 10 shape incl. `breaker`), `evaluateBreaker` (Task 12), `sizeTradeIntent`, `parseFiniteNumber`.
- Produces: the suite required by `docs/LOOP_ARCHITECTURE.md` Phase 1 — every numeric boundary injected with every invalid shape must reject or trip, never pass.

- [ ] **Step 1: Write the suite (it should pass immediately if Tasks 7–13 are correct — a failure here is a real bug)**

Create `tests/safetyProperties.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseFiniteNumber } from "../src/server/numericSafety";
import { reviewRisk } from "../src/server/riskEngine";
import { evaluateBreaker } from "../src/server/breakerEngine";
import { sizeTradeIntent } from "../src/server/sizingEngine";

const BAD_VALUES: unknown[] = [NaN, Infinity, -Infinity, undefined, null, "", "garbage"];

// --- reviewRisk: every numeric field, every bad value ---
const riskBase = () => ({
  intent: { id: "sti-1", symbol: "PLTR", side: "buy" as const, qty: 5, notional: 100, estimatedPrice: 20, sizingReason: "t", capsApplied: [] },
  brokerConfig: { configured: true, tradingMode: "paper" as const, liveTradingEnabled: false, baseUrl: "https://paper-api.alpaca.markets" },
  portfolio: { equity: 100000, buyingPower: 50000, longMarketValue: 0, pendingOrderNotional: 0, totalLongExposurePercent: 0, perSymbolConcentration: {}, positions: [], openOrders: [], source: "alpaca" as const },
  exitPlan: { initialStopLossPrice: 19, takeProfitPrice: 23, timeExitAt: new Date().toISOString(), thesisInvalidation: "n/a", regimeChangeAction: "close" as const, emergencyAction: "market_sell" as const },
  metrics: { dailyLoss: 0, dailyTradeCount: 0, openPositionCount: 0 },
  limits: { maxDailyLoss: 500, maxDailyTradeCount: 10, maxOpenPositions: 10, minBuyingPower: 100 },
  breaker: { status: "ok" as const },
});

const RISK_NUMERIC_PATHS: Array<[string, (input: any, v: unknown) => void]> = [
  ["intent.qty", (i, v) => (i.intent.qty = v)],
  ["intent.notional", (i, v) => (i.intent.notional = v)],
  ["intent.estimatedPrice", (i, v) => (i.intent.estimatedPrice = v)],
  ["portfolio.buyingPower", (i, v) => (i.portfolio.buyingPower = v)],
  ["metrics.dailyLoss", (i, v) => (i.metrics.dailyLoss = v)],
  ["metrics.dailyTradeCount", (i, v) => (i.metrics.dailyTradeCount = v)],
  ["metrics.openPositionCount", (i, v) => (i.metrics.openPositionCount = v)],
  ["limits.maxDailyLoss", (i, v) => (i.limits.maxDailyLoss = v)],
  ["limits.maxDailyTradeCount", (i, v) => (i.limits.maxDailyTradeCount = v)],
  ["limits.maxOpenPositions", (i, v) => (i.limits.maxOpenPositions = v)],
  ["limits.minBuyingPower", (i, v) => (i.limits.minBuyingPower = v)],
];

test("property: reviewRisk rejects every invalid value at every numeric boundary", () => {
  for (const [name, inject] of RISK_NUMERIC_PATHS) {
    for (const bad of BAD_VALUES) {
      const input = riskBase() as any;
      inject(input, bad);
      const decision = reviewRisk(input);
      assert.equal(decision.status, "rejected", `${name}=${String(bad)} must reject, got ${decision.status}`);
    }
  }
});

test("property: breaker trips block_new_buys on every invalid equity input", () => {
  const limits = { maxDailyLossPercent: 3, maxDrawdownFromPeakPercent: 10, maxDrawdownFromBaselinePercent: 15 } as any;
  for (const bad of BAD_VALUES) {
    for (const field of ["equity", "lastEquity"] as const) {
      const input: any = { equity: 100000, lastEquity: 100000, previousPeakEquity: 100000, baselineEquity: null, limits };
      input[field] = bad;
      const state = evaluateBreaker(input);
      assert.notEqual(state.status, "ok", `${field}=${String(bad)} must not be ok`);
    }
  }
});

test("property: sizing yields qty 0 for every invalid price", () => {
  for (const bad of BAD_VALUES) {
    const sized = sizeTradeIntent({
      reviewedSignal: { id: "rs-1", symbol: "PLTR", status: "accepted", confidenceScore: 80, source: "email", sourceId: "s", sourceTimestamp: new Date().toISOString(), thesis: "t" } as any,
      regime: { id: "rg-1", timestamp: new Date().toISOString(), marketMode: "unclear", tradePermission: "reduce_size", sizeMultiplier: 0.5 } as any,
      portfolio: { equity: 100000, buyingPower: 50000, longMarketValue: 0, pendingOrderNotional: 0, totalLongExposurePercent: 0, perSymbolConcentration: {}, positions: [], openOrders: [], source: "alpaca" } as any,
      side: "buy",
      estimatedPrice: bad as number,
      stopLossPrice: 19,
      limits: { maxSinglePositionPercent: 10, maxPortfolioExposurePercent: 100, maxNotionalPerTrade: 10000, minBuyingPowerAfterTrade: 0 },
    });
    assert.equal(sized.qty, 0, `estimatedPrice=${String(bad)} must size to 0`);
  }
});

test("property: parseFiniteNumber is the single source of truth for validity", () => {
  for (const bad of BAD_VALUES) {
    assert.equal(parseFiniteNumber(bad, "x").ok, false);
  }
});
```

(Adjust the `ReviewedSignal`/`RegimeAssessment`/`PortfolioAssessment` fixture fields to the exact shapes in `src/server/domainTypes.ts`.)

- [ ] **Step 2: Run the suite**

Run: `npx tsx --test tests/safetyProperties.test.ts`
Expected: PASS. If any property fails, that is a genuine hole in Tasks 7–13 — fix the engine, not the test.

- [ ] **Step 3: Run everything and commit**

Run: `npm run lint && npm test` — clean.

```bash
git add tests/safetyProperties.test.ts
git commit -m "test: safety property suite — invalid numerics always reject or trip the breaker"
```

---

### Task 15: CI gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: typecheck + test gate on every push/PR once the repo gets a GitHub remote. Inert but ready until then.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 2: Verify the same commands locally (CI parity)**

Run: `npm ci && npm run lint && npm test`
Expected: clean install, clean typecheck, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck and test gate"
```

---

## Out of Scope (next plans, per docs/LOOP_ARCHITECTURE.md sequencing)

Recorded here so nobody mistakes this plan for the whole road to production:

- **Track 2 (own plan):** loop runner + checkpoints/heartbeats, the Tier 2 Trade Execution Actor, `correlationId`/trace spans, the `callModel` wrapper with timeouts/circuit breaker, staleness contracts, a real scheduler for the sync cycle (`runIntervalMins` is currently decorative — nothing calls `/api/sync` on a timer), real regime inputs (`detectRegime` is only ever called with `{}`), real Google OAuth (current token is a hardcoded mock at `src/services/googleAuth.ts:11-23`), Gemini model pinning + `"MOCK_KEY"` fallback removal, fill/exit monitors, reconciliation enforcement, db.json retirement.
- **Track 3 (gated, possibly never):** Strategy Evolution / Shadow Evaluation / Promotion Gate — blocked until ~90 days or 200 closed trades of manual paper operation per the architecture doc.
- **Deployment target decision:** process supervisor + host (Cloud Run vs local + pm2/launchd) — Task 3's exit-on-crash policy assumes a supervisor restarts the process; pick one before unattended paper operation.
- **Remaining high-severity review findings not in Track 0/1:** auth on read endpoints (`/api/trades`, `/api/portfolio`, `/api/audit`, ... are world-readable) and rate limiting (none anywhere, including Gemini-calling routes). Cheap to add once the server is exposed beyond localhost; decide with the deployment target. Until then, do not bind the server to a public interface.
