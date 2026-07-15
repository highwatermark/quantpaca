// Phase 2 follow-up (sanctioned, sign-off item 2 of the Phase 2 completion
// report in docs/GO_LIVE_PLAN.md): server-side Gmail refresh-token auth, so
// email signal sources keep working on unattended SCHEDULED cycles.
//
// Background: server.ts's runSyncCycle forwards whatever `Authorization`
// header the caller supplies as `authHeader` to Gmail ingestion + Google
// Sheets export. A manual sync driven by a browser session can carry one; a
// scheduled cycle has no user session and always passed null -- making every
// email signal source structurally inert unattended. Google access tokens
// live ~1h; a REFRESH token (obtained once via user consent, see
// scripts/get-google-refresh-token.mjs) can mint fresh access tokens
// indefinitely without a human in the loop. This module is that minting
// step: given GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN,
// exchange the refresh token for a short-lived access token at
// https://oauth2.googleapis.com/token, cache it in-memory, and hand it back
// as a ready-to-use `Authorization: Bearer <token>` header.
//
// Fail-closed contract (binding, docs/GO_LIVE_PLAN.md): any of the three env
// vars absent means "not configured" -- return null, make zero network
// calls, and log it ONCE (not every cycle; a scheduler tick every 15 min
// would otherwise spam this line forever). An exchange failure (network
// error, non-OK response, malformed body) also returns null and logs, but
// NEVER throws -- server.ts's existing zero-email-signals degradation path
// (the throttled Telegram alert in runSyncCycle) already covers "no Gmail
// authorization token this cycle" for any reason, so this module doesn't
// need its own alerting -- it just needs to fail honestly and quietly.
//
// Never log token values -- every log line below carries only HTTP status
// codes, Google's own (non-secret) error strings, or static text.
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS, type FetchLike } from "./httpDefaults";
import { parseFiniteNumber } from "./numericSafety";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Refresh 5 minutes before actual expiry -- matches the brief's "cache
// in-memory until 5 min before expiry" verbatim. Named constant (not a magic
// number) so the single-flight/expiry tests above document intent.
export const EARLY_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type GoogleTokenBrokerLog = (message: string) => void;

export interface GetBrokerAccessTokenOptions {
  // Defaults to process.env in production; tests inject a plain object.
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: GoogleTokenBrokerLog;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// --- Module-level state ------------------------------------------------
// Deliberately module-scoped (not per-call): the whole point is ONE cached
// token shared across every caller in the process (Gmail ingestion, Sheets
// export, however many sync cycles run before it expires), and ONE in-flight
// exchange promise so concurrent callers within the same tick never trigger
// duplicate token exchanges against Google.
let cachedToken: CachedToken | null = null;
let inFlightExchange: Promise<string | null> | null = null;
let hasLoggedNotConfigured = false;

// Test-only reset -- mirrors server.ts's existing "*ForTests" convention
// (runScheduledSyncTickForTests, runCrashLoopBootCheckForTests, etc.) for a
// test-visible escape hatch into otherwise-private module state.
export function resetGoogleTokenBrokerForTests(): void {
  cachedToken = null;
  inFlightExchange = null;
  hasLoggedNotConfigured = false;
}

const REQUIRED_ENV_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;

export function isGoogleTokenBrokerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED_ENV_VARS.every((name) => Boolean((env[name] || "").trim()));
}

function defaultLog(message: string): void {
  console.error(message);
}

async function exchangeRefreshToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl: FetchLike;
  log: GoogleTokenBrokerLog;
}): Promise<{ accessToken: string; expiresInSeconds: number } | null> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  }).toString();

  try {
    // POST, form-encoded -- per policy (httpDefaults.ts) a non-GET request
    // gets zero retries: a network-level retry of a token exchange could
    // double-hit Google, and a fresh exchange is cheap to just re-request on
    // the NEXT call anyway (see the "failed exchange does not poison the
    // cache" test -- nothing here needs a same-call retry).
    const res = await fetchWithTimeout(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      DEFAULT_FETCH_TIMEOUT_MS,
      params.fetchImpl,
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // errText is Google's OWN error payload (e.g. {"error":"invalid_grant"})
      // -- never the client secret or refresh token, which this module never
      // echoes back into a log line.
      params.log(`[googleTokenBroker] Refresh token exchange failed with HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    const expiresParsed = parseFiniteNumber(data.expires_in, "expires_in");
    if (typeof data.access_token !== "string" || data.access_token.length === 0 || !expiresParsed.ok) {
      params.log("[googleTokenBroker] Refresh token exchange returned a malformed response (missing access_token or a finite expires_in).");
      return null;
    }

    return { accessToken: data.access_token, expiresInSeconds: expiresParsed.value };
  } catch (err) {
    params.log(`[googleTokenBroker] Refresh token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Returns a cached-or-freshly-exchanged Gmail access token, or null if the
// broker is not configured or the exchange failed. Never throws.
export async function getBrokerAccessToken(options: GetBrokerAccessTokenOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? defaultLog;

  const clientId = (env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = (env.GOOGLE_REFRESH_TOKEN || "").trim();

  if (!clientId || !clientSecret || !refreshToken) {
    if (!hasLoggedNotConfigured) {
      hasLoggedNotConfigured = true;
      log(
        "[googleTokenBroker] Not configured -- GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must " +
          "ALL be set for the server to mint its own Gmail access tokens on scheduled (unattended) cycles. Email " +
          "signal sources stay inert on scheduled cycles until all three are configured; see " +
          "scripts/get-google-refresh-token.mjs. (Logged once; this will not repeat every cycle.)",
      );
    }
    return null;
  }

  const nowMs = now();
  if (cachedToken && cachedToken.expiresAtMs - EARLY_REFRESH_MARGIN_MS > nowMs) {
    return cachedToken.accessToken;
  }

  // Single-flight: if an exchange is already underway, every concurrent
  // caller awaits that SAME promise rather than starting its own. Note this
  // function has no `await` above this line, so two back-to-back
  // (unawaited) calls in the same synchronous turn -- e.g.
  // `Promise.all([getBrokerAccessToken(), getBrokerAccessToken()])` -- both
  // run their synchronous prefix (including this check) before either
  // promise chain below actually settles, guaranteeing the second call sees
  // the first call's already-assigned inFlightExchange.
  if (inFlightExchange) {
    return inFlightExchange;
  }

  inFlightExchange = exchangeRefreshToken({ clientId, clientSecret, refreshToken, fetchImpl, log })
    .then((result) => {
      if (result) {
        cachedToken = { accessToken: result.accessToken, expiresAtMs: nowMs + result.expiresInSeconds * 1000 };
        return result.accessToken;
      }
      // A failed exchange must not poison the cache with a stale/partial
      // entry -- leave cachedToken as whatever it already was (null on a
      // first-ever failure) so the very next call retries cleanly.
      return null;
    })
    .finally(() => {
      inFlightExchange = null;
    });

  return inFlightExchange;
}

// Convenience wrapper: the exact `Authorization` header shape server.ts's
// runSyncCycle already threads through Gmail ingestion + Sheets export, or
// null under the same not-configured/failed conditions as
// getBrokerAccessToken.
export async function getBrokerAuthHeader(options: GetBrokerAccessTokenOptions = {}): Promise<string | null> {
  const token = await getBrokerAccessToken(options);
  return token ? `Bearer ${token}` : null;
}
