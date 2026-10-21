# CodeMytra — Development Guide

> **Read this first.** This document distinguishes the teacher's original code from CodeMytra's own contributions, explains the architecture, and is the single source of truth for development setup.

---

## 1. Attribution: Teacher's Original vs My Contributions

### Teacher's Original Baseline (`backup/old-project` branch)

The Chai0 prototype (teacher's code) provides:

| Module | File(s) | What it does |
|---|---|---|
| Auth | `src/features/auth/actions/index.ts` | Clerk sign-in + Postgres upsert |
| DB Models | `prisma/schema.prisma` | `User`, `Project`, `Message`, `Fragment` |
| DB Migrations | `prisma/migrations/` | 3 initial migrations |
| Project actions | `src/features/projects/actions/index.ts` | CRUD with ownership checks |
| Message actions | `src/features/messages/actions/index.ts` | Create + poll messages |
| Inngest pipeline | `src/features/inngest/functions.ts` | Single code agent → E2B → fragment |
| UI components | `src/components/` | Shadcn components, project view, code viewer |
| Sandbox template | `sanbox-templates/nextjs/template.ts` | Bun + Next.js E2B template definition |

### My Own Contributions (this branch and beyond)

| Date | Change | Branch/Commit |
|---|---|---|
| 2026-10-18 | Security: removed hardcoded E2B API key from `build.ts` | `feat-P0-secure-baseline` |
| 2026-10-18 | Security: removed hardcoded template ID from `functions.ts`, replaced with env var guard | `feat-P0-secure-baseline` |
| 2026-10-18 | Security: removed all `console.log` calls leaking raw agent output | `feat-P0-secure-baseline` |
| 2026-10-18 | Types: fixed implicit `any` in `utils.ts`, typed all function signatures | `feat-P0-secure-baseline` |
| 2026-10-18 | Config: unified `geminiModel` usage (removed second unconfigured `gemini()` call) | `feat-P0-secure-baseline` |
| 2026-10-20 | Migration: migrated AI generation pipeline from Gemini to OpenAI (GPT-4o, GPT-4o mini) | `security-hardening-m4` |
| 2026-10-18 | Branding: renamed product to CodeMytra throughout (metadata, logo, package.json) | `feat-P0-secure-baseline` |
| 2026-10-18 | Config: comprehensive `.gitignore`, `.env.example`, `next.config.ts` with security headers | `feat-P0-secure-baseline` |
| 2026-10-18 | DB: updated `prisma/schema.prisma` datasource with `url` and `directUrl` for Neon | `feat-P0-secure-baseline` |
| 2026-10-18 | Docs: `README.md`, `DEVELOPMENT.md`, `ENGINEERING_HANDOFF.md`, `docs/baseline-audit.md` | `feat-P0-secure-baseline` |

---

## 2. Architecture

### Current State (Working Baseline)

```
Browser (Next.js UI)
  │  Clerk-authenticated server actions
  ▼
PostgreSQL (Neon)
  └─ User → Project → Message → Fragment
       │
       │  Inngest event: code-agent/run
       ▼
  Inngest Workflow
       │
       ├─ Create E2B sandbox
       ├─ Restore conversation messages
       ├─ Run multi-agent pipeline (OpenAI GPT-4o / GPT-4o mini: Planner, Designer, Architect, Coder, QA)
       ├─ Extract files from sandbox
       ├─ Run title generator (GPT-4o mini text agent)
       ├─ Run response generator (GPT-4o mini text agent)
       └─ Save Fragment (files JSON + sandbox URL) → DB
```

**Known limitations of the baseline (not yet fixed):**
- Every generation creates a FRESH sandbox (follow-up edits start over)
- Success detected by `<task_summary>` tag, not build verification
- No test suite
- No CI/CD pipeline

### Target Architecture (Being Built)

```
Browser (Next.js UI)
  │  Requirements wizard → PRD approval
  │  Agent progress timeline
  │  Revision history, diff viewer
  │  ZIP export
  │  "Deploy — Coming Soon" (disabled)
  ▼
Next.js Server Actions / Route Handlers (Control Plane)
  └─ Neon PostgreSQL
       ├─ User, Project, Message, Fragment (existing)
       ├─ GenerationRun, AgentTask, RunEvent (NEW — M1)
       ├─ ProjectRevision, ProjectSpecification (NEW — M1)
       └─ Plan, CreditLedger, UsageRecord (NEW — M5)
            │
            │  Inngest orchestration
            ▼
       Coordinator (deterministic state machine)
            ├─ Requirements/Planning Agent → PRD
            ├─ Design Agent → DesignSpec
            ├─ Architecture Agent → ArchitectureSpec
            │    [User approves]
            ├─ Frontend Agent (file-ownership restricted)
            ├─ Backend Agent (file-ownership restricted)
            ├─ Database Agent (disposable DB only)
            ├─ Integration Agent (single-writer merge)
            └─ QA Agent → build + lint + type check + Playwright
                 │
                 ├─ PASS → immutable ProjectRevision snapshot
                 └─ FAIL → bounded repair loop (max 2 attempts)
```

---

## 3. Database Schema Changes

### Strategy

- **ADDITIVE ONLY** — never drop or rename existing columns/tables in production
- **Two connection strings** for Neon:
  - `DATABASE_URL` → pooled (PgBouncer), used by the running app
  - `DATABASE_URL_DIRECT` → direct, used by `prisma migrate` only
- All migrations go in `prisma/migrations/` with descriptive names

### Current Models (teacher's baseline)

- `User` — Clerk ID + profile
- `Project` — belongs to User
- `Message` — belongs to Project, role (USER/ASSISTANT), type (RESULT/ERROR)
- `Fragment` — belongs to Message, has `files` JSON + `sandboxUrl`

### Planned Additions (M1 — In Progress)

- `GenerationRun` — tracks each generation attempt with status, tokens, cost
- `AgentTask` — individual agent task within a run (planner, designer, etc.)
- `RunEvent` — immutable append-only event log for UI timeline
- `ProjectRevision` — immutable snapshot of full file tree after QA pass
- `ProjectSpecification` — versioned PRD, DesignSpec, ArchitectureSpec

### Planned Additions (M5 — Future)

- `CreditLedger` — credit reserve/settle/release accounting
- `UsageRecord` — per-agent token and sandbox usage metering
- `Plan`, `Subscription`, `Payment` — billing (Razorpay first, Stripe-compatible)

---

## 4. Multi-Agent Orchestration Design

### Agent Roles and Contracts

Each agent receives a typed input artifact and produces a typed output artifact validated with Zod. Agents communicate through persisted artifacts, not shared mutable state.

| Agent | Input | Output | Allowed Tools |
|---|---|---|---|
| Requirements/Planner | User prompt + wizard answers | `PRD` (goal, personas, pages, flows, criteria) | Read references only |
| Design | Approved PRD | `DesignSpec` (palette, typography, layout) | Approved asset catalog |
| Architecture | Approved PRD + template | `ArchitectureSpec` (stack, schema, APIs, deps) | Read templates/docs |
| Frontend | Specs + file ownership | Component tree, pages, tests | Owned files only |
| Backend | Specs + API contract | Route handlers, validation, tests | Backend-owned files |
| Database | Data requirements | Schema, migrations, seed scripts | Disposable DB + schema files |
| Integration | All patches + contracts | Merged conflict-free candidate | Controlled merge only |
| QA | Candidate revision | `QAReport` (commands, exit codes, pass/fail) | Sandbox tests + screenshots |

### File Ownership

The Integration Agent is the **only** agent that can modify shared files:
- `package.json`, lockfile
- `prisma/schema.prisma`
- Shared type files
- Route wiring

Individual agents work on their **owned paths only** and propose patches. Integration merges.

### State Machine

```
CREATED → DISCOVERY → DRAFTING_PRD → AWAITING_PRD_APPROVAL
  → DESIGNING → ARCHITECTING → AWAITING_BUILD_APPROVAL
  → IMPLEMENTING → INTEGRATING → VALIDATING → READY
```

Exits: `FAILED`, `CANCELLED`, `NEEDS_INPUT`

---

## 5. Local Setup

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20+ | Check: `node --version` |
| npm | Included with Node | Use `npm ci` — don't mix package managers |

### External Services You Need

| Service | Purpose | Sign up at |
|---|---|---|
| [Neon](https://neon.tech) | PostgreSQL database | Free tier available |
| [Clerk](https://clerk.dev) | Authentication | Create a **development** app, not production |
| [OpenAI Platform](https://platform.openai.com) | OpenAI LLM (GPT-4o, GPT-4o mini) | API key required |
| [Inngest](https://inngest.com) | Agent orchestration | Local dev server, no account needed initially |
| [E2B](https://e2b.dev) | Code execution sandboxes | **Create your own account** — do not reuse the teacher's key |

### Step-by-Step Setup

```bash
# 1. Install dependencies (use npm ci to respect package-lock.json)
npm ci

# 2. Copy env template
cp .env.example .env
# → Fill in all values in .env

# 3. Generate Prisma client
npx prisma generate

# 4. Run migrations against Neon
#    (uses DATABASE_URL_DIRECT to bypass PgBouncer)
npx prisma migrate deploy

# 5. Start the Next.js dev server (port 3000)
npm run dev

# 6. Start Inngest dev server (separate terminal, port 8288)
npx inngest-cli@latest dev

# Open http://localhost:3000
# Open http://localhost:8288 for Inngest dashboard
```

### Verifying the Setup

- [ ] `http://localhost:3000` loads without errors
- [ ] Sign-in with Clerk works
- [ ] Creating a project appears in the database
- [ ] Inngest dashboard shows the `codemytra` app registered
- [ ] (After E2B setup) Creating a project triggers a generation run

### Troubleshooting

**`DATABASE_URL_DIRECT is not set`** → Add both `DATABASE_URL` and `DATABASE_URL_DIRECT` to `.env`.

**`E2B_TEMPLATE_ID is not set`** → You need to build your own E2B template first. Run:
```bash
npx ts-node sanbox-templates/nextjs/build.ts
```
Then copy the resulting template ID into `E2B_TEMPLATE_ID` in `.env`.

**Prisma generate fails** → Run `npx prisma generate` before `npm run dev`. The generated client is in `src/generated/prisma/` (gitignored).

**Inngest functions not showing** → Make sure the Inngest dev server is running (`npx inngest-cli@latest dev`) and pointing to `http://localhost:3000/api/inngest`.

---

## 6. Deployment (CodeMytra Platform)

> This section covers deploying **CodeMytra itself** to Vercel. Customer-generated apps are preview-only in this MVP.

### Checklist (before going live)

- [ ] Vercel project connected to the GitHub repo
- [ ] All production environment variables set in Vercel dashboard (not in repo)
- [ ] Neon production database created (separate from dev DB)
- [ ] Clerk production application created with `codemytra.com` domain
- [ ] Inngest production app registered, signing key set
- [ ] E2B production credentials set (your own key)
- [ ] `npx prisma migrate deploy` run against the production database
- [ ] `NEXT_PUBLIC_APP_URL` set to `https://codemytra.com`
- [ ] Vercel domain configured for `codemytra.com`

### Inngest Production Setup

Inngest requires a publicly accessible endpoint. After deploying to Vercel:

1. Register `https://codemytra.com/api/inngest` in the Inngest dashboard
2. Set `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` in Vercel environment variables
3. Verify events reach Inngest in the production dashboard

---

## 7. Demo Account (Interviewer Access)

> **Credentials are shared via a private channel, never in this file or the repo.**

The demo account is a restricted Clerk user with:
- Read access to curated seed projects
- Limited generation credits (server-enforced, not just UI)
- No ability to delete projects, modify billing, or access production deployment
- No admin privileges

To test the demo: open an incognito browser, sign in with the credentials shared privately, and verify the generation limit is respected.

---

## 8. What's NOT in This MVP

The following are intentionally excluded to maintain focus and reduce risk:

- ❌ Customer app deployment (visible "Deploy — Coming Soon" button)
- ❌ Razorpay payments (schema designed for it, activation deferred)
- ❌ Kubernetes or arbitrary cloud deployment
- ❌ Multi-user collaboration
- ❌ BYOM / local model companion
- ❌ Azure deployment adapter

---

## 9. Test Coverage Status

| Area | Status |
|---|---|
| Unit tests (schemas, auth, ownership) | 📋 Not yet written |
| Integration tests (Prisma + Inngest) | 📋 Not yet written |
| E2E tests (Playwright: login → generate → preview) | 📋 Not yet written |
| Manual smoke test (local) | ✅ Verified each development session |

Tests will be added alongside each M1/M2 feature PR. See `ENGINEERING_HANDOFF.md` for the full test plan.
