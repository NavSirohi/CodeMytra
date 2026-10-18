# CodeMytra — Baseline Audit Report

**Date:** 2026-10-18  
**Engineer:** CodeMytra team  
**Status:** P0 blockers resolved; baseline documented honestly.

> This document captures the current state of the codebase as-found, with known failures documented truthfully. It will be updated after each milestone.

---

## Environment

| Item | Value |
|---|---|
| Node.js required | 20+ |
| Package manager | npm (use `npm ci`) |
| Next.js | 16.2.9 |
| Prisma | 7.8.0 |
| React | 19.2.4 |
| TypeScript | 5.x |
| node_modules status | ❌ Not installed (requires `npm ci` + credentials) |

---

## P0 Issues — Resolved

### ✅ Hardcoded E2B API Key (CRITICAL)

- **Found in:** `sanbox-templates/nextjs/build.ts` line 12
- **Value exposed:** `e2b_bf8e535c13c02ee0355eaee8255e06bebd54d593` (teacher's key)
- **Action taken:** Key removed from source, replaced with `process.env.E2B_API_KEY` with startup guard
- **External action required:** The teacher must revoke/rotate this key via the [E2B dashboard](https://e2b.dev). Removing it from code is NOT sufficient if the key is still valid or accessible in git history.
- **Status:** ✅ Removed from working code | ⚠️ Teacher must revoke the key externally

### ✅ Hardcoded E2B Template ID

- **Found in:** `src/features/inngest/functions.ts` line 36
- **Value:** `ugwj9f6y2wocdpps7omf` (teacher's template)
- **Action taken:** Replaced with `process.env.E2B_TEMPLATE_ID` with helpful error message
- **Status:** ✅ Fixed

### ✅ Duplicate / Unconfigured Gemini Model Instance

- **Found in:** `functions.ts` line 85 — `model: gemini({ model: "gemini-2.5-flash" })` with no API key
- **Action taken:** Replaced with the properly configured `geminiModel` variable
- **Status:** ✅ Fixed

### ✅ Raw Agent Output Logged to Console

- **Found in:** `functions.ts` lines 193, 225, 241 and `utils.ts` line 176
- **Risk:** Logs contain generated source code and agent responses — potential data exposure in production
- **Action taken:** All `console.log` calls removed. Structured logging will be added in M1.
- **Status:** ✅ Fixed

### ✅ Implicit `any` Type

- **Found in:** `utils.ts` line 71 — `function lastAssistantTextMessageContent(result)` with no type annotation
- **Action taken:** Added `AgentResult` type, properly typed content map
- **Status:** ✅ Fixed

---

## P1 Issues — Documented (Not Yet Fixed)

### ⚠️ No Source Snapshot / Sandbox Restore

- **Problem:** Each generation creates a brand-new E2B sandbox. Follow-up prompts cannot access files from previous runs. The second generation effectively rewrites the app from scratch.
- **Impact:** Multi-turn development is broken at the data layer.
- **Fix:** Implement `ProjectRevision` snapshots and sandbox restore (M1-P1-02).
- **Status:** 📋 Planned for M1

### ⚠️ Success Detected by `<task_summary>` String Parsing

- **Problem:** `codeAgentFunction` marks a generation successful if it finds the string `<task_summary>` in the output AND `files` is non-empty. No build or type check is run.
- **Impact:** A broken app passes as successful.
- **Fix:** Structured agent output with Zod + actual QA gate (M1-P1-03, P1-04).
- **Status:** 📋 Planned for M1

### ⚠️ Outbox Pattern Missing

- **Problem:** In `projects/actions/index.ts`, the project is persisted to DB BEFORE the Inngest event is sent. If the event send fails, the project exists with no associated run — silently stuck.
- **Fix:** Use idempotency keys and a durable dispatch pattern (M1-P1-01).
- **Status:** 📋 Planned for M1

### ⚠️ No Automated Tests

- **Problem:** Zero test files exist in the repository.
- **Impact:** Regressions cannot be caught automatically.
- **Fix:** Unit + integration + E2E tests will be added alongside M1 features.
- **Status:** 📋 Planned for M1

### ⚠️ No CI/CD Pipeline

- **Problem:** No `.github/workflows/` exists. No automated lint, type check, or build on PRs.
- **Fix:** CI pipeline will be added in M1.
- **Status:** 📋 Planned for M1

### ⚠️ `http://` Sandbox URL in Iframe

- **Problem:** `functions.ts` line 250 generates `http://` URL from `sandbox.getHost(3000)`. This may be blocked in secure contexts or by browser iframe policies.
- **Fix:** Verify E2B supports HTTPS exposure for sandbox ports and update accordingly.
- **Status:** 📋 Planned for M1

### ⚠️ Dead Code — `processTask` Function

- **Problem:** `processTask` in `functions.ts` handles `app/task.created` events but is never used in the product flow.
- **Fix:** Remove in M1 cleanup commit.
- **Status:** 📋 Planned for M1

---

## Checks That CANNOT Run Yet (Credentials Required)

The following checks require real environment credentials that are not yet configured:

| Check | Status | Blocker |
|---|---|---|
| `npm ci` | ❌ Not run | No node_modules |
| `npx tsc --noEmit` | ❌ Not run | Requires npm ci + prisma generate |
| `npm run build` | ❌ Not run | Requires npm ci + credentials |
| `npm run lint` | ❌ Not run | Requires npm ci |
| Prisma migrate (dev) | ❌ Not run | Requires Neon DATABASE_URL |
| Inngest smoke test | ❌ Not run | Requires Inngest + E2B keys |
| E2B sandbox creation | ❌ Not run | Requires user's own E2B key |
| Clerk sign-in | ❌ Not run | Requires Clerk dev keys |

**These will be re-run and results recorded here after credentials are provided.**

---

## Git History

```
6f1b8a4 (HEAD) chore: establish project as new baseline
9d2bff7 (backup/old-project) Merge pull request #1 from NavSirohi/Db-Setup
16719fc Db Setup
f81cadd Setup Successful
```

Teacher's original history is preserved in `backup/old-project`. No history has been fabricated or rewritten.

---

## Next Steps

1. User provides their Neon, Clerk, Gemini, Inngest, and E2B credentials
2. Run `npm ci`, `prisma generate`, `prisma migrate deploy`
3. Re-run tsc, lint, and build — record actual results here
4. Begin M1 implementation (revision snapshots, state machine, structured contracts)
