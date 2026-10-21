import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import {
  DraftValidationStatus,
  GenerationRunStatus,
} from "@/generated/prisma/client";
import {
  captureSandboxSnapshot,
  SnapshotError,
  MAX_SINGLE_FILE_SIZE_BYTES,
} from "@/server/orchestration/sandbox-snapshot";
import {
  generateManifest,
} from "@/server/orchestration/revisions";
import {
  ensureSandboxPreviewServer,
  PROJECT_WORKSPACE_DIR,
} from "@/server/orchestration/workspace";
import {
  finalizeGenerationFailure,
  finalizeGenerationSuccess,
} from "@/server/orchestration/finalization";
import {
  upsertGenerationDraft,
  getAuthorizedDraft,
} from "@/server/orchestration/drafts";
import { generateProjectZip } from "@/server/export/zip-export";
import { codeAgentFunction } from "@/features/inngest/functions";

describe("M4 P0: Final Snapshot and Preview Delivery Suite", () => {
  // =========================================================================
  // CONDITION 1: Validated Source-Checkpoint Contract & Late Redundant Transport Immunity
  // =========================================================================
  it("Condition 1: Initial draft capture succeeds; QA passes; verified checkpoint promoted directly without redundant snapshot", async () => {
    const testProjectId = "proj-checkpoint-1";
    const testRunId = "run-checkpoint-1";
    let currentDbStatus: GenerationRunStatus = GenerationRunStatus.RUNNING;
    const runStartedAt = new Date();

    const originalFindUnique = prisma.generationRun.findUnique;
    const originalUpdateMany = prisma.generationRun.updateMany;
    const originalTx = prisma.$transaction;
    const originalDraftUpsert = prisma.generationDraft.upsert;
    const originalRunEventUpsert = prisma.runEvent?.upsert;
    const originalRunEventCreate = prisma.runEvent?.create;
    const originalRunEventFindMany = prisma.runEvent?.findMany;
    const originalEnvKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "mock-key";

    if (prisma.runEvent) {
      prisma.runEvent.upsert = (async () => ({})) as any;
      prisma.runEvent.create = (async () => ({})) as any;
      prisma.runEvent.findMany = (async () => []) as any;
    }

    let promotedRevision: any = null;
    let finalizedRunStatus: string | null = null;
    let draftRecord: any = null;

    prisma.generationRun.findUnique = (async (args: any) => {
      if (args.where?.id === testRunId) {
        return {
          id: testRunId,
          projectId: testProjectId,
          status: currentDbStatus,
          startedAt: runStartedAt,
          createdAt: runStartedAt,
          revisions: promotedRevision ? [promotedRevision] : [],
        };
      }
      return null;
    }) as any;

    prisma.generationRun.updateMany = (async () => ({ count: 1 })) as any;
    prisma.generationDraft.upsert = (async (args: any) => {
      draftRecord = {
        id: "draft-test-1",
        generationRunId: args.where.generationRunId,
        projectId: args.create.projectId,
        files: args.create.files,
        manifest: args.create.manifest,
        validationStatus: args.create.validationStatus,
        source: args.create.source,
      };
      return draftRecord;
    }) as any;

    prisma.$transaction = (async (fnOrArray: any) => {
      if (typeof fnOrArray === "function") {
        const mockTx = {
          generationRun: {
            findUnique: async () => ({
              id: testRunId,
              projectId: testProjectId,
              status: currentDbStatus,
              startedAt: runStartedAt,
              revisions: promotedRevision ? [promotedRevision] : [],
            }),
            update: async (args: any) => {
              if (args.data?.status) {
                currentDbStatus = args.data.status;
                finalizedRunStatus = args.data.status;
              }
              return { id: testRunId, status: currentDbStatus };
            },
            updateMany: async () => ({ count: 1 }),
          },
          project: {
            findUnique: async () => ({ currentRevisionId: null }),
            updateMany: async () => ({ count: 1 }),
          },
          projectRevision: {
            findFirst: async () => null,
            count: async () => 0,
            create: async (args: any) => {
              promotedRevision = {
                id: "rev-v1-verified",
                revisionNumber: 1,
                files: args.data.files,
                manifest: args.data.manifest,
              };
              return promotedRevision;
            },
          },
          generationDraft: {
            updateMany: async () => ({ count: 1 }),
          },
          runEvent: {
            create: async () => ({ id: "evt-1" }),
          },
          message: {
            findUnique: async () => null,
            create: async () => ({ id: "msg-success" }),
          },
        };
        return fnOrArray(mockTx);
      }
      return [];
    }) as any;

    try {
      const canonicalFiles = {
        "package.json": JSON.stringify({ name: "app", dependencies: { next: "15.0.0", react: "19.0.0" } }),
        "app/page.tsx": "export default function Page() { return <h1>Artisan Bakery</h1>; }",
        "app/layout.tsx": "export default function Layout({ children }: any) { return <html><body>{children}</body></html>; }",
        "next.config.mjs": "export default {};",
      };

      const stepHistory: Record<string, any> = {
        "resolve-base-files": { baseFiles: {}, baseRev: null, bypassDecision: { canBypass: false }, existingSpec: {} },
        "planner-spec": { projectName: "Bakery", summary: "Bakery", capabilities: ["pages-navigation"], coreFeatures: [], pages: [] },
        "design-spec": { aestheticTheme: "Warm", colorPalette: { primary: "#c05621" }, typography: { fontFamily: "Inter" } },
        "architecture-spec": { routeEndpoints: [], fileStructure: [], componentHierarchy: [], requiresDatabase: false, capabilities: ["pages-navigation"] },
        "mark-run-running": {},
        "get-sandbox-id-and-restore": "mock-sandbox-123",
        "get-previous-messages": [],
        "check-coding-active": { active: true },
        "initial-coding-agent": {
          summary: "Coded bakery landing page",
          files: canonicalFiles,
          usage: { promptTokens: 100, completionTokens: 200 },
        },
        // Pre-QA initial draft capture succeeded with canonical provenance
        "capture-initial-draft": {
          files: canonicalFiles,
          manifest: generateManifest(canonicalFiles),
          source: "canonical-sandbox-snapshot",
          diagnostics: { provenance: "canonical-sandbox-snapshot", fileCount: 4 },
        },
        "generate-response-metadata": {
          fragmentTitle: "Artisan Bakery",
          responseText: "Here is your bakery website.",
        },
      };

      const stepRunner = {
        run: async (stepId: string, fn: () => Promise<any>) => {
          if (stepId in stepHistory) {
            return stepHistory[stepId];
          }
          if (stepId === "qa-agent") {
            // Emulate QA pass: transition to VALIDATING as functions.ts does
            currentDbStatus = GenerationRunStatus.VALIDATING;
            return {
              report: {
                passed: true,
                score: 100,
                verificationMode: "sandbox-verified",
                checks: [{ name: "TypeScript compilation", passed: true, score: 100 }],
                repairNeeded: false,
              },
              finalFiles: canonicalFiles,
              finalSummary: "Verified bakery landing page",
              finalSnapshotVerified: true,
            };
          }
          if (stepId === "save-result") {
            const success = await finalizeGenerationSuccess({
              projectId: testProjectId,
              generationRunId: testRunId,
              baseRevisionId: null,
              fragmentTitle: "Artisan Bakery",
              summary: "Here is your bakery website.",
              files: canonicalFiles,
              sandboxUrl: "http://mock-sandbox-123.preview.e2b.dev",
            });
            return {
              failed: false,
              sandboxUrl: "http://mock-sandbox-123.preview.e2b.dev",
              successResult: success,
              messageId: success.messageId,
              error: null,
            };
          }
          return fn();
        },
      };

      const handler = (codeAgentFunction as any).fn;
      const result = await handler({
        event: { data: { projectId: testProjectId, runId: testRunId, value: "Build bakery website" } },
        step: stepRunner,
      });

      assert.equal(result.status, "COMPLETED");
      assert.equal(result.revisionNumber, 1);
      assert.equal(finalizedRunStatus, GenerationRunStatus.COMPLETED);
      assert.ok(promotedRevision);
      assert.equal(Object.keys(promotedRevision.files).length, 4);
      assert.ok(promotedRevision.files["app/page.tsx"]);
    } finally {
      prisma.generationRun.findUnique = originalFindUnique;
      prisma.generationRun.updateMany = originalUpdateMany;
      prisma.$transaction = originalTx;
      prisma.generationDraft.upsert = originalDraftUpsert;
      if (prisma.runEvent) {
        if (originalRunEventUpsert) prisma.runEvent.upsert = originalRunEventUpsert;
        if (originalRunEventCreate) prisma.runEvent.create = originalRunEventCreate;
        if (originalRunEventFindMany) prisma.runEvent.findMany = originalRunEventFindMany;
      }
      process.env.OPENAI_API_KEY = originalEnvKey;
    }
  });

  // =========================================================================
  // CONDITION 2: Snapshot Failure Before Verification Prevents V1 Creation
  // =========================================================================
  it("Condition 2: Unverified model memory fallback is strictly rejected by contract; V1 is not created", async () => {
    const testProjectId = "proj-checkpoint-2";
    const testRunId = "run-checkpoint-2";
    let currentDbStatus: GenerationRunStatus = GenerationRunStatus.RUNNING;
    const runStartedAt = new Date();

    const originalFindUnique = prisma.generationRun.findUnique;
    const originalUpdateMany = prisma.generationRun.updateMany;
    const originalTx = prisma.$transaction;
    const originalDraftUpsert = prisma.generationDraft.upsert;
    const originalRunEventUpsert = prisma.runEvent?.upsert;
    const originalRunEventCreate = prisma.runEvent?.create;
    const originalRunEventFindMany = prisma.runEvent?.findMany;
    const originalEnvKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "mock-key";

    if (prisma.runEvent) {
      prisma.runEvent.upsert = (async () => ({})) as any;
      prisma.runEvent.create = (async () => ({})) as any;
      prisma.runEvent.findMany = (async () => []) as any;
    }

    let v1Created = false;

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
    prisma.generationDraft.upsert = (async () => ({})) as any;

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
              if (args.data?.status) currentDbStatus = args.data.status;
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
            create: async () => {
              v1Created = true;
              return { id: "rev-v1" };
            },
          },
          generationDraft: { updateMany: async () => ({ count: 1 }) },
          runEvent: { create: async () => ({ id: "evt-1" }) },
          message: {
            findUnique: async () => null,
            create: async () => ({ id: "msg-fail" }),
          },
        };
        return fnOrArray(mockTx);
      }
      return [];
    }) as any;

    try {
      const mockFiles = {
        "app/page.tsx": "export default function Page() { return <h1>Unverified</h1>; }",
      };

      // In this scenario, initial snapshot failed; only unverified fallback was stored
      const stepHistory: Record<string, any> = {
        "resolve-base-files": { baseFiles: {}, baseRev: null, bypassDecision: { canBypass: false }, existingSpec: {} },
        "planner-spec": { projectName: "App", summary: "App", capabilities: ["pages-navigation"], coreFeatures: [], pages: [] },
        "design-spec": { aestheticTheme: "Theme", colorPalette: { primary: "#000" }, typography: { fontFamily: "Inter" } },
        "architecture-spec": { routeEndpoints: [], fileStructure: [], componentHierarchy: [], requiresDatabase: false, capabilities: ["pages-navigation"] },
        "mark-run-running": {},
        "get-sandbox-id-and-restore": "mock-sandbox-fail",
        "get-previous-messages": [],
        "check-coding-active": { active: true },
        "initial-coding-agent": {
          summary: "Coded app",
          files: mockFiles,
        },
        "capture-initial-draft": {
          files: mockFiles,
          manifest: generateManifest(mockFiles),
          source: "unverified-model-output-fallback", // NOT canonical
          diagnostics: { warning: "E2B snapshot failed" },
        },
        "generate-response-metadata": { fragmentTitle: "App", responseText: "App summary" },
      };

      const stepRunner = {
        run: async (stepId: string, fn: () => Promise<any>) => {
          if (stepId in stepHistory) return stepHistory[stepId];
          if (stepId === "qa-agent") {
            // Emulate QA inspector evaluating unverified fallback: contract rejects promotion
            const isCanonical = stepHistory["capture-initial-draft"].source === "canonical-sandbox-snapshot";
            return {
              report: {
                passed: isCanonical,
                score: isCanonical ? 100 : 50,
                verificationMode: "sandbox-verified",
                checks: [],
                repairNeeded: false,
                repairInstructions: isCanonical ? undefined : "Validated source-checkpoint contract rejected: Checkpoint provenance is 'unverified-model-output-fallback'",
              },
              finalFiles: mockFiles,
              finalSummary: "App summary",
              finalSnapshotVerified: false,
            };
          }
          if (stepId === "save-result") {
            const fail = await finalizeGenerationFailure({
              projectId: testProjectId,
              generationRunId: testRunId,
              errorCode: "QA_VERIFICATION_FAILED",
              errorMessage: "Validated source-checkpoint contract rejected: Checkpoint provenance is 'unverified-model-output-fallback'",
            });
            return fail;
          }
          return fn();
        },
      };

      const handler = (codeAgentFunction as any).fn;
      const result = await handler({
        event: { data: { projectId: testProjectId, runId: testRunId, value: "Prompt" } },
        step: stepRunner,
      });

      assert.equal(result.status, "FAILED");
      assert.equal(v1Created, false, "V1 revision must NOT be created when source is unverified fallback");
      assert.equal(currentDbStatus, GenerationRunStatus.FAILED);
    } finally {
      prisma.generationRun.findUnique = originalFindUnique;
      prisma.generationRun.updateMany = originalUpdateMany;
      prisma.$transaction = originalTx;
      prisma.generationDraft.upsert = originalDraftUpsert;
      if (prisma.runEvent) {
        if (originalRunEventUpsert) prisma.runEvent.upsert = originalRunEventUpsert;
        if (originalRunEventCreate) prisma.runEvent.create = originalRunEventCreate;
        if (originalRunEventFindMany) prisma.runEvent.findMany = originalRunEventFindMany;
      }
      process.env.OPENAI_API_KEY = originalEnvKey;
    }
  });

  // =========================================================================
  // CONDITION 3: Repair Modifies Files -> Checkpoint Refreshed & Verified
  // =========================================================================
  it("Condition 3: Repair modifies a file; old checkpoint is invalidated and refreshed source is verified", async () => {
    const testProjectId = "proj-checkpoint-3";
    const testRunId = "run-checkpoint-3";
    let currentDbStatus: GenerationRunStatus = GenerationRunStatus.RUNNING;
    const runStartedAt = new Date();

    const originalFindUnique = prisma.generationRun.findUnique;
    const originalUpdateMany = prisma.generationRun.updateMany;
    const originalTx = prisma.$transaction;
    const originalDraftUpsert = prisma.generationDraft.upsert;
    const originalRunEventUpsert = prisma.runEvent?.upsert;
    const originalRunEventCreate = prisma.runEvent?.create;
    const originalRunEventFindMany = prisma.runEvent?.findMany;
    const originalEnvKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "mock-key";

    if (prisma.runEvent) {
      prisma.runEvent.upsert = (async () => ({})) as any;
      prisma.runEvent.create = (async () => ({})) as any;
      prisma.runEvent.findMany = (async () => []) as any;
    }

    let savedFiles: Record<string, string> = {};

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
    prisma.generationDraft.upsert = (async (args: any) => {
      savedFiles = args.create.files;
      return { id: "draft-repair", ...args.create };
    }) as any;

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
              if (args.data?.status) currentDbStatus = args.data.status;
              return { id: testRunId, status: currentDbStatus };
            },
            updateMany: async () => ({ count: 1 }),
          },
          project: {
            findUnique: async () => ({ currentRevisionId: null }),
            updateMany: async () => ({ count: 1 }),
          },
          projectRevision: {
            findFirst: async () => null,
            count: async () => 0,
            create: async (args: any) => {
              savedFiles = args.data.files;
              return { id: "rev-v1-repair", revisionNumber: 1, files: args.data.files };
            },
          },
          generationDraft: { updateMany: async () => ({ count: 1 }) },
          runEvent: { create: async () => ({ id: "evt-1" }) },
          message: { findUnique: async () => null, create: async () => ({ id: "msg-repair" }) },
        };
        return fnOrArray(mockTx);
      }
      return [];
    }) as any;

    try {
      const initialFiles = {
        "app/page.tsx": "export default function Page() { return <h1>Broken Synatx",
      };

      const repairedFiles = {
        "package.json": JSON.stringify({ name: "repaired", dependencies: { next: "15.0.0" } }),
        "app/page.tsx": "export default function Page() { return <h1>Fixed Syntax</h1>; }",
      };

      const stepHistory: Record<string, any> = {
        "resolve-base-files": { baseFiles: {}, baseRev: null, bypassDecision: { canBypass: false }, existingSpec: {} },
        "planner-spec": { projectName: "App", summary: "App", capabilities: ["pages-navigation"], coreFeatures: [], pages: [] },
        "design-spec": { aestheticTheme: "Theme", colorPalette: { primary: "#000" }, typography: { fontFamily: "Inter" } },
        "architecture-spec": { routeEndpoints: [], fileStructure: [], componentHierarchy: [], requiresDatabase: false, capabilities: ["pages-navigation"] },
        "mark-run-running": {},
        "get-sandbox-id-and-restore": "mock-sandbox-repair",
        "get-previous-messages": [],
        "check-coding-active": { active: true },
        "initial-coding-agent": {
          summary: "Coded initial draft with broken syntax",
          files: initialFiles,
        },
        "capture-initial-draft": {
          files: initialFiles,
          manifest: generateManifest(initialFiles),
          source: "canonical-sandbox-snapshot",
        },
        "generate-response-metadata": { fragmentTitle: "App", responseText: "App summary" },
      };

      const stepRunner = {
        run: async (stepId: string, fn: () => Promise<any>) => {
          if (stepId in stepHistory) return stepHistory[stepId];
          if (stepId === "qa-agent") {
            // Emulates: Pass 1 fails -> Repair runs -> captures canonical-repair-sandbox-snapshot -> Pass 2 passes
            currentDbStatus = GenerationRunStatus.VALIDATING;
            const refreshedCheckpoint = {
              files: repairedFiles,
              manifest: generateManifest(repairedFiles),
              source: "canonical-repair-sandbox-snapshot",
              diagnostics: { provenance: "canonical-repair-sandbox-snapshot", fileCount: 2 },
            };

            await prisma.generationDraft.upsert({
              where: { generationRunId: testRunId },
              create: {
                generationRunId: testRunId,
                projectId: testProjectId,
                files: refreshedCheckpoint.files,
                validationStatus: DraftValidationStatus.PASSED,
                summary: "Repaired syntax and verified",
                source: refreshedCheckpoint.source,
              },
              update: {},
            });

            return {
              report: {
                passed: true,
                score: 95,
                verificationMode: "sandbox-verified",
                checks: [{ name: "TypeScript compilation", passed: true, score: 100 }],
                repairNeeded: false,
              },
              finalFiles: refreshedCheckpoint.files,
              finalSummary: "Repaired syntax and verified",
              finalSnapshotVerified: true,
            };
          }
          if (stepId === "save-result") {
            const success = await finalizeGenerationSuccess({
              projectId: testProjectId,
              generationRunId: testRunId,
              baseRevisionId: null,
              fragmentTitle: "Repaired App",
              summary: "Fixed syntax",
              files: repairedFiles,
              sandboxUrl: "http://preview.dev",
            });
            return {
              failed: false,
              sandboxUrl: "http://preview.dev",
              successResult: success,
              messageId: success.messageId,
            };
          }
          return fn();
        },
      };

      const handler = (codeAgentFunction as any).fn;
      const result = await handler({
        event: { data: { projectId: testProjectId, runId: testRunId, value: "Prompt" } },
        step: stepRunner,
      });

      assert.equal(result.status, "COMPLETED");
      assert.ok(savedFiles["app/page.tsx"].includes("Fixed Syntax"));
    } finally {
      prisma.generationRun.findUnique = originalFindUnique;
      prisma.generationRun.updateMany = originalUpdateMany;
      prisma.$transaction = originalTx;
      prisma.generationDraft.upsert = originalDraftUpsert;
      if (prisma.runEvent) {
        if (originalRunEventUpsert) prisma.runEvent.upsert = originalRunEventUpsert;
        if (originalRunEventCreate) prisma.runEvent.create = originalRunEventCreate;
        if (originalRunEventFindMany) prisma.runEvent.findMany = originalRunEventFindMany;
      }
      process.env.OPENAI_API_KEY = originalEnvKey;
    }
  });

  // =========================================================================
  // CONDITION 4: Snapshot Security & Integrity Checks
  // =========================================================================
  describe("Condition 4: Snapshot Security, Integrity & Concurrency Verification", () => {
    it("rejects path traversal outside workspace and ignores dangerous outer paths", async () => {
      const mockSandbox = {
        commands: {
          run: async (cmd: string) => {
            if (cmd.includes("test -d")) return { exitCode: 0, stdout: "EXISTS" };
            if (cmd.includes("find")) {
              return {
                exitCode: 0,
                stdout: `${PROJECT_WORKSPACE_DIR}/app/page.tsx\n${PROJECT_WORKSPACE_DIR}/../etc/passwd\n${PROJECT_WORKSPACE_DIR}/valid.json`,
              };
            }
            return { exitCode: 0, stdout: "" };
          },
        },
        files: {
          read: async (filePath: string) => {
            if (filePath.includes("page.tsx")) return "export default function Page() { return null; }";
            if (filePath.includes("valid.json")) return "{}";
            return "forbidden-content";
          },
        },
      };

      await assert.rejects(
        async () => {
          await captureSandboxSnapshot("mock-sbx", { customSandbox: mockSandbox as any });
        },
        (err: any) => {
          assert.ok(err instanceof SnapshotError);
          assert.equal(err.phase, "integrity-check");
          return true;
        }
      );
    });

    it("rejects oversized single file (>1MB)", async () => {
      const oversizedContent = "x".repeat(MAX_SINGLE_FILE_SIZE_BYTES + 10);
      const mockSandbox = {
        commands: {
          run: async (cmd: string) => {
            if (cmd.includes("test -d")) return { exitCode: 0, stdout: "EXISTS" };
            if (cmd.includes("find")) {
              return {
                exitCode: 0,
                stdout: `${PROJECT_WORKSPACE_DIR}/app/page.tsx\n${PROJECT_WORKSPACE_DIR}/big-payload.json`,
              };
            }
            return { exitCode: 0, stdout: "" };
          },
        },
        files: {
          read: async (filePath: string) => {
            if (filePath.includes("page.tsx")) return "export default function Page() { return null; }";
            return oversizedContent;
          },
        },
      };

      await assert.rejects(
        async () => {
          await captureSandboxSnapshot("mock-sbx", { customSandbox: mockSandbox as any });
        },
        (err: any) => {
          assert.ok(err instanceof SnapshotError);
          assert.equal(err.phase, "integrity-check");
          assert.ok(err.message.includes("exceeds maximum single file size limit"));
          return true;
        }
      );
    });

    it("rejects snapshot missing required Next.js entrypoint file", async () => {
      const mockSandbox = {
        commands: {
          run: async (cmd: string) => {
            if (cmd.includes("test -d")) return { exitCode: 0, stdout: "EXISTS" };
            if (cmd.includes("find")) {
              return {
                exitCode: 0,
                stdout: `${PROJECT_WORKSPACE_DIR}/utils/helper.ts\n${PROJECT_WORKSPACE_DIR}/package.json`,
              };
            }
            return { exitCode: 0, stdout: "" };
          },
        },
        files: {
          read: async (filePath: string) => {
            if (filePath.includes("helper.ts")) return "export const x = 1;";
            return JSON.stringify({ name: "test" });
          },
        },
      };

      await assert.rejects(
        async () => {
          await captureSandboxSnapshot("mock-sbx", { customSandbox: mockSandbox as any });
        },
        (err: any) => {
          assert.ok(err instanceof SnapshotError);
          assert.equal(err.phase, "integrity-check");
          assert.ok(err.message.includes("missing required Next.js entrypoint"));
          return true;
        }
      );
    });

    it("disambiguates duplicate Next.js configs, favoring canonical next.config.mjs", async () => {
      const mockSandbox = {
        commands: {
          run: async (cmd: string) => {
            if (cmd.includes("test -d")) return { exitCode: 0, stdout: "EXISTS" };
            if (cmd.includes("find")) {
              return {
                exitCode: 0,
                stdout: `${PROJECT_WORKSPACE_DIR}/app/page.tsx\n${PROJECT_WORKSPACE_DIR}/next.config.mjs\n${PROJECT_WORKSPACE_DIR}/next.config.ts`,
              };
            }
            return { exitCode: 0, stdout: "" };
          },
        },
        files: {
          read: async (filePath: string) => {
            if (filePath.includes("page.tsx")) return "export default function Page() { return <h1>Hi</h1>; }";
            if (filePath.includes("next.config.mjs")) return "export default { mjs: true };";
            return "export default { ts: true };";
          },
        },
      };

      const result = await captureSandboxSnapshot("mock-sbx", { customSandbox: mockSandbox as any });
      assert.ok(result.files["next.config.mjs"]);
      assert.equal(result.files["next.config.ts"], undefined, "next.config.ts must be omitted when next.config.mjs exists");
    });

    it("retries on transient transport errors and succeeds with concurrency limit = 6", async () => {
      let transientFailures = 0;
      const fileNames = Array.from({ length: 15 }, (_, i) => `components/comp-${i}.tsx`);
      fileNames.push("app/page.tsx");

      const mockSandbox = {
        commands: {
          run: async (cmd: string) => {
            if (cmd.includes("test -d")) return { exitCode: 0, stdout: "EXISTS" };
            if (cmd.includes("find")) {
              return {
                exitCode: 0,
                stdout: fileNames.map((n) => `${PROJECT_WORKSPACE_DIR}/${n}`).join("\n"),
              };
            }
            return { exitCode: 0, stdout: "" };
          },
        },
        files: {
          read: async (filePath: string) => {
            // Simulate transient ECONNRESET for one file on first attempt
            if (filePath.includes("comp-2.tsx") && transientFailures < 1) {
              transientFailures++;
              throw new Error("read ECONNRESET - connection dropped");
            }
            return `export default function Component() { return <div>${filePath}</div>; }`;
          },
        },
      };

      const result = await captureSandboxSnapshot("mock-sbx", { customSandbox: mockSandbox as any });
      assert.equal(transientFailures, 1, "Must have encountered and retried transient error");
      assert.equal(Object.keys(result.files).length, 16);
      assert.ok(result.manifest.hashes?.["components/comp-2.tsx"]);
    });
  });

  // =========================================================================
  // CONDITION 5: Preview Readiness Failure Records PREVIEW_SERVER_FAILED
  // =========================================================================
  it("Condition 5: Preview readiness failure records PREVIEW_SERVER_FAILED without false success or fake revision", async () => {
    const testProjectId = "proj-preview-fail";
    const testRunId = "run-preview-fail";
    let currentDbStatus: GenerationRunStatus = GenerationRunStatus.RUNNING;
    let recordedErrorCode: string | null = null;
    let recordedErrorMessage: string | null = null;
    let revisionCreated = false;

    const originalFindUnique = prisma.generationRun.findUnique;
    const originalUpdateMany = prisma.generationRun.updateMany;
    const originalTx = prisma.$transaction;

    prisma.generationRun.findUnique = (async (args: any) => {
      if (args.where?.id === testRunId) {
        return {
          id: testRunId,
          projectId: testProjectId,
          status: currentDbStatus,
          startedAt: new Date(),
          createdAt: new Date(),
          revisions: [],
        };
      }
      return null;
    }) as any;

    prisma.generationRun.updateMany = (async () => ({ count: 1 })) as any;

    prisma.$transaction = (async (fnOrArray: any) => {
      if (typeof fnOrArray === "function") {
        const mockTx = {
          generationRun: {
            findUnique: async () => ({
              id: testRunId,
              projectId: testProjectId,
              status: currentDbStatus,
              startedAt: new Date(),
              revisions: [],
            }),
            update: async (args: any) => {
              if (args.data?.status) currentDbStatus = args.data.status;
              if (args.data?.errorCode) recordedErrorCode = args.data.errorCode;
              if (args.data?.errorMessage) recordedErrorMessage = args.data.errorMessage;
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
            create: async () => {
              revisionCreated = true;
              return { id: "fake-rev" };
            },
          },
          generationDraft: { updateMany: async () => ({ count: 1 }) },
          runEvent: { create: async () => ({ id: "evt-1" }) },
          message: { findUnique: async () => null, create: async () => ({ id: "msg-preview-fail" }) },
        };
        return fnOrArray(mockTx);
      }
      return [];
    }) as any;

    try {
      // Simulate ensureSandboxPreviewServer failure
      const mockFailingSandbox = {
        commands: {
          run: async (cmd: string) => {
            if (cmd.includes("pgrep -f 'next'")) return { exitCode: 1, stdout: "" };
            if (cmd.includes("npm run dev")) return { exitCode: 0, stdout: "" };
            if (cmd.includes("curl -s -o /dev/null -w '%{http_code}'")) {
              return { exitCode: 1, stdout: "000" }; // Never returns HTTP response
            }
            if (cmd.includes("/tmp/preview.log")) {
              return { exitCode: 0, stdout: "Error: Port 3000 already in use\nFatal crash on start" };
            }
            return { exitCode: 0, stdout: "" };
          },
        },
      };

      await assert.rejects(
        async () => {
          await ensureSandboxPreviewServer(mockFailingSandbox as any, { maxAttempts: 1, pollIntervalMs: 50 });
        },
        (err: any) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("failed to respond on port 3000"));
          assert.ok(err.message.includes("Port 3000 already in use"));
          return true;
        }
      );

      // Finalize failure with PREVIEW_SERVER_FAILED
      const failureRes = await finalizeGenerationFailure({
        projectId: testProjectId,
        generationRunId: testRunId,
        errorCode: "PREVIEW_SERVER_FAILED",
        errorMessage: "Preview server failed to start: Port 3000 in use",
      });

      assert.equal(currentDbStatus, GenerationRunStatus.FAILED);
      assert.equal(recordedErrorCode, "PREVIEW_SERVER_FAILED");
      assert.ok(String(recordedErrorMessage || "").includes("Preview server failed to start"));
      assert.equal(revisionCreated, false, "No revision must be created when preview server fails");
      assert.ok(failureRes.messageId);
    } finally {
      prisma.generationRun.findUnique = originalFindUnique;
      prisma.generationRun.updateMany = originalUpdateMany;
      prisma.$transaction = originalTx;
    }
  });

  // =========================================================================
  // CONDITION 6: Complete Pipeline -> QA -> Preview -> Verified V1 -> Code Explorer -> ZIP
  // =========================================================================
  it("Condition 6: Complete source -> QA -> preview -> verified V1 -> Code Explorer -> ZIP works end-to-end", async () => {
    const testProjectId = "proj-e2e-v1";
    const testRunId = "run-e2e-v1";
    const testUserId = "user-e2e-v1";

    const verifiedFiles = {
      "package.json": JSON.stringify({
        name: "patisserie-app",
        version: "1.0.0",
        scripts: { build: "next build", dev: "next dev" },
        dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "es5", skipLibCheck: true },
        include: ["**/*.ts", "**/*.tsx"],
      }),
      "app/layout.tsx": "export default function RootLayout({ children }: any) { return <html><body>{children}</body></html>; }",
      "app/page.tsx": "export default function HomePage() { return <main><h1>Le Petit Croissant</h1></main>; }",
      "components/navbar.tsx": "export function Navbar() { return <nav>Bakery Nav</nav>; }",
      "next.config.mjs": "export default {};",
    };

    let activeRevisionRecord: any = null;

    const originalProjectFindUnique = prisma.project.findUnique;
    const originalRunFindUnique = prisma.generationRun.findUnique;
    const originalRevisionFindUnique = prisma.projectRevision.findUnique;
    const originalTx = prisma.$transaction;

    prisma.project.findUnique = (async (args: any) => {
      if (args.where?.id === testProjectId) {
        return {
          id: testProjectId,
          userId: testUserId,
          name: "Patisserie",
          currentRevisionId: activeRevisionRecord?.id || null,
          currentRevision: activeRevisionRecord,
        };
      }
      return null;
    }) as any;

    prisma.projectRevision.findUnique = (async (args: any) => {
      if (args.where?.id === activeRevisionRecord?.id) {
        return activeRevisionRecord;
      }
      return null;
    }) as any;

    prisma.generationRun.findUnique = (async (args: any) => {
      if (args.where?.id === testRunId) {
        return {
          id: testRunId,
          projectId: testProjectId,
          status: GenerationRunStatus.VALIDATING,
          startedAt: new Date(),
          createdAt: new Date(),
          revisions: [],
        };
      }
      return null;
    }) as any;

    prisma.$transaction = (async (fnOrArray: any) => {
      if (typeof fnOrArray === "function") {
        const mockTx = {
          generationRun: {
            findUnique: async () => ({
              id: testRunId,
              projectId: testProjectId,
              status: GenerationRunStatus.VALIDATING,
              startedAt: new Date(),
              revisions: [],
            }),
            update: async () => ({ id: testRunId, status: GenerationRunStatus.COMPLETED }),
            updateMany: async () => ({ count: 1 }),
          },
          project: {
            findUnique: async () => ({ currentRevisionId: null }),
            updateMany: async () => ({ count: 1 }),
          },
          projectRevision: {
            findFirst: async () => null,
            count: async () => 0,
            create: async (args: any) => {
              activeRevisionRecord = {
                id: "rev-patisserie-v1",
                projectId: testProjectId,
                generationRunId: testRunId,
                revisionNumber: 1,
                title: args.data.title,
                summary: args.data.summary,
                files: args.data.files,
                manifest: args.data.manifest,
                createdAt: new Date(),
              };
              return activeRevisionRecord;
            },
          },
          generationDraft: { updateMany: async () => ({ count: 1 }) },
          runEvent: { create: async () => ({ id: "evt-1" }) },
          message: { findUnique: async () => null, create: async () => ({ id: "msg-v1" }) },
        };
        return fnOrArray(mockTx);
      }
      return [];
    }) as any;

    try {
      // 1. Finalize generation success
      const finalResult = await finalizeGenerationSuccess({
        projectId: testProjectId,
        generationRunId: testRunId,
        baseRevisionId: null,
        fragmentTitle: "Le Petit Croissant",
        summary: "Verified artisan bakery website",
        files: verifiedFiles,
        sandboxUrl: "http://patisserie.sandbox.e2b.dev:3000",
      });

      assert.equal(finalResult.promoted, true);
      assert.equal(finalResult.revision.revisionNumber, 1);
      assert.equal(finalResult.revision.id, "rev-patisserie-v1");

      // 2. Code Explorer read access
      const project = await prisma.project.findUnique({
        where: { id: testProjectId },
        include: { currentRevision: true },
      });
      assert.ok(project);
      assert.equal(project.currentRevisionId, "rev-patisserie-v1");
      const explorerFiles = project.currentRevision?.files as Record<string, string>;
      assert.equal(Object.keys(explorerFiles).length, 6);
      assert.ok(explorerFiles["app/page.tsx"].includes("Le Petit Croissant"));

      // 3. ZIP Export generation
      const zipResult = await generateProjectZip({
        projectId: testProjectId,
        userId: testUserId,
      });

      assert.ok(zipResult.buffer instanceof Buffer);
      assert.ok(zipResult.buffer.length > 500);

      // Verify ZIP contents using JSZip
      const zip = await JSZip.loadAsync(zipResult.buffer);
      const zipEntries = Object.keys(zip.files);
      assert.ok(zipEntries.some((entry) => entry.endsWith("app/page.tsx")));
      assert.ok(zipEntries.some((entry) => entry.endsWith("package.json")));
      assert.ok(zipEntries.some((entry) => entry.endsWith("README.md")));

      const pageEntry = zipEntries.find((entry) => entry.endsWith("app/page.tsx"))!;
      const extractedPage = await zip.file(pageEntry)?.async("string");
      assert.ok(extractedPage?.includes("Le Petit Croissant"));
    } finally {
      prisma.project.findUnique = originalProjectFindUnique;
      prisma.projectRevision.findUnique = originalRevisionFindUnique;
      prisma.generationRun.findUnique = originalRunFindUnique;
      prisma.$transaction = originalTx;
    }
  });

  // =========================================================================
  // CONDITION 7: Failed Generation Still Exposes Its Unverified Draft
  // =========================================================================
  it("Condition 7: Failed generation still exposes its unverified draft and downloadable draft ZIP to authorized owner", async () => {
    const testProjectId = "proj-draft-expose";
    const testUserId = "user-owner-draft";
    const testRunId = "run-draft-expose";

    const capturedDraftFiles = {
      "package.json": JSON.stringify({ name: "unverified-draft" }),
      "app/page.tsx": "export default function Page() { return <h1>Draft</h1>; }",
      "lib/utils.ts": "export const add = (a: number, b: number) => a + b;",
    };

    let draftStore: any = null;

    const originalProjectFindUnique = prisma.project.findUnique;
    const originalDraftUpsert = prisma.generationDraft.upsert;
    const originalDraftFindFirst = prisma.generationDraft.findFirst;

    prisma.project.findUnique = (async (args: any) => {
      if (args.where?.id === testProjectId) {
        if (args.where?.userId && args.where.userId !== testUserId) {
          return null;
        }
        return {
          id: testProjectId,
          userId: testUserId,
          name: "Expose Draft Project",
          currentRevisionId: null,
          currentRevision: null,
        };
      }
      return null;
    }) as any;

    prisma.generationDraft.upsert = (async (args: any) => {
      draftStore = {
        id: "draft-record-1",
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
      return draftStore;
    }) as any;

    prisma.generationDraft.findFirst = (async (args: any) => {
      if (
        (args.where?.id === "draft-record-1" || args.where?.generationRunId === testRunId) &&
        args.where?.projectId === testProjectId
      ) {
        return draftStore;
      }
      return null;
    }) as any;

    try {
      // 1. Initial coding produces draft before QA
      await upsertGenerationDraft({
        generationRunId: testRunId,
        projectId: testProjectId,
        files: capturedDraftFiles,
        validationStatus: DraftValidationStatus.UNVALIDATED,
        summary: "Pre-QA draft of bakery website",
        source: "canonical-sandbox-snapshot",
      });

      // 2. Generation fails (e.g. preview server crash or compiler error)
      // Draft remains in database under DraftValidationStatus.UNVALIDATED or FAILED

      // 3. Authorized project owner inspects draft
      const authorizedDraft = await getAuthorizedDraft({
        projectId: testProjectId,
        userId: testUserId,
        generationRunId: testRunId,
      });

      assert.ok(authorizedDraft);
      assert.equal(authorizedDraft.id, "draft-record-1");
      assert.equal(authorizedDraft.validationStatus, DraftValidationStatus.UNVALIDATED);
      const draftFiles = authorizedDraft.files as Record<string, string>;
      assert.equal(Object.keys(draftFiles).length, 3);
      assert.ok(draftFiles["app/page.tsx"]);

      // 4. Unauthorized attacker is strictly rejected: getAuthorizedDraft returns null
      const unauthorizedDraft = await getAuthorizedDraft({
        projectId: testProjectId,
        userId: "unauthorized-hacker-id",
        generationRunId: testRunId,
      });
      assert.equal(unauthorizedDraft, null, "Cross-user draft access must return null");

      // Cross-user ZIP export throws unauthorized
      await assert.rejects(
        async () => {
          await generateProjectZip({
            projectId: testProjectId,
            userId: "unauthorized-hacker-id",
            draftId: "draft-record-1",
          });
        },
        /Project not found or unauthorized/
      );

      // 5. Download draft ZIP
      const draftZipResult = await generateProjectZip({
        projectId: testProjectId,
        userId: testUserId,
        draftId: "draft-record-1",
      });

      assert.ok(draftZipResult.buffer instanceof Buffer);
      const zip = await JSZip.loadAsync(draftZipResult.buffer);
      const entryNames = Object.keys(zip.files);
      assert.ok(entryNames.some((e) => e.endsWith("app/page.tsx")));
      const pageKey = entryNames.find((e) => e.endsWith("app/page.tsx"))!;
      const extractedContent = await zip.file(pageKey)?.async("string");
      assert.ok(extractedContent?.includes("Draft"));
    } finally {
      prisma.project.findUnique = originalProjectFindUnique;
      prisma.generationDraft.upsert = originalDraftUpsert;
      prisma.generationDraft.findFirst = originalDraftFindFirst;
    }
  });
});
