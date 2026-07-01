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
