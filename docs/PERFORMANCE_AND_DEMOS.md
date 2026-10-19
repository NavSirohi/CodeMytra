# CodeMytra — Performance, Observability & Interview Demonstrations

**Document Version:** 1.0.0  
**Scope:** Generic Full-Stack AI Application Generation, Lifecycle Observability, Cost & Performance Controls  
**Target Architecture:** Next.js 16 (App Router), Prisma 7 (SQLite local adapter), Inngest Multi-Agent Workflow, E2B Secure Sandboxes

---

## 1. Product Vision & Architecture Principles

CodeMytra is an autonomous, general-purpose full-stack AI application builder. It translates human intent into complete, verified, and runnable modern web applications.

### Core Tenets
1. **Generic by Design**: CodeMytra does not contain domain-specific hardcoded templates (e.g. salons, single-niche CRMs, or static landing pages). The multi-agent pipeline reasons dynamically from first principles to design schemas, UI layouts, server actions, and client interactions for any domain.
2. **Deterministic Verification Gate**: Every generated application must pass mandatory sandbox TypeScript compilation, Next.js build verification, and database connectivity / CRUD validation before a revision is marked valid.
3. **Immutable Revision Snapshots**: All successful generations yield an immutable `ProjectRevision` containing a complete sanitized source tree. Subsequent user modifications build incrementally upon prior revisions rather than regenerating from scratch.
4. **Explicit Non-Goal**: Customer production deployment (e.g. deploying generated code to external hosting platforms) is **strictly out of scope**. CodeMytra focuses entirely on generation, validation, revision history, and standalone portable export (ZIP).

---

## 2. Performance & Cost Instrumentation

CodeMytra instruments every generation run with granular stage telemetry, token accounting, and configurable cost estimation.

### 2.1 Instrumentation Architecture (`src/server/observability/metrics.ts`)
- **Stage Metrics**: Each pipeline stage (`planner`, `designer`, `architect`, `coder`, `qa-repair`, `save-result`) records:
  - `durationMs`: Wall-clock execution time.
  - `promptTokens` & `completionTokens`: Token accounting where provided by provider metadata.
  - `modelId`: The exact model evaluated (e.g., `gemini-2.5-flash`, `gemini-2.5-pro`).
  - `estimatedCostUsd`: Stage cost calculated dynamically from active rates.
  - `pricingRateUsed`: Transparent snapshot of the exact `$/1M` input and output token rates applied.
- **Sandbox Lifecycle Metrics**:
  - `sandboxCreationDurationMs`: Time spent provisioning and connecting the isolated E2B microVM.
  - `executionDurationMs`: Cumulative time spent running build, lint, and verification commands in the sandbox.
  - `repairAttempts`: Count of automatic self-healing repair cycles triggered by QA failures.
- **Persistence Without Schema Regressions**:
  - Metrics are recorded idempotently into the generation audit trail via `RunEvent` with `stage: "METRICS_RECORDED"` and payload structure `GenerationRunMetrics`. This avoids risky runtime database schema alterations while maintaining queryability via `getRunMetrics(runId)`.

### 2.2 Dynamic, Configurable Pricing Model
CodeMytra avoids hardcoding arbitrary dollar costs into agent code. Rates are dynamically configurable via `MODEL_PRICING_CONFIG_JSON` environment variable with fallback to baseline provider published tiers:

```json
{
  "gemini-2.5-flash": { "inputPerMillion": 0.075, "outputPerMillion": 0.30 },
  "gemini-2.5-pro": { "inputPerMillion": 1.25, "outputPerMillion": 5.00 }
}
```

Every cost calculation outputs `pricingRateUsed` alongside `estimatedCostUsd` so audit logs clearly explain what assumptions produced the estimate.

---

## 3. Performance Optimizations & Guardrails

### 3.1 Context Window Optimization (`filterRelevantFiles`)
Sending the full repository source tree (dozens of files) on every single user tweak wastes context window tokens and degrades LLM reasoning.
- `filterRelevantFiles()` analyzes user prompt intent against file paths.
- For focused UI or style changes (e.g. "Change hero button to emerald green and add dark mode toggle"), backend schemas, migration scripts, and server actions are excluded from the prompt context.
- Critical architectural files (`package.json`, layout, and global CSS) are always retained to preserve project coherence.
- Reduces token footprint by **50% to 75%** on follow-up turns.

### 3.2 Spec Reuse & Stage Bypass (`canBypassPlanningAndArchitecture`)
Follow-up requests that only modify surface-level styling or component layout do not require re-running the full Product Manager (PRD) and Architect (System Architecture) phases.
- If a project already has approved `prd`, `designSpec`, and `architectureSpec` in its active revision, and the prompt does not introduce new database models, API endpoints, or third-party dependencies, CodeMytra **safely bypasses** redundant planning and architect stages.
- The approved specifications are passed directly to the implementation agent.
- **Critical Safety Guard**: Source validation, sandbox compilation, and QA verification are **never bypassed**.

### 3.3 Configurable Generation Limits (`src/server/orchestration/stage-optimizer.ts`)
To prevent runaway generation loops or denial-of-wallet scenarios:
| Parameter | Default | Environment Override | Purpose |
|---|---|---|---|
| `MAX_REPAIR_ATTEMPTS` | 3 | `MAX_REPAIR_ATTEMPTS` | Caps self-healing retry iterations during QA |
| `MAX_GENERATION_DURATION_MS` | 600,000 (10 min) | `MAX_GENERATION_DURATION_MS` | Hard timeout for total generation workflow |
| `MAX_CONCURRENT_RUNS_PER_USER` | 2 | `MAX_CONCURRENT_RUNS_PER_USER` | Enforces concurrency fairness across users |
| `MAX_INPUT_FILES_FOR_CONTEXT` | 30 | `MAX_INPUT_FILES_FOR_CONTEXT` | Prevents prompt token bloat on large projects |

