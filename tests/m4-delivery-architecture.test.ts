import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import {
  DraftValidationStatus,
  GenerationRunStatus,
} from "@/generated/prisma/client";
import {
  upsertGenerationDraft,
  getAuthorizedDraft,
} from "@/server/orchestration/drafts";
import {
  finalizeGenerationFailure,
  finalizeGenerationSuccess,
} from "@/server/orchestration/finalization";
import {
  generateProjectZip,
} from "@/server/export/zip-export";
import { reconcileStaleGenerationRuns } from "@/server/orchestration/outbox";
import {
  runQAInspector,
  formatRepairInstructions,
} from "@/server/agents/qa";
import { codeAgentFunction } from "@/features/inngest/functions";
import { isRunActiveInDb } from "@/server/orchestration/finalization";
import { RunAbortedError } from "@/server/orchestration/stage-optimizer";

describe("M4 Source Delivery Architecture: Draft Preservation, QA Diagnostics & Resilient Watchdog", () => {
  // =========================================================================
  // SCENARIO 1: Coding creates files -> QA fails -> Unverified Draft Delivered
  // =========================================================================
  it("Scenario 1: Persists unverified draft when QA fails, retains diagnostics, and provides downloadable draft ZIP", async () => {
    const originalProjectFindUnique = prisma.project.findUnique;
    const originalDraftUpsert = prisma.generationDraft.upsert;
    const originalDraftFindFirst = prisma.generationDraft.findFirst;
    const originalTx = prisma.$transaction;

    const testProjectId = "proj-delivery-1";
    const testUserId = "user-delivery-1";
    const testRunId = "run-delivery-1";

    const generatedFiles: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "artisan-bakery",
        scripts: { build: "next build", dev: "next dev" },
        dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "app/page.tsx": "export default function Page() { return <h1>Artisan Bakery</h1>; }",
      "components/catalog.tsx": "export function Catalog() { return <div>Croissant</div>; }",
    };

    let persistedDraftRecord: any = null;

    // 1. Mock draft upsert
    prisma.generationDraft.upsert = (async (args: any) => {
      persistedDraftRecord = {
        id: "draft-delivery-1",
        generationRunId: args.where.generationRunId,
        projectId: args.create.projectId,
        files: args.create.files,
        manifest: args.create.manifest,
        validationStatus: args.create.validationStatus,
        summary: args.create.summary,
        source: args.create.source,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return persistedDraftRecord;
    }) as any;

    try {
      // Step A: Immediately after coding, draft is captured and persisted before QA
      const draft = await upsertGenerationDraft({
        generationRunId: testRunId,
        projectId: testProjectId,
        files: generatedFiles,
        validationStatus: DraftValidationStatus.UNVALIDATED,
        summary: "Synthesized artisan bakery landing page with catalog",
        source: "coding-agent",
      });

      assert.equal(draft.id, "draft-delivery-1");
      assert.equal(draft.validationStatus, DraftValidationStatus.UNVALIDATED);
      assert.equal(Object.keys(draft.files as any).length, 3);
      assert.ok(draft.manifest);

      // Step B: QA execution with failure captures real exitCode, stdout, stderr, and timeout
      const mockExecutor = {
        run: async (cmd: string) => {
          if (cmd.includes("tsc")) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "app/page.tsx(5,12): error TS2304: Cannot find name 'UnknownSymbol'.",
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      };

      const qaReport = await runQAInspector({
        files: generatedFiles,
        summary: "Synthesized artisan bakery landing page with catalog",
        sandboxId: "sandbox-mock-1",
        runSandboxCommands: true,
        customExecutor: mockExecutor,
        workspaceDir: "/workspace/test",
      });

      assert.equal(qaReport.passed, false);
      const tscCheck = qaReport.checks.find((c) => c.name === "typescript-validation");
      assert.ok(tscCheck);
      assert.equal(tscCheck.status, "FAIL");
      assert.equal(tscCheck.exitCode, 1);
      assert.match(tscCheck.stderr || "", /error TS2304/);
      assert.match(qaReport.repairInstructions || "", /error TS2304/);

      // Step C: Failure finalization updates draft status to FAILED and preserves prior working revision
      let failureStatusUpdated = false;
      prisma.$transaction = (async (fn: any) => {
        const mockTx = {
          generationRun: {
            findUnique: async () => ({
              id: testRunId,
              projectId: testProjectId,
              status: GenerationRunStatus.VALIDATING,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
            update: async () => ({ id: testRunId, status: GenerationRunStatus.FAILED }),
          },
          generationDraft: {
            updateMany: async (args: any) => {
              if (args.data.validationStatus === DraftValidationStatus.FAILED) {
                failureStatusUpdated = true;
                persistedDraftRecord.validationStatus = DraftValidationStatus.FAILED;
              }
              return { count: 1 };
            },
          },
          project: {
            findUnique: async () => ({ id: testProjectId, currentRevisionId: "rev-prior-working" }),
            update: async () => {
              throw new Error("CRITICAL BUG: Project pointer must NOT be updated on failure!");
            },
          },
          projectRevision: {
            count: async () => 1,
          },
          runEvent: {
            create: async () => ({ id: "event-1" }),
          },
          message: {
            findUnique: async () => null,
            create: async () => ({ id: "msg-fail-1" }),
          },
        };
        return fn(mockTx);
      }) as any;

      const failResult = await finalizeGenerationFailure({
        projectId: testProjectId,
        generationRunId: testRunId,
        errorCode: "QA_VERIFICATION_FAILED",
        errorMessage: "TypeScript compilation failed with error TS2304",
      });

      assert.equal(failResult.messageId, "msg-fail-1");
      assert.equal(failureStatusUpdated, true);
      assert.equal(persistedDraftRecord.validationStatus, DraftValidationStatus.FAILED);

      // Step D: User downloads unverified draft ZIP archive
      prisma.project.findUnique = (async () => ({
        id: testProjectId,
        name: "Artisan Bakery",
        currentRevisionId: "rev-prior-working",
      })) as any;

      prisma.generationDraft.findFirst = (async () => persistedDraftRecord) as any;

      const zipResult = await generateProjectZip({
        projectId: testProjectId,
        draftId: "draft-delivery-1",
        userId: testUserId,
      });

      assert.equal(zipResult.isDraft, true);
      assert.equal(zipResult.filename, "codemytra-artisan-bakery-unverified-draft.zip");
      assert.equal(zipResult.fileCount, 3);

      // Verify ZIP contents and UNVERIFIED_DRAFT_NOTICE.md presence
      const unzipped = await JSZip.loadAsync(zipResult.buffer);
      const noticeFile = unzipped.file("codemytra-artisan-bakery-unverified-draft/UNVERIFIED_DRAFT_NOTICE.md");
      assert.ok(noticeFile, "UNVERIFIED_DRAFT_NOTICE.md must be included in draft export");
      const noticeText = await noticeFile.async("string");
      assert.match(noticeText, /Unverified Draft Notice/);
      assert.match(noticeText, /FAILED/);

      const pageFile = unzipped.file("codemytra-artisan-bakery-unverified-draft/app/page.tsx");
      assert.ok(pageFile);
      const pageContent = await pageFile.async("string");
      assert.match(pageContent, /Artisan Bakery/);
    } finally {
      prisma.project.findUnique = originalProjectFindUnique;
      prisma.generationDraft.upsert = originalDraftUpsert;
      prisma.generationDraft.findFirst = originalDraftFindFirst;
      prisma.$transaction = originalTx;
    }
  });

  // =========================================================================
  // SCENARIO 2: Coding creates files -> QA passes -> Revision V1 Promoted
  // =========================================================================
  it("Scenario 2: Successful QA promotes draft to Revision V1, updates draft status to PASSED, and serves verified ZIP", async () => {
    const originalProjectFindUnique = prisma.project.findUnique;
    const originalRevisionFindUnique = prisma.projectRevision.findUnique;
    const originalDraftUpsert = prisma.generationDraft.upsert;
    const originalTx = prisma.$transaction;

    const testProjectId = "proj-success-1";
    const testUserId = "user-success-1";
    const testRunId = "run-success-1";

    const verifiedFiles: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "artisan-bakery",
        scripts: { build: "next build", dev: "next dev" },
        dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2022" } }),
      "app/page.tsx": "export default function Page() { return <h1>Artisan Bakery V1</h1>; }",
    };

    let draftStatusPassed = false;
    let promotedToHead = false;

    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async () => ({
            id: testRunId,
            projectId: testProjectId,
            status: GenerationRunStatus.VALIDATING,
            revisions: [],
          }),
          update: async () => ({ id: testRunId, status: GenerationRunStatus.COMPLETED }),
        },
        generationDraft: {
          updateMany: async (args: any) => {
            if (args.data.validationStatus === DraftValidationStatus.PASSED) {
              draftStatusPassed = true;
            }
            return { count: 1 };
          },
        },
        project: {
          findUnique: async () => ({ id: testProjectId, currentRevisionId: null }),
          updateMany: async () => {
            promotedToHead = true;
            return { count: 1 };
          },
        },
        projectRevision: {
          findFirst: async () => null,
          create: async (args: any) => ({
            id: "rev-v1-created",
            revisionNumber: 1,
            ...args.data,
          }),
        },
        runEvent: {
          create: async () => ({ id: "event-succ-1" }),
        },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-succ-1" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const successResult = await finalizeGenerationSuccess({
        projectId: testProjectId,
        generationRunId: testRunId,
        fragmentTitle: "Artisan Bakery Initial Launch",
        summary: "Generated authentic Next.js bakery website",
        files: verifiedFiles,
        sandboxUrl: "http://mock-preview-host:3000",
      });

      assert.equal(successResult.promoted, true);
      assert.equal(promotedToHead, true);
      assert.equal(draftStatusPassed, true);
      assert.equal(successResult.revision.revisionNumber, 1);

      // Verify verified ZIP export
      prisma.project.findUnique = (async () => ({
        id: testProjectId,
        name: "Artisan Bakery",
        currentRevisionId: "rev-v1-created",
      })) as any;

      prisma.projectRevision.findUnique = (async () => ({
        id: "rev-v1-created",
        projectId: testProjectId,
        revisionNumber: 1,
        files: verifiedFiles,
      })) as any;

      const verifiedZip = await generateProjectZip({
        projectId: testProjectId,
        revisionId: "rev-v1-created",
        userId: testUserId,
      });

      assert.equal(verifiedZip.filename, "codemytra-Artisan Bakery-v1.zip");
      assert.equal(verifiedZip.revisionNumber, 1);
      assert.equal(verifiedZip.fileCount, 3);
    } finally {
      prisma.project.findUnique = originalProjectFindUnique;
      prisma.projectRevision.findUnique = originalRevisionFindUnique;
      prisma.generationDraft.upsert = originalDraftUpsert;
      prisma.$transaction = originalTx;
    }
  });

  // =========================================================================
  // SCENARIO 3: Resilient Watchdog Activity Timestamp Selection
  // =========================================================================
  it("Scenario 3: Watchdog checks latest activity across events, updatedAt, and startedAt; does not fail active run with old createdAt", async () => {
    const originalFindMany = prisma.generationRun.findMany;
    const originalTx = prisma.$transaction;

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);

    let failedRunId: string | null = null;

    // Run 1: Created 10m ago, but recorded an event 30s ago (actively progressing)
    // Run 2: Created 10m ago, updatedAt 10m ago, no events (truly abandoned)
    const mockRuns = [
      {
        id: "run-active-progressing",
        projectId: "proj-1",
        status: GenerationRunStatus.RUNNING,
        createdAt: tenMinutesAgo,
        startedAt: tenMinutesAgo,
        updatedAt: tenMinutesAgo,
        events: [{ createdAt: thirtySecondsAgo }],
      },
      {
        id: "run-abandoned",
        projectId: "proj-2",
        status: GenerationRunStatus.RUNNING,
        createdAt: tenMinutesAgo,
        startedAt: tenMinutesAgo,
        updatedAt: tenMinutesAgo,
        events: [{ createdAt: tenMinutesAgo }],
      },
    ];

    prisma.generationRun.findMany = (async () => mockRuns) as any;

    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async (args: any) => {
            const r = mockRuns.find((x) => x.id === args.where.id);
            return r ? { ...r, revisions: [] } : null;
          },
          update: async (args: any) => {
            failedRunId = args.where.id;
            return { id: args.where.id, status: GenerationRunStatus.FAILED };
          },
        },
        generationDraft: {
          updateMany: async () => ({ count: 0 }),
        },
        project: {
          findUnique: async () => ({ id: "proj-2", currentRevisionId: null }),
        },
        projectRevision: { count: async () => 0 },
        runEvent: { create: async () => ({}) },
        message: { findUnique: async () => null, create: async () => ({ id: "m-1" }) },
      };
      return fn(mockTx);
    }) as any;

    try {
      const result = await reconcileStaleGenerationRuns(60 * 1000);

      // Exactly 1 run should be reconciled: the abandoned run, NOT the progressing run
      assert.equal(result.checked, 2);
      assert.equal(result.reconciled, 1);
      assert.deepEqual(result.runIds, ["run-abandoned"]);
      assert.equal(failedRunId, "run-abandoned");
    } finally {
      prisma.generationRun.findMany = originalFindMany;
      prisma.$transaction = originalTx;
    }
  });

  // =========================================================================
  // SCENARIO 4: Strict Ownership Boundary & Unauthorized Access Control
  // =========================================================================
  it("Scenario 4: getAuthorizedDraft and generateProjectZip strictly reject cross-user access", async () => {
    const originalProjectFindUnique = prisma.project.findUnique;

    prisma.project.findUnique = (async (args: any) => {
      // Only returns project if userId matches owner
      if (args.where.id === "proj-secret" && args.where.userId === "owner-user") {
        return { id: "proj-secret", name: "Secret App", currentRevisionId: null };
      }
      return null;
    }) as any;

    try {
      // 1. getAuthorizedDraft by attacker
      const unauthorizedDraft = await getAuthorizedDraft({
        projectId: "proj-secret",
        userId: "attacker-user",
        draftId: "draft-secret",
      });
      assert.equal(unauthorizedDraft, null);

      // 2. generateProjectZip with draftId by attacker
      await assert.rejects(
        async () => {
          await generateProjectZip({
            projectId: "proj-secret",
            draftId: "draft-secret",
            userId: "attacker-user",
          });
        },
        /Project not found or unauthorized/i
      );
    } finally {
      prisma.project.findUnique = originalProjectFindUnique;
    }
  });

  // =========================================================================
  // SCENARIO 5: formatRepairInstructions Actionable Compiler Output
  // =========================================================================
  it("Scenario 5: formatRepairInstructions preserves check names, exit codes, timeout, and compiler diagnostics", () => {
    const checks = [
      {
        name: "typescript-validation",
        category: "typescript-validation",
        status: "FAIL",
        details: "TypeScript typecheck failed",
        exitCode: 2,
        timeout: false,
        stderr: "components/hero.tsx(14,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      },
      {
        name: "production-build",
        category: "production-build",
        status: "FAIL",
        details: "Production build exceeded deadline budget",
        exitCode: null,
        timeout: true,
      },
    ];

    const instructions = formatRepairInstructions(checks, [
      "TypeScript error in components/hero.tsx",
      "Production build timed out",
    ]);

    assert.match(instructions, /\[Check: typescript-validation \(typescript-validation\)\]/);
    assert.match(instructions, /Exit Code: 2/);
    assert.match(instructions, /error TS2322/);
    assert.match(instructions, /\[Check: production-build \(production-build\)\]/);
    assert.match(instructions, /Status: Command exceeded execution timeout budget/);
  });

  // =========================================================================
  // SCENARIO 6: Workspace Preflight Bounded Operation & Timeout Diagnostics
  // =========================================================================
  it("Scenario 6: Workspace preflight bounds timeout, diagnoses missing dependencies, and treats timeout as infrastructure failure without AI repair", async () => {
    // Sub-case A: E2B sandbox throws deadline_exceeded during preflight
    const timeoutExecutor = {
      run: async (cmd: string) => {
        if (cmd.includes("test -d") && cmd.includes("package.json")) {
          const timeoutErr = new Error("deadline_exceeded: E2B microVM command execution timed out");
          (timeoutErr as any).name = "TimeoutError";
          throw timeoutErr;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const timeoutReport = await runQAInspector({
      files: {
        "package.json": JSON.stringify({ name: "artisan-bakery" }),
        "app/page.tsx": "export default function Page() { return <h1>Bakery</h1>; }",
      },
      summary: "Bakery",
      sandboxId: "mock-sandbox",
      runSandboxCommands: true,
      customExecutor: timeoutExecutor,
      workspaceDir: "/home/user/workspace",
    });

    assert.equal(timeoutReport.passed, false);
    assert.equal(timeoutReport.isInfrastructureTimeout, true, "Must flag infrastructure timeout");
    assert.equal(timeoutReport.repairNeeded, false, "Must NOT require AI repair on infrastructure timeout");

    const timeoutPreflight = timeoutReport.checks.find((c) => c.name === "workspace-preflight");
    assert.ok(timeoutPreflight);
    assert.equal(timeoutPreflight.status, "FAIL");
    assert.equal(timeoutPreflight.timeout, true);
    assert.match(timeoutPreflight.details || "", /Infrastructure timeout/i);

    const skippedTsc = timeoutReport.checks.find((c) => c.name === "typescript-validation");
    assert.ok(skippedTsc);
    assert.equal(skippedTsc.status, "SKIPPED");

    // Sub-case B: Successful preflight on 14-file bakery project proceeds to TypeScript and Build checks
    let tscCalled = false;
    let buildCalled = false;
    let preflightCommandRun = "";

    const successExecutor = {
      run: async (cmd: string) => {
        if (cmd.includes("test -d") && cmd.includes("package.json")) {
          preflightCommandRun = cmd;
          return { exitCode: 0, stdout: "verified", stderr: "" };
        }
        if (cmd.includes("tsc")) {
          tscCalled = true;
          return { exitCode: 0, stdout: "tsc clean", stderr: "" };
        }
        if (cmd.includes("build")) {
          buildCalled = true;
          return { exitCode: 0, stdout: "build success", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const fourteenFiles: Record<string, string> = {
      "package.json": JSON.stringify({ name: "bakery-app", scripts: { build: "next build" } }),
      "app/page.tsx": "export default function Page() { return <div>Bakery</div>; }",
      "app/layout.tsx": "export default function RootLayout({ children }: { children: any }) { return <html><body>{children}</body></html>; }",
      "components/header.tsx": "export function Header() { return <header>Header</header>; }",
      "components/footer.tsx": "export function Footer() { return <footer>Footer</footer>; }",
      "components/hero.tsx": "export function Hero() { return <section>Hero</section>; }",
      "components/product-card.tsx": "export function ProductCard() { return <div>Card</div>; }",
      "components/cart-drawer.tsx": "export function CartDrawer() { return <aside>Cart</aside>; }",
      "components/hours-location.tsx": "export function Hours() { return <div>Hours</div>; }",
      "components/contact-form.tsx": "export function Contact() { return <form>Form</form>; }",
      "lib/cart-context.tsx": "export const Cart = {};",
      "lib/products.ts": "export const products = [];",
      "types/product.ts": "export type Product = { id: string };",
      "styles/globals.css": "body { margin: 0; }",
    };

    const successReport = await runQAInspector({
      files: fourteenFiles,
      summary: "14-file bakery app",
      sandboxId: "mock-sandbox",
      runSandboxCommands: true,
      customExecutor: successExecutor,
      workspaceDir: "/home/user/workspace",
    });

    assert.equal(successReport.passed, true);
    assert.equal(tscCalled, true, "TypeScript validation must run after preflight passes");
    assert.equal(buildCalled, true, "Production build must run after TypeScript passes");
    assert.match(preflightCommandRun, /test -d/);
    assert.match(preflightCommandRun, /node_modules/);

    const successPreflight = successReport.checks.find((c) => c.name === "workspace-preflight");
    assert.ok(successPreflight);
    assert.equal(successPreflight.status, "PASS");
    assert.equal(successPreflight.timeout, false);
  });

  // =========================================================================
  // SCENARIO 7: Inngest Replay After save-result Finalization
  // =========================================================================
  it("Scenario 7: Inngest replay after save-result returns normally without RunAbortedError while maintaining active terminal guards", async () => {
    const testProjectId = "proj-replay-test";
    const testRunId = "run-replay-test";

    // Setup initial database state: Run is RUNNING
    let currentDbStatus: GenerationRunStatus = GenerationRunStatus.RUNNING;
    const runStartedAt: Date = new Date();

    const originalFindUnique = prisma.generationRun.findUnique;
    const originalUpdateMany = prisma.generationRun.updateMany;
    const originalProjectSpec = prisma.projectSpecification?.findUnique;
    const originalRunEventFindMany = prisma.runEvent?.findMany;
    const originalRunEventUpsert = prisma.runEvent?.upsert;
    const originalRunEventCreate = prisma.runEvent?.create;
    const originalTx = prisma.$transaction;
    const originalEnvKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "mock-openai-key";

    prisma.generationRun.findUnique = (async (args: any) => {
      if (args.where?.id === testRunId) {
        return {
          id: testRunId,
          projectId: testProjectId,
          status: currentDbStatus,
          startedAt: runStartedAt,
          createdAt: runStartedAt,
          revisions: [],
        };
      }
      return null;
    }) as any;

    prisma.generationRun.updateMany = (async () => ({ count: 1 })) as any;

    if (prisma.runEvent) {
      prisma.runEvent.findMany = (async () => []) as any;
      prisma.runEvent.upsert = (async () => ({})) as any;
      prisma.runEvent.create = (async () => ({})) as any;
    }

    if (prisma.projectSpecification) {
      prisma.projectSpecification.findUnique = (async () => null) as any;
    }

    prisma.$transaction = (async (fnOrArray: any) => {
      if (typeof fnOrArray === "function") {
        const mockTx = {
          generationRun: {
            findUnique: async () => ({
              id: testRunId,
              projectId: testProjectId,
              status: currentDbStatus,
              startedAt: runStartedAt,
              revisions: [],
            }),
            update: async (args: any) => {
              if (args.data?.status) {
                currentDbStatus = args.data.status;
              }
              return { id: testRunId, status: currentDbStatus };
            },
            updateMany: async () => ({ count: 1 }),
          },
          project: {
            findUnique: async () => ({ currentRevisionId: null }),
            updateMany: async () => ({ count: 0 }),
          },
          projectRevision: {
            count: async () => 0,
            create: async () => ({ id: "rev-mock", revisionNumber: 1 }),
          },
          generationDraft: {
            updateMany: async () => ({ count: 1 }),
          },
          runEvent: {
            create: async () => ({ id: "event-1" }),
          },
          message: {
            findUnique: async () => null,
            create: async () => ({ id: "msg-failure-result" }),
          },
        };
        return fnOrArray(mockTx);
      }
      return [];
    }) as any;

    try {
      const stepHistory: Record<string, any> = {};

      // Simulated durable Inngest step runner
      const createStepRunner = () => ({
        run: async (stepId: string, fn: () => Promise<any>) => {
          if (stepId in stepHistory) {
            return stepHistory[stepId];
          }
          const result = await fn();
          stepHistory[stepId] = result;
          return result;
        },
      });

      // Populate prerequisites up through QA failure
      stepHistory["resolve-base-files"] = {
        baseFiles: {},
        baseRev: null,
        bypassDecision: { canBypass: false },
        existingSpec: {},
      };
      stepHistory["planner-spec"] = {
        projectName: "Bakery App",
        summary: "Bakery",
        targetAudience: "Foodies",
        capabilities: ["pages-navigation"],
        coreFeatures: [],
        pages: [],
      };
      stepHistory["design-spec"] = {
        aestheticTheme: "Warm Artisan",
        colorPalette: { primary: "#c05621", secondary: "#ecc94b", background: "#ffffff", text: "#2d3748" },
        typography: { fontFamily: "Inter", headingFont: "Playfair" },
      };
      stepHistory["architecture-spec"] = {
        routeEndpoints: [],
        fileStructure: [],
        componentHierarchy: [],
        requiresDatabase: false,
        capabilities: ["pages-navigation"],
      };
      stepHistory["mark-run-running"] = {};
      stepHistory["get-sandbox-id-and-restore"] = "mock-sandbox-id";
      stepHistory["get-previous-messages"] = [];
      stepHistory["check-coding-active"] = { active: true };
      stepHistory["initial-coding-agent"] = {
        summary: "Coded bakery landing page",
        files: { "package.json": "{}", "app/page.tsx": "export default function Page() {}" },
        usage: { promptTokens: 1000, completionTokens: 500 },
        modelId: "gpt-4o",
      };
      stepHistory["check-post-coding-active"] = { active: true };
      stepHistory["capture-initial-draft"] = {
        "package.json": "{}",
        "app/page.tsx": "export default function Page() {}",
      };
      stepHistory["generate-response-metadata"] = {
        fragmentTitle: "Bakery Landing Page",
        responseText: "Here is your bakery website.",
      };
      stepHistory["qa-agent"] = {
        report: {
          passed: false,
          score: 60,
          repairNeeded: false,
          repairInstructions: "TypeScript syntax errors",
          verificationMode: "sandbox-verified",
          isInfrastructureTimeout: false,
          summary: "TypeScript check failed",
          checks: [],
          executedCategories: ["typescript-validation"],
        },
        finalFiles: { "package.json": "{}", "app/page.tsx": "export default function Page() {}" },
        finalSummary: "Initial code",
        finalSnapshotVerified: false,
      };

      const handler = (codeAgentFunction as any).fn;
      assert.ok(typeof handler === "function", "Inngest function handler must be defined");

      const eventPayload = {
        data: {
          projectId: testProjectId,
          runId: testRunId,
          value: "Build bakery app",
        },
      };

      // Execution Phase 1: save-result runs and finalizes the run to FAILED in DB
      const resultPass1 = await handler({
        event: eventPayload,
        step: createStepRunner(),
      });

      assert.equal(resultPass1.status, "FAILED");
      assert.equal(resultPass1.priorRevisionPreserved, true);
      assert.equal(resultPass1.messageId, "msg-failure-result");

      // Database run status is now confirmed FAILED
      assert.equal(currentDbStatus, GenerationRunStatus.FAILED);
      assert.equal(await isRunActiveInDb(testRunId), false, "Run is now terminal in DB");

      // Execution Phase 2: Inngest re-evaluates the function from the top (replay)
      // With check-coding-active and check-post-coding-active memoized inside step.run,
      // the function must NOT throw RunAbortedError on replay!
      const resultReplay = await handler({
        event: eventPayload,
        step: createStepRunner(),
      });

      assert.equal(resultReplay.status, "FAILED", "Replay must return FAILED status object normally");
      assert.equal(resultReplay.priorRevisionPreserved, true);
      assert.equal(resultReplay.messageId, "msg-failure-result");

      // Phase 3: Active terminal guard verification
      // If a run is genuinely cancelled in DB before active coding runs, check-coding-active throws RunAbortedError
      currentDbStatus = GenerationRunStatus.CANCELLED;
      const cancelledRunStepHistory: Record<string, any> = {
        "resolve-base-files": { baseFiles: {}, baseRev: null, bypassDecision: { canBypass: false }, existingSpec: {} },
        "planner-spec": { projectName: "Bakery", summary: "Bakery", targetAudience: "All", capabilities: ["pages-navigation"], coreFeatures: [], pages: [] },
        "design-spec": { aestheticTheme: "Warm", colorPalette: { primary: "#c05621" }, typography: { fontFamily: "Inter" } },
        "architecture-spec": { routeEndpoints: [], fileStructure: [], componentHierarchy: [], requiresDatabase: false, capabilities: ["pages-navigation"] },
        "mark-run-running": {},
        "get-sandbox-id-and-restore": "mock-sandbox-id",
        "get-previous-messages": [],
        // "check-coding-active" is NOT memoized, so it executes live against CANCELLED DB state
      };

      const cancelledStepRunner = {
        run: async (stepId: string, fn: () => Promise<any>) => {
          if (stepId in cancelledRunStepHistory) {
            return cancelledRunStepHistory[stepId];
          }
          return fn();
        },
      };

      await assert.rejects(
        async () => {
          await handler({
            event: { data: { projectId: testProjectId, runId: testRunId, value: "prompt" } },
            step: cancelledStepRunner,
          });
        },
        (err: any) => {
          return (
            err instanceof RunAbortedError ||
            (err instanceof Error && err.name === "RunAbortedError") ||
            String(err).includes("RunAbortedError")
          );
        }
      );
    } finally {
      prisma.generationRun.findUnique = originalFindUnique;
      prisma.generationRun.updateMany = originalUpdateMany;
      if (prisma.projectSpecification && originalProjectSpec) {
        prisma.projectSpecification.findUnique = originalProjectSpec;
      }
      if (prisma.runEvent) {
        if (originalRunEventFindMany) prisma.runEvent.findMany = originalRunEventFindMany;
        if (originalRunEventUpsert) prisma.runEvent.upsert = originalRunEventUpsert;
        if (originalRunEventCreate) prisma.runEvent.create = originalRunEventCreate;
      }
      prisma.$transaction = originalTx;
      process.env.OPENAI_API_KEY = originalEnvKey;
    }
  });
});
