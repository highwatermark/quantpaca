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

  // Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): QUANTPACA_READ_TOKEN
  // gates the new read-only endpoints (server.ts's requireReadToken). Same
  // placeholder/short-value validation as ADMIN_API_TOKEN above, but an
  // UNSET read token is always just a warning -- server.ts's requireReadToken
  // falls back to accepting the admin token for reads, so there is no
  // "live trading requires it" fatal branch here (reads never gate trading).
  const readToken = (env.QUANTPACA_READ_TOKEN || "").trim();
  if (readToken === "change-me") {
    issues.push({
      level: "fatal",
      message:
        'QUANTPACA_READ_TOKEN is still the placeholder "change-me" from .env.example. Set a real secret before starting.',
    });
  } else if (readToken.length > 0 && readToken.length < MIN_TOKEN_LENGTH) {
    issues.push({
      level: "fatal",
      message: `QUANTPACA_READ_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`,
    });
  } else if (!readToken) {
    issues.push({
      level: "warn",
      message:
        "QUANTPACA_READ_TOKEN is unset; read endpoints will require the ADMIN_API_TOKEN instead. Consider setting a dedicated read-only token for lower-privilege consumers (dashboards, monitors).",
    });
  }

  // Phase 2 follow-up (docs/GO_LIVE_PLAN.md sign-off item 2): server-side
  // Gmail refresh-token auth (src/server/googleTokenBroker.ts) needs ALL
  // THREE of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
  // to mint access tokens for unattended scheduled cycles. A partial set (1
  // or 2 of 3) is a misconfiguration that must fail loudly at boot rather
  // than silently leaving the broker "not configured" (same null result as
  // an operator who never intended to use it) -- an operator who set two of
  // three env vars almost certainly meant to enable this and would otherwise
  // never notice scheduled email ingestion staying inert. Zero set (never
  // touched the feature) and all three set (fully configured) both boot
  // cleanly. Never echoes the value of any GOOGLE_* var in the message --
  // only which var names are missing.
  const googleEnvVars = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
  const googlePresent = googleEnvVars.filter((name) => (env[name] || "").trim().length > 0);
  if (googlePresent.length > 0 && googlePresent.length < googleEnvVars.length) {
    const missing = googleEnvVars.filter((name) => !googlePresent.includes(name));
    issues.push({
      level: "fatal",
      message:
        `Partial Google OAuth broker configuration: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. ` +
        "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set ALL THREE or NONE -- a partial " +
        "set would silently leave scheduled Gmail ingestion inert instead of failing loudly. Run " +
        "scripts/get-google-refresh-token.mjs to obtain all three, or unset the ones you have to disable the broker.",
    });
  }

  return issues;
}