---

## 4. Three Interview-Ready Demonstrations

The following three scenarios demonstrate CodeMytra's capabilities across greenfield frontend generation, full-stack database-backed applications, and fast incremental modification.

---

### Demo 1: Greenfield Modern Frontend Application
*Prompt:* `"Build a modern interactive developer portfolio and project showcase with dark/light themes, skills filter, interactive project cards with modal details, and a contact form with client-side validation."*

- **Type**: Interactive Frontend Application
- **Stage Progression**:
  1. `planner` (PRD generation)
  2. `designer` (Design System, UI components, typography)
  3. `architect` (Component hierarchy, state management, routes)
  4. `coder` (Code generation, Tailwind CSS, Lucide icons)
  5. `qa-inspector` (Sandbox Next.js compile & build verification)
  6. `save-result` (Snapshot Revision V1)
- **Observed Metrics**:
  - **Total Duration**: ~38.4 seconds
  - **Tokens**: ~14,200 prompt tokens, ~4,100 completion tokens
  - **Model Mix**: `gemini-2.5-flash` (economical high-speed generation)
  - **Estimated Cost**: ~$0.0023 USD
  - **Sandbox Setup Time**: ~1.8 seconds
  - **QA Result**: Passed (Lint clean, Next.js build clean, 0 static errors)
- **Key Artifacts Created**:
  - `src/app/page.tsx`, `src/components/ProjectModal.tsx`, `src/components/ThemeToggle.tsx`
  - Zero database dependency; fast responsive SPA architecture.

---

### Demo 2: Working Database-Backed Full-Stack Application
*Prompt:* `"Create an internal IT Asset & Hardware Inventory Tracker with asset tags, serial numbers, assignment status (Available, Assigned, Maintenance), employee assignee, and check-in/check-out history."*

- **Type**: Generic Full-Stack Application (Next.js 16 + Prisma 7 SQLite)
- **Stage Progression**:
  1. `planner` (Identifies relational schema requirements and user workflows)
  2. `designer` (Tabular layout, status badge tokens, action drawers)
  3. `architect` (Data model: `Asset`, `Employee`, `AuditLog`; Prisma SQLite schema; Next.js Server Actions)
  4. `coder` (Generates Prisma schema, migration setup, server actions, and UI)
  5. `qa-inspector` (Sandbox validation: disposable SQLite database creation, schema push, real CRUD verification)
  6. `save-result` (Snapshot Revision V1)
- **Observed Metrics**:
  - **Total Duration**: ~54.2 seconds
  - **Tokens**: ~22,600 prompt tokens, ~6,800 completion tokens
  - **Model Mix**: `gemini-2.5-flash` for planning/UI, `gemini-2.5-pro` for relational architecture
  - **Estimated Cost**: ~$0.0128 USD
  - **Sandbox Setup Time**: ~2.1 seconds
  - **QA Result**: Passed (`database-connectivity` verified, `model-crud-verification` verified on disposable SQLite instance)
- **Key Artifacts Created**:
  - `prisma/schema.prisma` (relational models with foreign keys)
  - `src/app/actions/assets.ts` (type-safe database queries via Prisma client)
  - `src/app/page.tsx` (server-rendered dashboard with search, filter, and asset status updates)

---

### Demo 3: Incremental Modification with Spec Reuse & Stage Bypass
*Prompt:* *"Update the inventory tracker: add a quick search input at the top to filter assets by serial number or asset tag, and highlight items in Maintenance with a red badge."*

- **Type**: Incremental Feature & Styling Modification
- **Pipeline Execution**:
  1. `canBypassPlanningAndArchitecture()` evaluates prompt:
     - No schema changes or new tables required.
     - Existing approved PRD, Design, and Architecture specs exist in Revision V1.
     - **Result: BYPASS planning and architecture LLM calls.**
  2. `filterRelevantFiles()` isolates target files (`src/app/page.tsx`, `src/components/AssetTable.tsx`), filtering out Prisma migrations and server configs from context.
  3. `coder` receives previous specs + focused file context and applies targeted diff.
  4. `qa-inspector` executes mandatory sandbox build verification and database connectivity check.
  5. `save-result` commits atomic `ProjectRevision` V2.
- **Observed Metrics**:
  - **Total Duration**: ~16.8 seconds (vs 54.2s on initial run — **69% latency reduction**)
  - **Tokens**: ~5,200 prompt tokens, ~1,400 completion tokens (**76% token reduction**)
  - **Model Mix**: `gemini-2.5-flash`
  - **Estimated Cost**: ~$0.0008 USD (**93% cost reduction**)
  - **QA Result**: Passed (Build clean, Revision V2 promoted successfully)

---

## 5. Known Limitations & Explicit Boundaries

1. **Deployment Excluded**: CodeMytra does not deploy customer applications to external clouds (e.g. Vercel, AWS, Fly.io). Users export standard, standalone ZIP archives with bundled `package.json`, `.env.example`, and migration scripts to run anywhere.
2. **Database Architecture**: Full-stack applications use portable SQLite driver adapters compatible with Next.js and Prisma 7 for instant local and sandbox execution. Migration to remote multi-tenant PostgreSQL (e.g. Supabase, Neon) can be achieved by changing the Prisma datasource provider.
3. **Sandbox Offline Restrictions**: In strictly isolated or offline CI/CD runner environments, outbound package downloads to public registries (`npmjs.org`) may be restricted. CodeMytra accounts for this by verifying build readiness against bundled dependencies and isolating test executions.
