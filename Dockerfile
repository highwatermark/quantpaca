# Phase 2 Task 12 (docs/GO_LIVE_PLAN.md Phase 2.5): supervisor container image.
# Multi-stage: the build stage needs devDependencies (vite/esbuild/tsx/tsc);
# the runtime stage installs production deps only and copies dist/ across.
#
# Restart policy and the crash-loop limit live OUTSIDE this file:
#   - docker-compose.yml sets `restart: on-failure` (crash -> auto-restart ->
#     startup reconciliation -> resume).
#   - The 3-boots-in-1-hour crash-loop limit (guardrail 9) is enforced
#     IN-PROCESS at boot (src/server/crashLoopGuard.ts + server.ts run()),
#     because Docker's own restart policies never give up on their own. The
#     crash-loop branch exits 0 -- the only exit code `restart: on-failure`
#     will NOT restart -- see crashLoopGuard.ts's
#     CRASH_LOOP_STAY_DOWN_EXIT_CODE comment before "fixing" that.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# vite build (frontend -> dist/) + esbuild (server.ts -> dist/server.cjs).
RUN npm run build

FROM node:24-slim AS runtime
# Serve the prebuilt dist/ (run() only mounts the vite dev middleware when
# NODE_ENV != production). Not a new app env var -- standard Node convention.
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# The esbuild bundle uses --packages=external, so production node_modules
# (express, vite, dotenv, @anthropic-ai/sdk, ...) must exist at runtime.
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# data/ holds SQLite (quantpaca.sqlite), db.json, and signal-sources.json --
# docker-compose.yml mounts a host volume here so state survives container
# replacement. Created ahead of time so it is owned by the non-root user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
# node:24-slim ships no curl/wget; Node's global fetch does the probe.
# /api/health returns 200 when healthy and 502 when the broker is configured
# but unreachable -- r.ok maps that straight to the healthcheck exit code.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.cjs"]
