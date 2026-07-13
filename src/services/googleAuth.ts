// Phase 2 Task 13 (docs/GO_LIVE_PLAN.md Phase 2.5): mock Google OAuth
// retirement.
//
// Investigation: this module's cached token was NOT dead code. server.ts's
// Gmail ingestion (email signal source) and Google Sheets export
// (appendTradeToSheets) both forward whatever `Authorization` header the
// client sends as `authHeader` -- and App.tsx's only source for that header
// was this module's `loginWithGoogle`, which used to hand back a hardcoded
// fake, hardcoded Google-style access token. There is no
// GOOGLE_ACCESS_TOKEN-style server-side credential anywhere in this codebase
// (grepped: none) -- the mock string here was the ONLY thing ever populating
// that header. Since a real feature (Gmail ingestion / Sheets export)
// genuinely depends on this module, the task brief's "replace with an
// honest not-configured no-op" branch applies -- deleting the module
// entirely would silently break the Authorization-header plumbing that a
// REAL OAuth integration would need to slot into later.
//
// So: this module never issues a real token (no OAuth client is wired up in
// this deployment) and never fabricates one either. `loginWithGoogle` now
// rejects, explaining why, instead of resolving with a token that always
// fails against the real Gmail/Sheets APIs while the UI dishonestly claims
// "Sheets & Gmail: Live". The get/set primitives are left in place as the
// integration point a real OAuth flow (or an operator manually pasting a
// token they obtained some other way) would use -- see App.tsx's
// handleGoogleLogin, which now surfaces the rejection instead of pretending
// success.
let cachedAccessToken: string | null = null;
let googleUser: { name: string; email: string } | null = null;

export const initGoogleOAuth = () => {
  // No real token is ever fabricated here -- returns whatever was
  // previously cached (null on a fresh load), same as before.
  return cachedAccessToken;
};

// Was a simulated OAuth popup that always "succeeded" with a hardcoded mock
// token. No real Google OAuth client is configured in this deployment, so
// this now fails honestly instead of faking a connection that would only
// ever 401 against the real Gmail/Sheets APIs.
export const loginWithGoogle = async (): Promise<{ name: string; email: string; token: string }> => {
  throw new Error(
    "Google Sign-In is not configured in this deployment (no OAuth client is wired up). " +
      "Gmail ingestion and Google Sheets export need a real OAuth access token in the Authorization " +
      "header; there is no simulated login to fall back to.",
  );
};

export const getCachedToken = () => cachedAccessToken;
export const setCachedToken = (token: string | null) => {
  cachedAccessToken = token;
};

export const getGoogleUser = () => googleUser;
export const setGoogleUser = (user: { name: string; email: string } | null) => {
  googleUser = user;
};

export const logoutGoogle = () => {
  cachedAccessToken = null;
  googleUser = null;
};
