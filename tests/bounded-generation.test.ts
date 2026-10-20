import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import {
  GENERATION_LIMITS,
  RunAbortedError,
  TokenBudgetExceededError,
  NoProgressError,
  IterationLimitExceededError,
} from "../src/server/orchestration/stage-optimizer";
import {
  finalizeGenerationFailure,
  isRunActiveInDb,
} from "../src/server/orchestration/finalization";
import { buildContextEnhancedPrompt } from "../src/server/agents/coder";
import { codeAgentFunction } from "../src/features/inngest/functions";
import { GenerationRunStatus } from "../src/generated/prisma/client";
import { PRD, DesignSpec, ArchitectureSpec } from "../src/server/agent-contracts/schemas";

describe("P0: Bounded Generation, Fast-Path Delivery & Watchdog Reconciliation", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Generation Bounds & Limits Configuration
  // ───────────────────────────────────────────────────────────────────────────
  describe("Generation Limits Configuration", () => {
    it("enforces conservative upper bounds on coding iterations and token budget", () => {
      assert.ok(GENERATION_LIMITS.maxCodingIterations !== undefined);
      assert.ok(GENERATION_LIMITS.maxCodingIterations <= 4);
      assert.ok(GENERATION_LIMITS.maxRepairIterations !== undefined);
      assert.ok(GENERATION_LIMITS.maxRepairIterations <= 2);
      assert.ok(GENERATION_LIMITS.maxRunTokenBudget !== undefined);
      assert.ok(GENERATION_LIMITS.maxRunTokenBudget <= 200000);
    });

    it("instantiates custom error classes with structured error metadata", () => {
      const abortErr = new RunAbortedError("Run cancelled by watchdog", "FAILED");
      assert.equal(abortErr.name, "RunAbortedError");
      assert.equal(abortErr.status, "FAILED");

      const tokenErr = new TokenBudgetExceededError("Budget exceeded", 160000, 150000);
      assert.equal(tokenErr.name, "TokenBudgetExceededError");
      assert.equal(tokenErr.tokensUsed, 160000);
      assert.equal(tokenErr.tokenBudget, 150000);

      const progressErr = new NoProgressError("No file writes in 2 turns", 2);
      assert.equal(progressErr.name, "NoProgressError");
      assert.equal(progressErr.consecutiveTurns, 2);

      const iterErr = new IterationLimitExceededError("Limit reached", 4, 4);
      assert.equal(iterErr.name, "IterationLimitExceededError");
      assert.equal(iterErr.iterations, 4);
      assert.equal(iterErr.maxIterations, 4);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Mid-Flight Database Status Checks (isRunActiveInDb)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Mid-Flight Active Status Checks (isRunActiveInDb)", () => {
    it("reports active for RUNNING and VALIDATING runs", async () => {
      const originalFindUnique = prisma.generationRun.findUnique;
      try {
        prisma.generationRun.findUnique = (async (args: any) => {
          if (args.where.id === "run-running") {
            return { status: GenerationRunStatus.RUNNING };
          }
          if (args.where.id === "run-validating") {
            return { status: GenerationRunStatus.VALIDATING };
          }
          return null;
        }) as any;

        assert.equal(await isRunActiveInDb("run-running"), true);
        assert.equal(await isRunActiveInDb("run-validating"), true);
      } finally {
        prisma.generationRun.findUnique = originalFindUnique;
      }
    });

    it("reports inactive for terminal runs (FAILED, COMPLETED, CANCELLED) or missing records", async () => {
      const originalFindUnique = prisma.generationRun.findUnique;
      try {
        prisma.generationRun.findUnique = (async (args: any) => {
          if (args.where.id === "run-failed") {
            return { status: GenerationRunStatus.FAILED };
          }
          if (args.where.id === "run-completed") {
            return { status: GenerationRunStatus.COMPLETED };
          }
          if (args.where.id === "run-cancelled") {
            return { status: GenerationRunStatus.CANCELLED };
          }
          return null;
        }) as any;

        assert.equal(await isRunActiveInDb("run-failed"), false);
        assert.equal(await isRunActiveInDb("run-completed"), false);
        assert.equal(await isRunActiveInDb("run-cancelled"), false);
        assert.equal(await isRunActiveInDb("run-nonexistent"), false);
      } finally {
        prisma.generationRun.findUnique = originalFindUnique;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Truthful Failure Messaging (Zero vs Existing Revisions)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Truthful Failure Finalization Messaging", () => {
    it("accurately reports 'No prior revisions exist' when project has 0 revisions", async () => {
      const originalTx = prisma.$transaction;
      let createdMessageContent = "";
      let createdEventMessage = "";

      try {
        prisma.$transaction = (async (fn: any) => {
          const mockTx = {
            generationRun: {
              findUnique: async () => ({
                id: "run-first-attempt",
                projectId: "proj-fresh",
                status: GenerationRunStatus.RUNNING,
              }),
              update: async () => ({}),
            },
            project: {
              findUnique: async () => ({
                currentRevisionId: null,
              }),
            },
            projectRevision: {
              count: async () => 0, // Fresh project with no revisions!
            },
            runEvent: {
              create: async (args: any) => {
                createdEventMessage = args.data.message;
                return {};
              },
            },
            message: {
              findUnique: async () => null,
              create: async (args: any) => {
                createdMessageContent = args.data.content;
                return { id: "msg-fresh-fail" };
              },
            },
          };
          return fn(mockTx);
        }) as any;

        const result = await finalizeGenerationFailure({
          projectId: "proj-fresh",
          generationRunId: "run-first-attempt",
          errorCode: "GENERATION_TIMEOUT",
          errorMessage: "Generation timed out during coding stage.",
        });

        assert.equal(result.isIdempotentReplay, false);
        assert.ok(createdMessageContent.includes("Generation timed out:"));
        assert.ok(createdMessageContent.includes("No prior revisions exist for this project yet."));
        assert.ok(!createdMessageContent.includes("Your prior working revision is preserved."));
        assert.ok(createdEventMessage.includes("No prior working revision exists."));
      } finally {
        prisma.$transaction = originalTx;
      }
    });

    it("accurately reports 'Your prior working revision is preserved' when project has existing revisions", async () => {
      const originalTx = prisma.$transaction;
      let createdMessageContent = "";
      let createdEventMessage = "";

      try {
        prisma.$transaction = (async (fn: any) => {
          const mockTx = {
            generationRun: {
              findUnique: async () => ({
                id: "run-second-attempt",
                projectId: "proj-with-revs",
                status: GenerationRunStatus.RUNNING,
              }),
              update: async () => ({}),
            },
            project: {
              findUnique: async () => ({
                currentRevisionId: "rev-v1",
              }),
            },
            projectRevision: {
              count: async () => 1, // Has 1 prior revision!
            },
            runEvent: {
              create: async (args: any) => {
                createdEventMessage = args.data.message;
                return {};
              },
            },
            message: {
              findUnique: async () => null,
              create: async (args: any) => {
                createdMessageContent = args.data.content;
                return { id: "msg-existing-fail" };
              },
            },
          };
          return fn(mockTx);
        }) as any;

        const result = await finalizeGenerationFailure({
          projectId: "proj-with-revs",
          generationRunId: "run-second-attempt",
          errorCode: "NO_PROGRESS_LIMIT",
          errorMessage: "Coding agent concluded without new file updates.",
        });

        assert.equal(result.isIdempotentReplay, false);
        assert.ok(createdMessageContent.includes("Generation stopped:"));
        assert.ok(createdMessageContent.includes("Your prior working revision is preserved."));
        assert.ok(!createdMessageContent.includes("No prior revisions exist"));
        assert.ok(createdEventMessage.includes("Prior working revision preserved."));
      } finally {
        prisma.$transaction = originalTx;
      }
    });

    it("formats specific failure prefixes according to error code", async () => {
      const originalTx = prisma.$transaction;
      const testedMessages: Record<string, string> = {};

      try {
        prisma.$transaction = (async (fn: any) => {
          const mockTx = {
            generationRun: {
              findUnique: async (args: any) => ({
                id: args.where.id,
                projectId: "p1",
                status: GenerationRunStatus.RUNNING,
              }),
              update: async () => ({}),
            },
            project: {
              findUnique: async () => ({ currentRevisionId: null }),
            },
            projectRevision: { count: async () => 0 },
            runEvent: { create: async () => ({}) },
            message: {
              findUnique: async () => null,
              create: async (args: any) => {
                testedMessages[args.data.generationRunId] = args.data.content;
                return { id: "msg-id" };
              },
            },
          };
          return fn(mockTx);
        }) as any;

        await finalizeGenerationFailure({
          projectId: "p1",
          generationRunId: "test-timeout",
          errorCode: "GENERATION_TIMEOUT",
          errorMessage: "Took too long",
        });
        assert.ok(testedMessages["test-timeout"].startsWith("Generation timed out:"));

        await finalizeGenerationFailure({
          projectId: "p1",
          generationRunId: "test-qa",
          errorCode: "QA_VERIFICATION_FAILED",
          errorMessage: "Build broken",
        });
        assert.ok(testedMessages["test-qa"].startsWith("Quality Assurance failed:"));

        await finalizeGenerationFailure({
          projectId: "p1",
          generationRunId: "test-budget",
          errorCode: "TOKEN_BUDGET_EXCEEDED",
          errorMessage: "Token limit reached",
        });
        assert.ok(testedMessages["test-budget"].startsWith("Generation stopped:"));

        await finalizeGenerationFailure({
          projectId: "p1",
          generationRunId: "test-abort",
          errorCode: "RUN_ABORTED",
          errorMessage: "Killed by watchdog",
        });
        assert.ok(testedMessages["test-abort"].startsWith("Generation failed:"));
      } finally {
        prisma.$transaction = originalTx;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Fast-Path Direct Batch Delivery Prompt Directives
  // ───────────────────────────────────────────────────────────────────────────
  describe("Coder Fast-Path Batch Delivery Directives", () => {
    it("injects mandatory direct batch delivery instructions into coder system prompt", () => {
      const mockPrd: PRD = {
        projectName: "Sweet Treats Bakery",
        summary: "Landing page for local artisan bakery",
        targetAudience: "Local bakery customers",
        capabilities: ["pages-navigation"],
        unsupportedRequirements: [],
        coreFeatures: [
          { name: "Menu section", description: "Display artisan breads", priority: "MUST" },
        ],
        pages: [
          { route: "/", title: "Home", purpose: "Main bakery landing page", keyComponents: ["Hero", "Menu"] },
        ],
        dataEntities: [],
        userFlows: [
          { name: "Browse menu", steps: ["Visit homepage", "Scroll to menu"] },
        ],
      };

      const mockDesign: DesignSpec = {
        aestheticTheme: "Warm artisan pastry colors",
        colorPalette: {
          primary: "#d97706",
          secondary: "#78350f",
          accent: "#f59e0b",
          background: "#fffbeb",
          surface: "#ffffff",
          text: "#1c1917",
        },
        typography: {
          headingFont: "Geist",
          bodyFont: "Geist Sans",
        },
        layoutStyle: "Clean, responsive grid",
        componentGuidelines: [],
      };

      const mockArch: ArchitectureSpec = {
        appType: "nextjs-fullstack",
        capabilities: ["pages-navigation"],
        requiresDatabase: false,
        routeEndpoints: [
          { path: "/", type: "page", purpose: "Bakery homepage" },
        ],
        uiComponents: [],
        databaseModels: [],
        backendOperations: [],
        businessConstraints: [],
        authRequirements: { enabled: false, strategy: "none" },
        externalIntegrations: [],
        userJourneys: [],
        fileOwnership: {
          frontend: ["app/page.tsx", "components/**"],
          backend: [],
          database: [],
        },
        dependencies: ["lucide-react"],
      };

      const prompt = buildContextEnhancedPrompt(mockPrd, mockDesign, mockArch);

      assert.ok(prompt.includes("CRITICAL EXECUTION DIRECTIVES: DIRECT, FAST DELIVERY"));
      assert.ok(prompt.includes("IMMEDIATE BATCH WRITE"));
      assert.ok(prompt.includes("createOrUpdateFiles"));
      assert.ok(prompt.includes("NO EXPLORATORY ACTIONS"));
      assert.ok(prompt.includes("NO MANUAL BUILD/TEST LOOPS"));
      assert.ok(prompt.includes("IMMEDIATE COMPLETION"));
      assert.ok(prompt.includes("<task_summary>"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Inngest onFailure Hook Reconciliation for Bounded Generation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Inngest onFailure Hook Bounded Handling", () => {
    it("classifies bounded generation errors into corresponding error codes", async () => {
      const originalTx = prisma.$transaction;
      const originalFindUnique = prisma.generationRun.findUnique;
      let finalizedErrorCode: string | null = null;

      try {
        prisma.generationRun.findUnique = (async () => ({
          status: GenerationRunStatus.RUNNING,
        })) as any;

        prisma.$transaction = (async (fn: any) => {
          const mockTx = {
            generationRun: {
              findUnique: async () => ({
                id: "run-bound-1",
                projectId: "proj-1",
                status: GenerationRunStatus.RUNNING,
              }),
              update: async (args: any) => {
                finalizedErrorCode = args.data.errorCode;
                return {};
              },
            },
            project: { findUnique: async () => ({ currentRevisionId: null }) },
            projectRevision: { count: async () => 0 },
            runEvent: { create: async () => ({}) },
            message: { findUnique: async () => null, create: async () => ({ id: "msg-1" }) },
          };
          return fn(mockTx);
        }) as any;

        const onFailure = (codeAgentFunction as any).opts.onFailure;
        assert.ok(typeof onFailure === "function", "onFailure handler must be defined");

        // Test TokenBudgetExceededError
        await onFailure({
          event: { data: { event: { data: { runId: "run-bound-1", projectId: "proj-1" } } } },
          error: new TokenBudgetExceededError("Over token limit", 160000, 150000),
        });
        assert.equal(finalizedErrorCode, "TOKEN_BUDGET_EXCEEDED");

        // Test NoProgressError
        await onFailure({
          event: { data: { event: { data: { runId: "run-bound-1", projectId: "proj-1" } } } },
          error: new NoProgressError("Concluded without file writes", 2),
        });
        assert.equal(finalizedErrorCode, "NO_PROGRESS_LIMIT");

        // Test IterationLimitExceededError
        await onFailure({
          event: { data: { event: { data: { runId: "run-bound-1", projectId: "proj-1" } } } },
          error: new IterationLimitExceededError("Hit max iterations", 4, 4),
        });
        assert.equal(finalizedErrorCode, "ITERATION_LIMIT_EXCEEDED");
      } finally {
        prisma.$transaction = originalTx;
        prisma.generationRun.findUnique = originalFindUnique;
      }
    });

    it("skips duplicate failure finalization if run is already terminal in DB when RunAbortedError is caught", async () => {
      const originalFindUnique = prisma.generationRun.findUnique;
      let transactionCalled = false;
      const originalTx = prisma.$transaction;

      try {
        // Run has ALREADY been marked FAILED in DB (e.g., background watchdog reconciled it)
        prisma.generationRun.findUnique = (async () => ({
          status: GenerationRunStatus.FAILED,
        })) as any;

        prisma.$transaction = (async () => {
          transactionCalled = true;
          return {};
        }) as any;

        const onFailure = (codeAgentFunction as any).opts.onFailure;
        assert.ok(typeof onFailure === "function", "onFailure handler must be defined");

        await onFailure({
          event: { data: { event: { data: { runId: "run-already-failed", projectId: "proj-1" } } } },
          error: new RunAbortedError("Run aborted because database status reached terminal state"),
        });

        // Must NOT attempt to re-finalize or create duplicate error messages!
        assert.equal(transactionCalled, false);
      } finally {
        prisma.generationRun.findUnique = originalFindUnique;
        prisma.$transaction = originalTx;
      }
    });
  });
});
