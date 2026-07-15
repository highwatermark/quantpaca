#!/usr/bin/env node
// Phase 2 follow-up (docs/GO_LIVE_PLAN.md sign-off item 2): one-time,
// interactive helper that obtains a Google OAuth refresh token for the
// Gmail read-only scope, so unattended SCHEDULED sync cycles can mint their
// own short-lived access tokens via src/server/googleTokenBroker.ts -- no
// browser session needed once this is done. Plain Node, NO npm dependencies
// (per the task's binding "no new deps" constraint): only node: built-ins
// (http, url) plus the global `fetch` (Node 24).
//
// Usage:
//   node scripts/get-google-refresh-token.mjs --client-id=ID --client-secret=SECRET
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-google-refresh-token.mjs
//   node scripts/get-google-refresh-token.mjs --help
//
// See docs/OPS_RUNBOOK.md, "Connect Gmail", for the full walkthrough
// (create a Google Cloud project, enable the Gmail API, create a "Desktop
// app" OAuth client, run this script, paste the printed lines into .env,
// restart the server).
//
// Security note: this script prints the refresh token to YOUR terminal on
// purpose -- that is its entire job, so you can paste it into .env. It never
// sends the token anywhere except the one token-exchange POST to Google's
// own token endpoint, and it never writes .env for you (you paste the
// printed lines in yourself, so you always see exactly what's being added).

import http from "node:http";
import { URL } from "node:url";

const PORT = 8724;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function printHelp() {
  console.log(`
Get a Google OAuth refresh token for unattended Gmail ingestion (Quantpaca).

Usage:
  node scripts/get-google-refresh-token.mjs [--client-id=ID] [--client-secret=SECRET]

Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the environment if the
matching --client-id=/--client-secret= flag is not given. Both are required
(one of each, from either source).

Prerequisites (see docs/OPS_RUNBOOK.md "Connect Gmail" for the full walkthrough):
  1. Create (or reuse) a Google Cloud project.
  2. Enable the Gmail API for that project.
  3. Create an OAuth 2.0 Client ID of type "Desktop app".
  4. Note the client ID and client secret -- you'll pass them to this script.

What this script does:
  1. Starts a local HTTP listener on localhost:${PORT} (loopback only --
     nothing outside your machine can reach it).
  2. Prints a Google consent URL -- open it in a browser and approve
     read-only Gmail access for the account you want the server to read.
  3. Google redirects back to localhost:${PORT} with a one-time
     authorization code; this script exchanges it for an access token AND a
     refresh token (access_type=offline, prompt=consent force a refresh
     token even if you've consented before).
  4. Prints the refresh token and the exact three .env lines to add, then
     exits.

The printed refresh token is a long-lived secret -- treat it like a
password. Add it to .env (already gitignored in this repo), never commit
it, and restart the server for scheduled Gmail ingestion to pick it up.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  const clientId = (typeof args["client-id"] === "string" && args["client-id"]) || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = (typeof args["client-secret"] === "string" && args["client-secret"]) || process.env.GOOGLE_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    console.error("Missing GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET (set as env vars, or pass --client-id=/--client-secret=).");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\nOpen this URL in a browser and approve access:\n");
  console.log(authUrl.toString());
  console.log(`\nWaiting for Google's redirect on ${REDIRECT_URI} ...\n`);

  let code;
  try {
    code = await waitForAuthorizationCode();
  } catch (err) {
    console.error(`Failed waiting for Google's redirect: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log("Authorization code received. Exchanging for tokens...\n");

  let tokenRes;
  try {
    tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    });
  } catch (err) {
    console.error(`Token exchange request failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    console.error(`Token exchange failed (HTTP ${tokenRes.status}): ${text}`);
    process.exitCode = 1;
    return;
  }

  const data = await tokenRes.json();
  if (!data.refresh_token) {
    console.error(
      "No refresh_token in the response. Google only issues one on first consent for a client/account pair, or " +
        "when re-consent is forced (this script always requests prompt=consent, so that should not be the cause). " +
        "If you've already authorized this OAuth client for this account before and still see this, revoke prior " +
        "access at https://myaccount.google.com/permissions and re-run this script.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("Success. Add these three lines to your .env (never commit them):\n");
  console.log(`GOOGLE_CLIENT_ID="${clientId}"`);
  console.log(`GOOGLE_CLIENT_SECRET="${clientSecret}"`);
  console.log(`GOOGLE_REFRESH_TOKEN="${data.refresh_token}"`);
  console.log("\nRestart the server after adding these -- scheduled Gmail ingestion will pick them up automatically.");
}

function waitForAuthorizationCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqUrl;
      try {
        reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      if (reqUrl.pathname !== "/oauth2callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      if (error) {
        res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(`Google returned an error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Missing code parameter. You can close this tab.");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("Authorization received. You can close this tab and return to the terminal.");
      server.close();
      resolve(code);
    });
    server.on("error", (err) => reject(err));
    server.listen(PORT, "localhost");
  });
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
