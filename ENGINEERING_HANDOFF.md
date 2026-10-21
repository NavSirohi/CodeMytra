# CodeMytra — Engineering Handoff & Technical Specification

**Official Product Name:** CodeMytra  
**Target Domain:** codemytra.com  
**Primary AI Engine:** OpenAI (`gpt-4o`, `gpt-4o-mini`)  
**Baseline Date:** October 2026  
**Status:** In Active Development (Milestones P0-M4 Complete; OpenAI Generation Pipeline Active)

---

## 1. Executive Summary & Working Agreements

CodeMytra is an autonomous, multi-agent AI full-stack application builder. Users describe an application concept; a coordinated hierarchy of specialized AI agents analyzes requirements, creates architectural and design specifications, implements full-stack code, validates the build, and provides an interactive sandbox preview with full code persistence and ZIP export capabilities.

### Non-Negotiable Core Rules
1. **OpenAI Across All Active Agents:** All active intelligence layers, planner stages, design agents, code generators, and QA inspectors leverage official OpenAI models via `@inngest/agent-kit` (`gpt-4o-mini` for high-throughput design and economical planning; `gpt-4o` for complex full-stack architecture, coding, and multi-turn QA repairs). Historical Gemini models and usage metrics are preserved in the pricing catalog for immutable auditability.
2. **Never Rewriting from Scratch:** Existing working flows (Clerk auth, project creation, UI layout, Inngest integration) are preserved and extended via clean interfaces.
3. **Strict Credential Hygiene:** No API keys, database connection strings, or environment secrets are hardcoded or committed to git.
4. **Isolated Data Planes:** Customer-generated applications NEVER share or connect to CodeMytra's internal platform database (`DATABASE_URL`).
5. **Preview-Only in MVP:** Generated applications are executed inside isolated E2B sandboxes for interactive preview. The customer "Deploy" button is visible but intentionally disabled with a "Coming Soon" badge.
6. **Durable Revisions:** Every successful generation run produces an immutable file tree snapshot stored in PostgreSQL, allowing users to restore previous versions and iterate without starting over.

---

## 2. Platform Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Browser (Next.js 16 UI / Tailwind v4)                 │
│  - Requirements Gathering & PRD Approval Modal                              │
│  - Real-time Multi-Agent Progress Stream                                    │
│  - Monaco / Prism Code Viewer & Diff Inspector                              │
│  - Interactive Sandbox Iframe Preview                                       │
│  - Project Version Rollback & ZIP Export                                    │
│  - [Deploy — Coming Soon] (Disabled)                                        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Authenticated Server Actions & API
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CodeMytra Control Plane (Next.js on Vercel)              │
│  - Clerk Authentication & Server-Side Role Enforcement (USER / DEMO)        │
│  - Outbox Pattern & Event Dispatch with Idempotency Keys                    │
│  - Neon PostgreSQL (Prisma 7 with PgBouncer Pooled + Direct Migration URLs)│
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Durable Inngest Events
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Inngest Multi-Agent Orchestration Pipeline                │
│                                                                             │
│  1. Requirements Agent (OpenAI GPT-4o / GPT-4o mini) → Structured PRD       │
│  2. Human-in-the-Loop Gate (Optional PRD review / approval)                │
│  3. Design & Architecture Agents (OpenAI GPT-4o / GPT-4o mini)             │
│     → DesignSpec + ArchitectureSpec + File Ownership Manifest               │
│  4. Implementation Coordinator (Single-writer patch scheduler)              │
│     ├─ Frontend Agent (OpenAI GPT-4o / GPT-4o mini) → UI & Client           │
│     ├─ Backend Agent (OpenAI GPT-4o / GPT-4o mini) → API Handlers & Actions │
│     └─ Database Agent (OpenAI GPT-4o / GPT-4o mini) → Prisma Schema & Seeds │
│  5. Integration Agent → Atomic merge into candidate revision snapshot       │
│  6. QA & Testing Agent (OpenAI GPT-4o / GPT-4o mini)                        │
│     → Sandbox build verification (`tsc`, lint, build, health check)         │
│     └─ If failed: Bounded self-repair loop (max 2 attempts)                 │
│  7. Immutable Revision Snapshot & Sandbox Preview Generation                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      E2B Isolated Execution Sandbox                         │
│  - Per-tenant ephemeral container with Bun / Node runtime                   │
│  - Complete filesystem restoration from latest durable snapshot             │
│  - Safe command execution under policy-enforced path & tool allowlist       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Multi-Agent System Roles, Model Assignments & Auxiliary Routing

Each agent operates with minimal required tools, a bounded context budget, and explicit input/output schemas defined via Zod.

