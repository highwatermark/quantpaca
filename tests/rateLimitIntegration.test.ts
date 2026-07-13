// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): the /api/* rate limiter,
// end-to-end through the real app. Isolated in its OWN file (not sharing a
// file with tests/readEndpointAuth.test.ts) because the limiter is a single
// process-lifetime instance keyed by IP -- any other test in the same file
// hitting a rate-limited route would consume from the same budget and break
// an exact-request-count assertion like this one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.QUANTPACA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quantpaca-ratelimit-"));
process.env.ADMIN_API_TOKEN = "test-admin-token-0123456789";

const { app } = await import("../server");
const { RATE_LIMIT_PER_MINUTE } = await import("../src/server/rateLimiter");

test("rate limit: request (limit+1) in a window from the same IP gets 429; /api/health is exempt throughout", async () => {
  const listener = app.listen(0);
  const port = (listener.address() as { port: number }).port;
  try {
    let firstTooManyAtIndex: number | undefined;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 1; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { "x-admin-token": "test-admin-token-0123456789" },
      });
      if (res.status === 429) {
        firstTooManyAtIndex = i;
        break;
      }
      assert.equal(res.status, 200, `request ${i} should succeed (not yet rate-limited)`);
    }
    assert.equal(
      firstTooManyAtIndex,
      RATE_LIMIT_PER_MINUTE,
      `expected exactly the (${RATE_LIMIT_PER_MINUTE + 1})th request (0-indexed: ${RATE_LIMIT_PER_MINUTE}) to be the first 429`,
    );

    // /api/health must stay exempt even while this IP is rate-limited.
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 200, "/api/health must be exempt from the rate limiter");
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
