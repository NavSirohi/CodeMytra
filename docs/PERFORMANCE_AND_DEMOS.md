# CodeMytra — Performance, Observability & Interview Demonstrations

**Document Version:** 1.2.0  
**Scope:** Generic Full-Stack AI Application Generation, Lifecycle Observability, Cost & Performance Controls  
**Target Architecture:** Next.js 16 (App Router), Neon PostgreSQL (Prisma 7 with @prisma/adapter-pg), Inngest Multi-Agent Workflow, E2B Secure Sandboxes

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
- **Stage Metrics**: Each pipeline stage (`planning`, `design`, `architecture`, `sandbox-init`, `coding`, `qa-and-repair`, `save-result`) records:
  - `durationMs`: Wall-clock execution time.
  - `promptTokens` & `completionTokens`: Token accounting extracted from real provider metadata when available.
  - `usageMeasured`: Explicit boolean indicating whether provider tokens were supplied (missing usage is never reported as measured zero).
  - `modelId`: The exact model evaluated (e.g., `gemini-2.5-flash`, `gemini-2.5-pro`), never substituted with an arbitrary default when unknown.
  - `estimatedCostUsd`: Stage cost calculated dynamically from active rates when usage is measured.
  - `pricingAssumptions`: Transparent snapshot of the exact `$/1M` input and output token rates applied.
- **Sandbox Lifecycle Metrics**:
  - `creationDurationMs`: Time spent provisioning and connecting the isolated E2B microVM.
  - `executionDurationMs`: Cumulative time spent running build, lint, and verification commands in the sandbox.
  - `repairAttempts`: Count of automatic self-healing repair cycles triggered by QA failures.
- **Persistence & Replay Safety**:
  - Each stage metric is upserted into `RunEvent` with `stage: STAGE_METRIC_<stageName>`. When Inngest steps retry, existing stage records are updated rather than duplicated, preventing double-counting.
  - The final run report is aggregated from persisted stage records rather than an in-memory object, guaranteeing that incomplete-run metrics remain fully accessible when a run fails midway.
  - All metrics include an explicit disclaimer: *"Estimated model cost based on configured token rates; not actual provider billing expenditure."*

### 2.2 Dynamic, Configurable Pricing Model
CodeMytra avoids hardcoding arbitrary dollar costs into agent code. Rates are dynamically configurable via `MODEL_PRICING_CONFIG_JSON` environment variable with fallback to baseline provider published tiers:

```json
{
  "gemini-2.5-flash": { "inputPerMillionUsd": 0.075, "outputPerMillionUsd": 0.30 },
  "gemini-2.5-pro": { "inputPerMillionUsd": 1.25, "outputPerMillionUsd": 5.00 }
}
```

Every cost calculation outputs `pricingAssumptions` alongside `estimatedCostUsd` so audit logs clearly explain what assumptions produced the estimate.

---

## 3. Performance Optimizations & Guardrails

### 3.1 Context Window Optimization (`filterRelevantFiles`)
Sending the full repository source tree (dozens of files) on every single user tweak wastes context window tokens and degrades LLM reasoning.
- `filterRelevantFiles()` analyzes user prompt intent against file paths.
- For focused UI or style changes (e.g. "Change hero button to emerald green and add dark mode toggle"), backend schemas, migration scripts, and server actions are excluded from the initial prompt context.
- **Dependency Resolution**: Automatically extracts local import statements (`./`, `../`, `@/`) and includes referenced shared types, utility functions, and component dependencies while staying strictly within the configured context budget.
- **Live Sandbox Workspace Access**: The complete project filesystem remains fully restored in E2B (`/home/user/workspace`). If the coding agent needs to inspect any file not in the initial context, it can use the `readFiles` tool at any time.

### 3.2 Conservative Fast Path (`canBypassPlanningAndArchitecture`)
Follow-up requests that only modify surface-level styling or component layout do not require re-running the full Product Manager (PRD) and Architect (System Architecture) phases.
- **Strictly Cosmetic Eligibility**: Only unambiguous cosmetic modifications (color, theme, fonts, hero text, padding, spacing) qualify for bypass.
- **Mandatory Rejection of Non-Cosmetic Requests**: Any prompt involving databases, CRUD operations, deletions, customer records, order-processing, business rules, authentication, authorization, permissions, roles, payments, or API endpoints immediately takes the full planning path.
- **Safety Gate**: Source validation, sandbox Next.js build verification, database checks, and revision persistence are **never bypassed**.

| Parameter | Default | Environment Override | Purpose |
|---|---|---|---|
| `MAX_REPAIR_ATTEMPTS` | 2 | `MAX_REPAIR_ATTEMPTS` | Caps self-healing retry iterations during QA |
| `MAX_GENERATION_DURATION_MS` | 300,000 (5 min) | `MAX_GENERATION_DURATION_MS` | Cooperative deadline budget for overall generation workflow |
| `MAX_CONCURRENT_RUNS_PER_USER` | 3 | `MAX_CONCURRENT_RUNS_PER_USER` | Enforces concurrency fairness across users |
| `MAX_INPUT_FILES_FOR_CONTEXT` | 30 | `MAX_INPUT_FILES_FOR_CONTEXT` | Prevents prompt token bloat on large projects |

