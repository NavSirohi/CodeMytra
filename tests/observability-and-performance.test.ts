import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCost,
  extractUsageMetadata,
  recordStageMetric,
  aggregateAndPersistRunMetrics,
  GenerationMetricsCollector,
  COST_DISCLAIMER,
} from "../src/server/observability/metrics";
import {
  filterRelevantFiles,
  canBypassPlanningAndArchitecture,
  selectModelForStage,
  GENERATION_LIMITS,
} from "../src/server/orchestration/stage-optimizer";
import { getGeminiModel } from "../src/server/providers/gemini";
import { PRD, ArchitectureSpec } from "../src/server/agent-contracts/schemas";

describe("Performance, Observability & Cost Corrections (PR 1)", () => {
  describe("Task 1: Replay-Safe Stage Instrumentation & Incomplete Runs", () => {
    it("upserts stage metrics in a replay-safe manner without duplicate records", async () => {
      // Mock dbClient to track create vs update calls
      const events: Array<{ id: string; runId: string; stage: string; message: string; payload: any }> = [];
      let autoId = 1;

      const mockDb: any = {
        runEvent: {
          findFirst: async ({ where }: any) => {
            return events.find((e) => e.runId === where.runId && e.stage === where.stage) || null;
          },
          findMany: async ({ where }: any) => {
            return events.filter((e) => {
              if (where.runId && e.runId !== where.runId) return false;
              if (where.stage?.startsWith && !e.stage.startsWith(where.stage.startsWith)) return false;
              return true;
            });
          },
          create: async ({ data }: any) => {
            const row = { id: `evt-${autoId++}`, ...data };
            events.push(row);
            return row;
          },
          update: async ({ where, data }: any) => {
            const idx = events.findIndex((e) => e.id === where.id);
            if (idx >= 0) {
              events[idx] = { ...events[idx], ...data };
              return events[idx];
            }
            throw new Error("Not found");
          },
        },
      };

      const runId = "test-run-replay-1";
      const projectId = "test-project-1";

      // 1. First execution of "planning" stage
      await recordStageMetric(
        {
          runId,
          projectId,
          stageName: "planning",
          modelId: "gemini-2.5-pro",
          startedAt: 1000,
          finishedAt: 2000,
          promptTokens: 1000,
          completionTokens: 500,
        },
        mockDb
      );

      assert.equal(events.length, 1);
      assert.equal(events[0].stage, "STAGE_METRIC_planning");
      assert.equal(events[0].payload.promptTokens, 1000);

      // 2. Inngest step retries the "planning" stage after transient failure
      await recordStageMetric(
        {
          runId,
          projectId,
          stageName: "planning",
          modelId: "gemini-2.5-pro",
          startedAt: 1000,
          finishedAt: 2500,
          promptTokens: 1100,
          completionTokens: 550,
        },
        mockDb
      );

      // Must NOT create a duplicate record — should update existing stage event
      assert.equal(events.length, 1);
      assert.equal(events[0].payload.promptTokens, 1100);
      assert.equal(events[0].payload.durationMs, 1500);

      // 3. Add other stages
      await recordStageMetric(
        {
          runId,
          projectId,
          stageName: "coding",
          modelId: "gemini-2.5-flash",
          startedAt: 3000,
          finishedAt: 5000,
          promptTokens: 4000,
          completionTokens: 2000,
        },
        mockDb
      );

      assert.equal(events.length, 2);

      // 4. Aggregate from persisted stage records
      const aggregate = await aggregateAndPersistRunMetrics(runId, projectId, "COMPLETED", undefined, mockDb);
      assert.equal(aggregate.finalOutcome, "COMPLETED");
      assert.equal(aggregate.totalPromptTokens, 1100 + 4000);
      assert.equal(aggregate.totalCompletionTokens, 550 + 2000);
      assert.equal(aggregate.modelsUsed.length, 2);
      assert.ok(aggregate.modelsUsed.includes("gemini-2.5-pro"));
      assert.ok(aggregate.modelsUsed.includes("gemini-2.5-flash"));
    });

    it("keeps incomplete-run metrics available when generation fails midway", async () => {
      const events: any[] = [];
      let autoId = 1;

      const mockDb: any = {
        runEvent: {
          findFirst: async ({ where }: any) => {
            return events.find((e) => e.runId === where.runId && e.stage === where.stage) || null;
          },
          findMany: async ({ where }: any) => {
            return events.filter((e) => {
              if (where.runId && e.runId !== where.runId) return false;
              if (where.stage?.startsWith && !e.stage.startsWith(where.stage.startsWith)) return false;
              return true;
            });
          },
          create: async ({ data }: any) => {
            const row = { id: `evt-${autoId++}`, ...data };
            events.push(row);
            return row;
          },
          update: async ({ where, data }: any) => {
            const idx = events.findIndex((e) => e.id === where.id);
            if (idx >= 0) {
              events[idx] = { ...events[idx], ...data };
              return events[idx];
            }
            throw new Error("Not found");
          },
        },
      };

      const runId = "test-run-failed-midway";
      const projectId = "test-project-failed";

      // Stages recorded prior to failure
      await recordStageMetric(
        {
          runId,
          projectId,
          stageName: "planning",
          modelId: "gemini-2.5-pro",
          startedAt: 1000,
          finishedAt: 2000,
          promptTokens: 1500,
          completionTokens: 600,
        },
        mockDb
      );

      await recordStageMetric(
        {
          runId,
          projectId,
          stageName: "design",
          modelId: "gemini-2.5-flash",
          startedAt: 2100,
          finishedAt: 3000,
          promptTokens: 800,
          completionTokens: 400,
        },
        mockDb
      );

      // Workflow fails before coding finishes
      const failedAggregate = await aggregateAndPersistRunMetrics(runId, projectId, "FAILED", undefined, mockDb);

      assert.equal(failedAggregate.finalOutcome, "FAILED");
      assert.ok(failedAggregate.stages["planning"]);
      assert.ok(failedAggregate.stages["design"]);
      assert.equal(failedAggregate.totalPromptTokens, 1500 + 800);
      assert.equal(failedAggregate.totalCompletionTokens, 600 + 400);
      assert.equal(failedAggregate.costDisclaimer, COST_DISCLAIMER);
    });
  });

  describe("Task 2: Connect Model Selection to Real Execution", () => {
    it("confirms recorded model equals the model actually passed to the Gemini provider", () => {
      process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-gemini-key";

      // 1. Architecture stage escalates to Pro
      const archModel = selectModelForStage("architecture");
      assert.equal(archModel, "gemini-2.5-pro");
      const archAdapter = getGeminiModel({ model: archModel });
      // Verify modelId passed into provider adapter equals selected model
      assert.equal((archAdapter as any).modelId, "gemini-2.5-pro");

      // 2. Design stage selects economical Flash
      const designModel = selectModelForStage("design");
      assert.equal(designModel, "gemini-2.5-flash");
      const designAdapter = getGeminiModel({ model: designModel });
      assert.equal((designAdapter as any).modelId, "gemini-2.5-flash");

      // 3. Repair stage escalates to Pro
      const repairModel = selectModelForStage("repair", { isRepairAttempt: true });
      assert.equal(repairModel, "gemini-2.5-pro");
      const repairAdapter = getGeminiModel({ model: repairModel });
      assert.equal((repairAdapter as any).modelId, "gemini-2.5-pro");
    });
  });

  describe("Task 3: Conservative Fast Path (6 Mandatory Prompts)", () => {
    const mockPrd: PRD = {
      projectName: "Acme Platform",
      summary: "Fullstack web platform",
      targetAudience: "Users",
      capabilities: ["pages-navigation", "data-persistence"],
      unsupportedRequirements: [],
      coreFeatures: [{ name: "Core", description: "Base", priority: "MUST" }],
      pages: [{ route: "/", title: "Home", purpose: "Landing", keyComponents: ["Hero"] }],
      dataEntities: [{ name: "User", fields: ["id", "email"], relationships: [], isPersistent: true }],
      userFlows: [{ name: "Visit", steps: ["Opens page"] }],
    };

    const mockArch: ArchitectureSpec = {
      appType: "nextjs-fullstack",
      capabilities: ["pages-navigation", "data-persistence"],
      requiresDatabase: true,
      routeEndpoints: [{ path: "/", type: "page", purpose: "Home", methods: ["GET"] }],
      uiComponents: [{ name: "Hero", purpose: "Banner", route: "/" }],
      databaseModels: [{ modelName: "User", fields: ["id String @id", "email String"], relations: [] }],
      backendOperations: [],
      businessConstraints: [],
      authRequirements: { enabled: false, strategy: "none" },
      externalIntegrations: [],
      userJourneys: [],
      fileOwnership: {
        frontend: ["src/app/page.tsx"],
        backend: [],
        database: ["prisma/schema.prisma"],
      },
      dependencies: [],
    };

    const mockSpecs = {
      prd: mockPrd,
      architectureSpec: mockArch,
      designSpec: null,
    };

    it("1. 'Change the hero heading colour.' -> BYPASS", () => {
      const res = canBypassPlanningAndArchitecture("Change the hero heading colour.", mockSpecs);
      assert.equal(res.canBypass, true);
    });

    it("2. 'Update the homepage subtitle.' -> BYPASS", () => {
      const res = canBypassPlanningAndArchitecture("Update the homepage subtitle.", mockSpecs);
      assert.equal(res.canBypass, true);
    });

    it("3. 'Add a button that deletes customer records.' -> NO BYPASS", () => {
      const res = canBypassPlanningAndArchitecture("Add a button that deletes customer records.", mockSpecs);
      assert.equal(res.canBypass, false);
      assert.match(res.reason, /structural, database, security, backend, or business-logic/i);
    });

    it("4. 'Add database-backed product filtering.' -> NO BYPASS", () => {
      const res = canBypassPlanningAndArchitecture("Add database-backed product filtering.", mockSpecs);
      assert.equal(res.canBypass, false);
      assert.match(res.reason, /structural, database, security, backend, or business-logic/i);
    });

    it("5. 'Change order-processing behaviour.' -> NO BYPASS", () => {
      const res = canBypassPlanningAndArchitecture("Change order-processing behaviour.", mockSpecs);
      assert.equal(res.canBypass, false);
      assert.match(res.reason, /structural, database, security, backend, or business-logic/i);
    });

    it("6. 'Add login and admin permissions.' -> NO BYPASS", () => {
      const res = canBypassPlanningAndArchitecture("Add login and admin permissions.", mockSpecs);
      assert.equal(res.canBypass, false);
      assert.match(res.reason, /structural, database, security, backend, or business-logic/i);
    });

    it("Never bypasses if approved specifications are missing", () => {
      const res = canBypassPlanningAndArchitecture("Change the hero heading colour.", {
        prd: null,
        architectureSpec: null,
      });
      assert.equal(res.canBypass, false);
    });
  });

  describe("Task 4: Correct File-Context Filtering & Dependency Resolution", () => {
    it("includes relevant imported dependencies for a modified component", () => {
      const files: Record<string, string> = {
        "src/app/page.tsx": `import { UserProfile } from "@/components/UserProfile"; export default function Home() { return <UserProfile />; }`,
        "src/app/layout.tsx": `export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }`,
        "src/app/globals.css": `@tailwind base;`,
        "package.json": `{"name": "test-app"}`,
        // Target component
        "src/components/UserProfile.tsx": `
          import { User } from "@/types/user";
          import { formatCurrency } from "@/lib/utils";
          export function UserProfile({ user }: { user: User }) {
            return <div>{user.name} - {formatCurrency(user.balance)}</div>;
          }
        `,
        // Imported dependencies
        "src/types/user.ts": `export interface User { id: string; name: string; balance: number; }`,
        "src/lib/utils.ts": `export function formatCurrency(amount: number) { return "$" + amount.toFixed(2); }`,
        // Unrelated backend files
        "src/server/auth.ts": `export const auth = () => {};`,
        "src/server/billing.ts": `export const billing = () => {};`,
        "src/server/orders.ts": `export const orders = () => {};`,
        "src/server/inventory.ts": `export const inventory = () => {};`,
        "src/server/reports.ts": `export const reports = () => {};`,
        "src/server/analytics.ts": `export const analytics = () => {};`,
        "src/server/notifications.ts": `export const notifications = () => {};`,
        "src/server/audit.ts": `export const audit = () => {};`,
        "src/server/webhooks.ts": `export const webhooks = () => {};`,
        "src/server/db.ts": `export const db = () => {};`,
      };

      const limits = {
        maxRepairAttempts: 2,
        maxGenerationDurationMs: 300000,
        maxConcurrentRunsPerUser: 3,
        maxInputFilesForContext: 8, // budget strictly limited to 8 files
      };

      const filtered = filterRelevantFiles(files, "Update UserProfile component layout", limits);
      const filteredKeys = Object.keys(filtered);

      // Must not exceed budget
      assert.ok(filteredKeys.length <= limits.maxInputFilesForContext);

      // Must include essential files
      assert.ok(filteredKeys.includes("package.json"));
      assert.ok(filteredKeys.includes("src/app/page.tsx"));

      // Must include target component
      assert.ok(filteredKeys.includes("src/components/UserProfile.tsx"));

      // Must include transitively imported dependencies!
      assert.ok(filteredKeys.includes("src/types/user.ts"), "Must resolve imported @/types/user");
      assert.ok(filteredKeys.includes("src/lib/utils.ts"), "Must resolve imported @/lib/utils");

      // Must exclude unrelated backend files to protect context window
      assert.ok(!filteredKeys.includes("src/server/billing.ts"));
      assert.ok(!filteredKeys.includes("src/server/orders.ts"));
    });
  });

  describe("Task 5: Correct Cost Reporting & Pricing Assumptions", () => {
    it("uses real usage metadata when supplied and does not report missing usage as measured zero", () => {
      // 1. Missing tokens: do NOT report as measured zero
      const missingTokens = calculateCost("gemini-2.5-flash", undefined, undefined);
      assert.equal(missingTokens.usageMeasured, false);
      assert.equal(missingTokens.costUsd, undefined);
      assert.ok(missingTokens.rateUsed, "Identifies rate that would apply to model");

      // 2. Real provider tokens supplied
      const measured = calculateCost("gemini-2.5-flash", 20000, 5000);
      assert.equal(measured.usageMeasured, true);
      assert.ok(measured.costUsd !== undefined);
      // (20,000 / 1M) * 0.075 + (5,000 / 1M) * 0.30 = 0.0015 + 0.0015 = 0.003
      assert.equal(measured.costUsd, 0.003);
    });

    it("does not substitute a default model ID when actual model identity is unknown", () => {
      const unknownModel = calculateCost(undefined, 10000, 5000);
      assert.equal(unknownModel.costUsd, undefined);
      assert.equal(unknownModel.rateUsed, undefined);
      assert.equal(unknownModel.usageMeasured, false);

      const emptyModel = calculateCost("", 10000, 5000);
      assert.equal(emptyModel.costUsd, undefined);
      assert.equal(emptyModel.rateUsed, undefined);
      assert.equal(emptyModel.usageMeasured, false);
    });

    it("extracts usage metadata from provider responses accurately", () => {
      // From AgentKit RunCompletedEvent structure
      const directUsage = extractUsageMetadata({
        usage: { promptTokens: 350, completionTokens: 120, totalTokens: 470 },
      });
      assert.deepEqual(directUsage, {
        promptTokens: 350,
        completionTokens: 120,
        totalTokens: 470,
      });

      // From Gemini raw JSON response
      const rawGeminiJson = extractUsageMetadata({
        raw: JSON.stringify({
          usageMetadata: {
            promptTokenCount: 1200,
            candidatesTokenCount: 450,
            totalTokenCount: 1650,
          },
        }),
      });
      assert.deepEqual(rawGeminiJson, {
        promptTokens: 1200,
        completionTokens: 450,
        totalTokens: 1650,
      });

      // Missing metadata returns undefined (not zeros)
      assert.equal(extractUsageMetadata({}), undefined);
      assert.equal(extractUsageMetadata(null), undefined);
    });

    it("ensures total cost includes disclaimer and is not presented as billing expenditure", () => {
      const collector = new GenerationMetricsCollector("run-disc", "proj-disc");
      collector.startStage("planning", "gemini-2.5-flash");
      collector.endStage("planning", { promptTokens: 1000, completionTokens: 500 });
      const metrics = collector.finalize("COMPLETED");

      assert.equal(metrics.costDisclaimer, COST_DISCLAIMER);
      assert.match(metrics.costDisclaimer, /not actual provider billing expenditure/i);
    });
  });

  describe("Task 6: Configurable Limits", () => {
    it("exposes valid configurable generation limits matching runtime defaults", () => {
      assert.equal(GENERATION_LIMITS.maxRepairAttempts, 2);
      assert.equal(GENERATION_LIMITS.maxGenerationDurationMs, 300000);
      assert.equal(GENERATION_LIMITS.maxConcurrentRunsPerUser, 3);
      assert.equal(GENERATION_LIMITS.maxInputFilesForContext, 30);
    });
  });
});
