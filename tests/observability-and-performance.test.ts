import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCost,
  GenerationMetricsCollector,
  PricingConfig,
} from "../src/server/observability/metrics";
import {
  filterRelevantFiles,
  canBypassPlanningAndArchitecture,
  selectModelForStage,
  GENERATION_LIMITS,
} from "../src/server/orchestration/stage-optimizer";
import { PRD, ArchitectureSpec, DesignSpec } from "../src/server/agent-contracts/schemas";

describe("Performance & Cost Observability Requirements", () => {
  describe("Requirement 1 & Observability: Configurable Pricing & Cost Estimation", () => {
    it("calculates cost accurately using default Gemini rates and records pricing assumptions", () => {
      // 10,000 prompt tokens, 2,000 completion tokens on gemini-2.5-flash
      // Rate: $0.075 / 1M in, $0.30 / 1M out
      // (10,000 / 1M) * 0.075 = $0.00075
      // (2,000 / 1M) * 0.30 = $0.0006
      // Total = $0.00135
      const { costUsd, rateUsed } = calculateCost("gemini-2.5-flash", 10000, 2000);
      assert.equal(costUsd, 0.00135);
      assert.equal(rateUsed.inputPerMillionUsd, 0.075);
      assert.equal(rateUsed.outputPerMillionUsd, 0.30);
    });

    it("calculates cost accurately for gemini-2.5-pro", () => {
      // 5,000 prompt tokens, 1,000 completion tokens on gemini-2.5-pro
      // Rate: $1.25 / 1M in, $5.00 / 1M out
      // (5,000 / 1M) * 1.25 = $0.00625
      // (1,000 / 1M) * 5.00 = $0.005
      // Total = $0.01125
      const { costUsd, rateUsed } = calculateCost("gemini-2.5-pro", 5000, 1000);
      assert.equal(costUsd, 0.01125);
      assert.equal(rateUsed.inputPerMillionUsd, 1.25);
      assert.equal(rateUsed.outputPerMillionUsd, 5.00);
    });

    it("respects custom configurable pricing table without hardcoding assumptions", () => {
      const customConfig: PricingConfig = {
        rates: {
          "custom-model": { inputPerMillionUsd: 0.50, outputPerMillionUsd: 2.00 },
        },
        defaultRate: { inputPerMillionUsd: 0.20, outputPerMillionUsd: 0.80 },
      };

      const customResult = calculateCost("custom-model", 1_000_000, 1_000_000, customConfig);
      assert.equal(customResult.costUsd, 2.50);

      const fallbackResult = calculateCost("unknown-model", 1_000_000, 1_000_000, customConfig);
      assert.equal(fallbackResult.costUsd, 1.00);
    });
  });

  describe("Requirement 1, 2, 7: GenerationMetricsCollector Lifecycle", () => {
    it("tracks stage timings, token usage, sandbox creation, repair attempts, and finalizes complete metrics", async () => {
      const collector = new GenerationMetricsCollector("run-test-123", "proj-test-123");

      // 1. Stage 1: Planning
      collector.startStage("planning", "gemini-2.5-pro");
      await new Promise((resolve) => setTimeout(resolve, 15));
      const planMetric = collector.endStage("planning", {
        promptTokens: 1200,
        completionTokens: 800,
        details: { pagesCount: 3 },
      });
      assert.equal(planMetric.stageName, "planning");
      assert.equal(planMetric.modelId, "gemini-2.5-pro");
      assert.ok(planMetric.durationMs >= 10);
      assert.equal(planMetric.totalTokens, 2000);
      assert.ok(planMetric.estimatedCostUsd > 0);

      // 2. Stage 2: Sandbox creation & initialization
      collector.recordSandboxCreation(2500, "e2b-nextjs-base", "/home/user");
      collector.recordSandboxTotal(12500);

      // 3. Stage 3: Coding
      collector.startStage("coding", "gemini-2.5-flash");
      await new Promise((resolve) => setTimeout(resolve, 15));
      collector.endStage("coding", {
        promptTokens: 4500,
        completionTokens: 3200,
      });

      // 4. Record repair attempt
      collector.recordRepairAttempt();

      // 5. Finalize metrics
      const metrics = collector.finalize("COMPLETED");

      assert.equal(metrics.runId, "run-test-123");
      assert.equal(metrics.projectId, "proj-test-123");
      assert.equal(metrics.finalOutcome, "COMPLETED");
      assert.equal(metrics.repairAttempts, 1);
      assert.ok(metrics.totalDurationMs >= 25);
      assert.equal(metrics.totalPromptTokens, 1200 + 4500);
      assert.equal(metrics.totalCompletionTokens, 800 + 3200);
      assert.equal(metrics.totalTokens, 9700);
      assert.ok(metrics.totalEstimatedCostUsd > 0);
      assert.ok(metrics.modelsUsed.includes("gemini-2.5-pro"));
      assert.ok(metrics.modelsUsed.includes("gemini-2.5-flash"));
      assert.equal(metrics.sandbox?.creationDurationMs, 2500);
      assert.equal(metrics.sandbox?.totalDurationMs, 12500);
      assert.ok(metrics.pricingAssumptions["gemini-2.5-pro"]);
    });

    it("persists metrics via RunEvent without schema breaking changes", async () => {
      const mockEvents: any[] = [];
      const mockPrisma = {
        runEvent: {
          create: async (args: any) => {
            mockEvents.push(args.data);
            return { id: "evt-1", ...args.data };
          },
        },
      };

      const collector = new GenerationMetricsCollector("run-persist-1", "proj-persist-1");
      collector.startStage("planning", "gemini-2.5-flash");
      collector.endStage("planning", { promptTokens: 500, completionTokens: 200 });

      const metrics = await collector.persist("COMPLETED", mockPrisma as any);
      assert.equal(metrics.finalOutcome, "COMPLETED");
      assert.equal(mockEvents.length, 1);
      assert.equal(mockEvents[0].stage, "METRICS_RECORDED");
      assert.equal(mockEvents[0].runId, "run-persist-1");
      assert.equal(mockEvents[0].payload.runId, "run-persist-1");
    });
  });

  describe("Requirement 3: Context Filtering (Avoid Flooding Prompt with Entire Tree)", () => {
    it("filters out unrelated files when prompt targets specific UI or styling", () => {
      const sourceFiles: Record<string, string> = {
        "app/page.tsx": "export default function () { return <div>Home</div>; }",
        "app/globals.css": ":root { --primary: red; }",
        "package.json": '{"name": "app"}',
        "components/theme-toggle.tsx": "export function ThemeToggle() {}",
        "components/navbar.tsx": "export function Navbar() {}",
        "lib/db.ts": "export const db = {};",
        "prisma/schema.prisma": "model User { id String @id }",
        "app/api/auth/route.ts": "export function POST() {}",
        "app/api/users/route.ts": "export function GET() {}",
        "lib/utils.ts": "export function cn() {}",
      };

      // User prompt is purely visual/style related
      const filtered = filterRelevantFiles(
        sourceFiles,
        "Update the navbar with a dark mode theme-toggle button and adjust primary colors",
        { ...GENERATION_LIMITS, maxInputFilesForContext: 5 }
      );

      // Must keep entrypoint and manifest
      assert.ok(filtered["app/page.tsx"], "Must keep app/page.tsx");
      assert.ok(filtered["package.json"], "Must keep package.json");
      assert.ok(filtered["app/globals.css"], "Must keep styling file");
      assert.ok(filtered["components/theme-toggle.tsx"], "Must keep explicitly referenced component");
      assert.ok(filtered["components/navbar.tsx"], "Must keep navbar component");

      // Should exclude unrelated backend routes to save token window
      assert.equal(filtered["app/api/auth/route.ts"], undefined);
      assert.equal(filtered["app/api/users/route.ts"], undefined);
    });

    it("keeps database files when prompt involves database modifications", () => {
      const sourceFiles: Record<string, string> = {
        "app/page.tsx": "export default function () {}",
        "package.json": '{"name": "app"}',
        "prisma/schema.prisma": "model Product { id String @id }",
        "lib/db.ts": "export const db = {};",
        "app/api/products/route.ts": "export function GET() {}",
        "components/footer.tsx": "export function Footer() {}",
        "components/banner.tsx": "export function Banner() {}",
      };

      const filtered = filterRelevantFiles(
        sourceFiles,
        "Add a new quantity field to the Product prisma database model and update product API route",
        { ...GENERATION_LIMITS, maxInputFilesForContext: 4 }
      );

      assert.ok(filtered["prisma/schema.prisma"], "Must include prisma schema");
      assert.ok(filtered["lib/db.ts"], "Must include db client");
      assert.ok(filtered["app/api/products/route.ts"], "Must include api route");
    });
  });

  describe("Requirement 4 & 5: Specification Reuse & Stage Bypass", () => {
    const existingPRD: PRD = {
      projectName: "Developer Portfolio",
      summary: "Modern developer portfolio",
      targetAudience: "Recruiters and engineers",
      capabilities: ["pages-navigation", "forms-validation"],
      unsupportedRequirements: [],
      coreFeatures: [{ name: "Projects", description: "Project list", priority: "MUST" }],
      pages: [{ route: "/", title: "Home", purpose: "Showcase", keyComponents: ["ProjectGrid"] }],
      dataEntities: [],
      userFlows: [],
    };

    const existingDesign: DesignSpec = {
      aestheticTheme: "Modern Dark",
      colorPalette: {
        primary: "#3b82f6",
        secondary: "#1e293b",
        accent: "#06b6d4",
        background: "#0f172a",
        surface: "#1e293b",
        text: "#f8fafc",
      },
      typography: { headingFont: "Geist", bodyFont: "Geist Sans" },
      layoutStyle: "clean",
      componentGuidelines: [],
    };

    const existingArch: ArchitectureSpec = {
      appType: "nextjs-fullstack",
      capabilities: ["pages-navigation", "forms-validation"],
      requiresDatabase: false,
      routeEndpoints: [{ path: "/", type: "page", purpose: "Home page" }],
      uiComponents: [{ name: "ProjectGrid", purpose: "Showcase", route: "/" }],
      databaseModels: [],
      backendOperations: [],
      businessConstraints: [],
      authRequirements: { enabled: false, strategy: "none" },
      externalIntegrations: [],
      userJourneys: [],
      fileOwnership: { frontend: ["app/**/*.tsx"] },
      dependencies: [],
    };

    it("safely bypasses planning and architecture for simple styling or UI modifications", () => {
      const decision = canBypassPlanningAndArchitecture(
        "Change the primary button color to emerald green and add a dark mode toggle",
        { prd: existingPRD, designSpec: existingDesign, architectureSpec: existingArch }
      );

      assert.equal(decision.canBypass, true);
      assert.match(decision.reason, /reusing approved specifications|Incremental UI/i);
    });

    it("does NOT bypass planning when the prompt introduces new database models or backend systems", () => {
      const decision = canBypassPlanningAndArchitecture(
        "Add a new database schema for customer testimonials and an API endpoint to submit reviews",
        { prd: existingPRD, designSpec: existingDesign, architectureSpec: existingArch }
      );

      assert.equal(decision.canBypass, false);
      assert.match(decision.reason, /structural changes/i);
    });

    it("does NOT bypass planning when approved specifications do not exist", () => {
      const decision = canBypassPlanningAndArchitecture("Change color to blue", {
        prd: null,
        designSpec: null,
        architectureSpec: null,
      });

      assert.equal(decision.canBypass, false);
      assert.match(decision.reason, /Missing existing approved specifications/i);
    });
  });

  describe("Requirement 7 & 9: Model Escalation & Configurable Limits", () => {
    it("selects economical model for design and fast tasks, escalating to Pro for architecture or repair", () => {
      assert.equal(selectModelForStage("design"), "gemini-2.5-flash");
      assert.equal(selectModelForStage("planning", { isComplexFullstack: false }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("architecture"), "gemini-2.5-pro");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true }), "gemini-2.5-pro");
      assert.equal(selectModelForStage("coding", { isComplexFullstack: true }), "gemini-2.5-pro");
    });

    it("exposes valid configurable generation limits", () => {
      assert.ok(GENERATION_LIMITS.maxRepairAttempts >= 1);
      assert.ok(GENERATION_LIMITS.maxGenerationDurationMs >= 30000);
      assert.ok(GENERATION_LIMITS.maxConcurrentRunsPerUser >= 1);
      assert.ok(GENERATION_LIMITS.maxInputFilesForContext >= 5);
    });
  });
});