### 3.4 Cooperative vs Preemptive Timeout Mechanics
- **Out-of-Process Execution**: External AI providers (e.g. Google Gemini REST/SDK inference) and sandbox executions (e.g. Next.js compiler or build commands inside E2B containers) execute out-of-process. Standard cloud runtimes and HTTP clients cannot be preemptively interrupted mid-flight without aborting sockets or killing entire containers.
- **Cooperative Deadlines**: The configured `MAX_GENERATION_DURATION_MS` (default 300,000 ms / 5 minutes) acts as a **cooperative deadline budget**, not a preemptive OS-level thread-kill or guaranteed hard wall-clock interruption.
- **Enforcement Architecture**:
  1. **Persisted Anchor**: Run start time (`startedAt`) is persisted in PostgreSQL so Inngest workflow retries derive an unchanged deadline rather than resetting the budget.
  2. **Stage Boundaries**: Before entering each pipeline stage (`planning`, `design`, `architecture`, `coding`, `qa-and-repair`), `checkGenerationDeadline()` verifies that the remaining time is positive and halts generation immediately if expired.
  3. **Operation Bounding**: Subprocess commands inside the sandbox are bounded via `boundOperationTimeout()`, preventing any task from requesting more time than remaining before the deadline, and aborting if below a 5-second minimum execution floor.
  4. **Preservation of Assets**: When a timeout occurs, `finalizeGenerationFailure` transitions the run to `FAILED` with `errorCode: "GENERATION_TIMEOUT"` and strictly preserves prior working project revisions.

### 3.5 Planner & AgentKit SDK Isolation Architecture
- **Inngest Ambient Context Detection**: Inngest functions manage execution context via Node.js `AsyncLocalStorage` stored in `globalThis[Symbol.for("inngest:als")]`. When `@inngest/agent-kit` agents run inside an Inngest function, AgentKit’s internal `getStepTools()` detects this ambient context and automatically delegates inference to `step.ai.infer()`.
- **The Problem**: When specialized single-turn agents (Planner, Designer, Architect) execute inside an outer `step.run()` callback (e.g. `step.run("planner-spec", ...)`), this automatic delegation produces an illegal nested step (`NESTING_STEPS`), duplicate step identifiers, and infinite replay loops.
- **Isolation Solution (`runWithoutStepContext`)**:
  CodeMytra wraps single-turn agent calls with `runWithoutStepContext()`, which temporarily unbinds the Inngest ALS store (`als.run(undefined, fn)`).
- **Internal SDK Compatibility Assumption**:
  1. AgentKit evaluates `await getStepTools()`.
  2. When the ALS store is unbound, `getStepTools()` returns `undefined`.
  3. When `step` is `undefined`, AgentKit takes its native direct provider branch: it executes a direct HTTPS/REST request to the provider model (e.g. Google Gemini API) rather than delegating to `step.ai.infer()`.
  4. The outer Inngest step (`step.run("planner-spec")`) preserves its durable step identity, cleanly memoizes the returned specification into Inngest's execution ledger, and guarantees deterministic replay safety and idempotency.
- **Supported Alternative**:
  If a future minor update of Inngest or AgentKit alters this ambient ALS symbol lookup, CodeMytra supports replacing `@inngest/agent-kit` single-turn calls with direct Google Gemini SDK invocations (`getGeminiModel().generateContent()` or native HTTPS `fetch()`). Direct provider invocation operates completely outside Inngest's internal `AsyncLocalStorage` symbol, providing an architectural alternative with zero ambient context dependencies.

---

## 4. Three Interview-Ready Demonstrations

> **Note on Demonstrations**: The three scenarios described below (Portfolio, IT Inventory, and Incremental Feature Addition) are illustrative examples demonstrating how CodeMytra's multi-agent engine dynamically decomposes and solves problems. They are **not** hardcoded application templates or pre-baked categories. CodeMytra contains zero domain-specific template branches.
> 
> *All duration, token, and cost metrics below are illustrative benchmark numbers based on sample test runs; actual durations, token counts, and costs vary based on network latency, runtime load, and user requirements. Estimated costs reflect indicative model rates, not billing expenditure.*

---

