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

## Global Constraints

- `LIVE_TRADING_ENABLED` + `TRADING_MODE` double-gate must remain env-only and unchanged (`tradingSafety.ts:93-108`); nothing in this plan may make it configurable at runtime.
- No `NaN`, `Infinity`, `undefined`, `null`, `""`, or unparsable string may reach a risk comparison; invalid input rejects the trade or trips the breaker (fail closed), never silently passes.
- One central risk engine (`src/server/riskEngine.ts`); duplicate/weaker risk-check functions are deleted, not deprecated.
- Every trade state transition appends an audit event (existing `submitTradeThroughPipeline` pattern — preserve it).
- Risk/breaker thresholds load once from env at process start; they are never writable via `/api/config`, Telegram, or any runtime path.
- All new env vars must be added to `.env.example` in the same task that introduces them.
- Test runner is `tsx --test tests/*.test.ts`; type gate is `npm run lint` (`tsc --noEmit`). Both must pass at the end of every task.
- Commit after every task. The repo has no git history until Task 1 creates it.

