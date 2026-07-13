// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): read-endpoint auth
// (requireReadToken) + the /api/* rate limiter, tested through the real
// server wiring -- same convention as tests/apiConfigAuth.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-read-auth-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";
process.env.QUANTPACA_READ_TOKEN = "test-read-only-token-0123456789";

const { app } = await import("../server");

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

test("GET /api/trades: no token -> 401", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/trades`);
    assert.equal(res.status, 401);
  });
});

test("GET /api/trades: wrong token -> 401", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/trades`, {
      headers: { "x-read-token": "not-the-right-token-at-all" },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /api/trades: the dedicated read token -> 200", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/trades`, {
      headers: { "x-read-token": "test-read-only-token-0123456789" },
    });
    assert.equal(res.status, 200);
  });
});

test("GET /api/trades: the admin token also works (EITHER token is accepted)", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/trades`, {
      headers: { "x-admin-token": "test-admin-token-0123456789" },
    });
    assert.equal(res.status, 200);
  });
});

test("multiple read routes are all protected the same way", async () => {
  await withServer(async (port) => {
    const routes = [
      "/api/config",
      "/api/analyses",
      "/api/trades",
      "/api/logs",
      "/api/audit",
      "/api/regime/latest",
      "/api/breaker/latest",
      "/api/portfolio/assessment",
      "/api/signals/reviewed",
      "/api/trade-intents",
      "/api/risk-decisions",
      "/api/exit-plans",
      "/api/do-not-buy",
      "/api/reconciliation/latest",
      "/api/telegram/status",
      "/api/portfolio",
    ];
    for (const route of routes) {
      const noToken = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(noToken.status, 401, `${route} without a token should be 401`);

      const withToken = await fetch(`http://127.0.0.1:${port}${route}`, {
        headers: { "x-admin-token": "test-admin-token-0123456789" },
      });
      assert.notEqual(withToken.status, 401, `${route} with the admin token should not be 401 (got ${withToken.status})`);
    }
  });
});

test("GET /api/health: unauthenticated -> 200, and the payload has no equity/token fields", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const serialized = JSON.stringify(body).toLowerCase();
    assert.ok(!serialized.includes("equity"), `health payload must not include equity, got: ${serialized}`);
    assert.ok(!serialized.includes("token"), `health payload must not include a token field, got: ${serialized}`);
    assert.ok(!serialized.includes("position"), `health payload must not include position details, got: ${serialized}`);
    // The booleans this endpoint is explicitly allowed to keep:
    assert.equal(typeof body.broker.configured, "boolean");
    assert.equal(typeof body.broker.reachable, "boolean");
  });
});

// Rate-limit end-to-end coverage lives in its own file
// (tests/rateLimitIntegration.test.ts) -- the app-level limiter is a single
// process-lifetime instance, so it must be the ONLY thing consuming its
// budget for an exact-request-count assertion to mean anything; sharing a
// file with these auth tests would pollute the count.