### Demo 1: Greenfield Modern Frontend Application
*Prompt:* `"Build a modern interactive developer portfolio and project showcase with dark/light themes, skills filter, interactive project cards with modal details, and a contact form with client-side validation."*

- **Type**: Interactive Frontend Application
- **Stage Progression**:
  1. `planning` (PRD generation)
  2. `design` (Design System, UI components, typography)
  3. `architecture` (Component hierarchy, state management, routes)
  4. `sandbox-init` (E2B sandbox provisioning & workspace setup)
  5. `coding` (Code generation, Tailwind CSS, Lucide icons)
  6. `qa-and-repair` (Sandbox Next.js compile & build verification)
  7. `save-result` (Snapshot Revision V1)
- **Illustrative Benchmark Metrics**:
  - **Total Duration**: ~38.4 seconds (illustrative)
  - **Tokens**: ~14,200 prompt tokens, ~4,100 completion tokens (illustrative)
  - **Model Mix**: `gemini-2.5-flash` (economical high-speed generation)
  - **Estimated Cost**: ~$0.0023 USD (indicative estimate)
  - **Sandbox Setup Time**: ~1.8 seconds (illustrative)
  - **QA Result**: Passed (Lint clean, Next.js build clean, 0 static errors)
- **Key Artifacts Created**:
  - `src/app/page.tsx`, `src/components/ProjectModal.tsx`, `src/components/ThemeToggle.tsx`
  - Zero database dependency; fast responsive SPA architecture.

---

### Demo 2: Working Database-Backed Full-Stack Application
*Prompt:* `"Create an internal IT Asset & Hardware Inventory Tracker with asset tags, serial numbers, assignment status (Available, Assigned, Maintenance), employee assignee, and check-in/check-out history."*

- **Type**: Generic Full-Stack Application (Next.js 16 + Generated Relational Database in Sandbox)
- **Stage Progression**:
  1. `planning` (Identifies relational schema requirements and user workflows)
  2. `design` (Tabular layout, status badge tokens, action drawers)
  3. `architecture` (Data model: `Asset`, `Employee`, `AuditLog`; relational schema; Next.js Server Actions)
  4. `sandbox-init` (E2B sandbox provisioning & workspace setup)
  5. `coding` (Generates Prisma schema, migration setup, server actions, and UI)
  6. `qa-and-repair` (Sandbox validation: disposable sandbox database creation, schema push, real CRUD verification)
  7. `save-result` (Snapshot Revision V1 persisted to CodeMytra Neon PostgreSQL)
- **Illustrative Benchmark Metrics**:
  - **Total Duration**: ~54.2 seconds (illustrative)
  - **Tokens**: ~22,600 prompt tokens, ~6,800 completion tokens (illustrative)
  - **Model Mix**: `gemini-2.5-flash` for planning/UI, `gemini-2.5-pro` for relational architecture
  - **Estimated Cost**: ~$0.0128 USD (indicative estimate)
  - **Sandbox Setup Time**: ~2.1 seconds (illustrative)
  - **QA Result**: Passed (`database-connectivity` verified, `model-crud-verification` verified on disposable sandbox instance)
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
  4. `qa-and-repair` executes mandatory sandbox build verification and database connectivity check.
  5. `save-result` commits atomic `ProjectRevision` V2 to Neon PostgreSQL.
- **Illustrative Benchmark Metrics**:
  - **Total Duration**: ~16.8 seconds (illustrative, ~69% latency reduction vs greenfield)
  - **Tokens**: ~5,200 prompt tokens, ~1,400 completion tokens (illustrative, ~76% token reduction)
  - **Model Mix**: `gemini-2.5-flash`
  - **Estimated Cost**: ~$0.0008 USD (indicative estimate, ~93% cost reduction)
  - **QA Result**: Passed (Build clean, Revision V2 promoted successfully)

---

## 5. Known Limitations & Explicit Boundaries

1. **Deployment Excluded**: CodeMytra does not deploy customer applications to external clouds (e.g. Vercel, AWS, Fly.io). Users export standard, standalone ZIP archives with bundled `package.json`, `.env.example`, and migration scripts to run anywhere.
2. **Database Architecture & Persistence Separation**:
   - **CodeMytra Platform Persistence**: The core CodeMytra platform is strictly configured with **Neon PostgreSQL** as its primary persistence backend, driven by Prisma 7 and the `@prisma/adapter-pg` driver adapter. PostgreSQL concurrency controls—including `FOR UPDATE SKIP LOCKED`, atomic row-level locks, transactional outbox leases with fencing tokens, and atomic Compare-And-Swap (CAS) revision promotions—govern all platform operations.
   - **Isolated Test Adapters**: Dedicated automated unit tests execute with mock engines or isolated adapters (e.g. `@prisma/adapter-better-sqlite3`) to enable rapid offline test verification without requiring a live remote PostgreSQL network connection.
   - **Generated Applications**: Generated full-stack customer projects inside E2B sandboxes default to lightweight portable databases (e.g. SQLite via driver adapter) for instant containerized execution and standalone ZIP export, but can be switched to remote PostgreSQL by updating their generated Prisma configuration.
3. **Sandbox Offline Restrictions**: In strictly isolated or offline CI/CD runner environments, outbound package downloads to public registries (`npmjs.org`) may be restricted. CodeMytra accounts for this by verifying build readiness against bundled dependencies and isolating test executions.
4. **Scope of Application Support & External Integrations**: While CodeMytra supports generic multi-tier full-stack architectures, it does not guarantee that every conceivable third-party integration (e.g. proprietary payment gateways without test credentials, external enterprise OAuth providers requiring manual app registrations, physical hardware drivers, or specialized proprietary cloud APIs) can be automatically completed without external API credentials or specialized environments.