| Role | Primary OpenAI Model | Inputs | Outputs | Allowed Capabilities |
|---|---|---|---|---|
| **Planner / Requirements** | `gpt-4o` (or `gpt-4o-mini`) | User prompt, conversational context | `ProductRequirementsDocument` | Read project history, generate structured PRD |
| **Design Agent** | `gpt-4o-mini` | Approved PRD | `DesignSpec` (tokens, theme, layouts) | Read UI component catalog, emit design tokens |
| **Architecture Agent** | `gpt-4o` | Approved PRD, template configs | `ArchitectureSpec` & File Ownership Map | Read template specs, emit route/model contracts |
| **Frontend / Coder Agent** | `gpt-4o` (or `gpt-4o-mini`) | Specs, component boundaries | Scoped UI patches (`app/**/*.tsx`) | Read/write workspace files, execute tools |
| **Backend / DB Agent** | `gpt-4o` | Data requirements, API specs | Prisma schema updates & route handlers | Scoped backend & database patch generation |
| **Integration Agent** | `gpt-4o-mini` | Patches from all agents | Consolidated candidate revision | Atomic conflict resolution & manifest hashing |
| **QA / Verifier** | `gpt-4o` | Candidate file tree, build diagnostics | `QAReport` (pass/fail, logs, repair plan) | Run sandbox checks (`tsc`, `build`), repair loops |

### 3.1 User Model Selection vs. Auxiliary Routing Contracts
- **Core Pipeline Invariant:** When a customer or caller explicitly selects a model preference (`gpt-4o`, `gpt-4o-mini`, or `auto`), that preference is strictly honored across all generation stages: Requirements Planning, Design Specification, Architecture Modeling, Code Implementation, and QA Self-Repair.
- **CodeMytra Auto Adaptive Routing:** In `auto` mode (default), CodeMytra dynamically selects the optimal model tier per stage (`gpt-4o-mini` for token-heavy design schemas; `gpt-4o` for relational schemas, complex TypeScript logic, and compilation diagnosis).
- **Auxiliary Generation Routing:** Auxiliary post-generation tasks (specifically `generate-response-metadata` in `src/features/inngest/functions.ts` for conversational fragment titles and customer summaries) explicitly use `gpt-4o-mini`. This intentional architectural boundary avoids consuming flagship model quotas or introducing latency for basic 10-word summaries, while strictly maintaining the user's selected model for all application code.

---

## 4. Database Architecture (Neon PostgreSQL)

### 4.1 Connection Configuration
- **Pooled Connection (`DATABASE_URL`):** Used at runtime by the Next.js serverless handlers via PgBouncer for optimal connection pooling.
- **Direct Connection (`DATABASE_URL_DIRECT`):** Used by `prisma migrate` for DDL operations that require direct TCP connections without PgBouncer limitations.

### 4.2 Data Models

#### Existing Baseline Models (Preserved):
- `User`: Managed via Clerk synchronization, contains user profile and identity.
- `Project`: Project metadata, ownership by `User`.
- `Message`: Interaction history (USER / ASSISTANT roles, RESULT / ERROR types).
- `Fragment`: Output files and sandbox preview URL.

#### Additive Models (Milestones P1 & Beyond):
- `GenerationRun`: Tracks execution state (`CREATED`, `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`), idempotency keys, and AI token/cost usage metrics (supporting active OpenAI and historical Gemini).
- `ProjectSpecification`: Stores versioned PRDs, design specifications, and architecture manifests.
- `ProjectRevision`: Immutable snapshots of the complete file tree with parent-child revision tracking for branching and rollback.
- `AgentTask`: Detailed stage logs for individual agent executions (timings, token metrics, errors).
- `RunEvent`: Real-time streaming log of agent transitions for UI consumption.

---

## 5. Security & Isolation Boundaries

1. **Platform Secrets Isolation:** `OPENAI_API_KEY`, `CLERK_SECRET_KEY`, `E2B_API_KEY`, and `DATABASE_URL` are strictly retained within the control plane. They are never injected into or accessible from within the E2B user code sandbox.
2. **Path Traversal Protection:** All filesystem tools (`readWorkspace`, `applyPatch`) enforce canonical path checking within `/home/user` and reject directory traversal (`../`) or symlink exploits.
3. **No Arbitrary Shell Execution:** Code generation sandboxes run under strict allowlisted commands (`bun install`, `bun build`, `tsc --noEmit`).
4. **Redacted Observability:** Raw prompts, generated source code, and API keys are scrubbed before writing to system logs.

---

## 6. Implementation Milestones

- **M0: Secure Baseline (COMPLETED):**
  - Removed all hardcoded API keys and template references.
  - Parameterized provider model configuration.
  - Formatted `.env.example`, `.gitignore`, `next.config.ts`, and core branding.
- **M1: Durable Revisions & State Machine (ACTIVE):**
  - Schema additions for `GenerationRun`, `ProjectRevision`.
  - Filesystem snapshot capture & restoration in E2B on follow-up prompts.
  - Real build verification (`tsc` & `bun build`) replacing nominal `<task_summary>` tag checks.
  - ZIP export functionality for complete project downloads.
- **M2: Coordinated Multi-Agent Orchestration:**
  - Multi-agent Inngest workflow (Planner → Architect/Designer → Coders → QA).
  - UI agent activity timeline with live status indicators.
- **M3: Full-Stack Template with Isolated Database:**
  - Golden path template with isolated SQLite/Postgres for generated applications.
- **M4: Demo Account & Quota Controls:**
  - Restricted reviewer credentials with hard generation limits.
- **M5: Commercial Billing Architecture:**
  - Razorpay-first payment ledger and usage metering.
