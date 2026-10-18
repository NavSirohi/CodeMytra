import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import { inngest } from "../src/features/inngest/client";
import {
  createProjectRevision,
  resolveBaseRevision,
  restoreHistoricalRevision,
} from "../src/server/orchestration/revisions";
import {
  transitionRun,
  isValidTransition,
} from "../src/server/orchestration/state-machine";
import {
  dispatchOutboxEvent,
  recoverStaleOutboxEvents,
  MAX_OUTBOX_ATTEMPTS,
} from "../src/server/orchestration/outbox";
import { generateProjectZip } from "../src/server/export/zip-export";
import {
  GenerationRunStatus,
  OutboxStatus,
} from "../src/generated/prisma/client";
import JSZip from "jszip";

describe("M1.5 Comprehensive Integration: Generation, Modifications, Restoration & Authorization", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: First-Time Project Generation Lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  it("orchestrates initial generation: QUEUED -> RUNNING -> COMPLETED with Revision V1", async () => {
    const projectId = "proj-initial-test";
    const runId = "run-gen-001";
    const initialFiles = {
      "app/page.tsx": "export default function Page() { return <h1>CodeMytra V1</h1>; }",
      "package.json": JSON.stringify({ name: "codemytra-app", version: "0.1.0" }),
    };

    // 1. Verify initial base resolution returns null/undefined for brand new project
    const originalFindUnique = prisma.project.findUnique;
    const originalFindFirstRev = prisma.projectRevision.findFirst;
    const originalTx = prisma.$transaction;
    const originalUpdateRun = prisma.generationRun.update;
    const originalFindUniqueRun = prisma.generationRun.findUnique;

    prisma.project.findUnique = (async () => ({
      id: projectId,
      currentRevisionId: null,
    })) as any;

    prisma.projectRevision.findFirst = (async () => null) as any;

    try {
      const baseRev = await resolveBaseRevision(projectId, null);
      assert.equal(baseRev, null, "First generation must have no base revision");

      // 2. Validate state machine forward transitions from QUEUED
      assert.ok(isValidTransition(GenerationRunStatus.QUEUED, GenerationRunStatus.PLANNING));
      assert.ok(isValidTransition(GenerationRunStatus.PLANNING, GenerationRunStatus.DESIGNING));
      assert.ok(isValidTransition(GenerationRunStatus.DESIGNING, GenerationRunStatus.ARCHITECTING));
      assert.ok(isValidTransition(GenerationRunStatus.ARCHITECTING, GenerationRunStatus.RUNNING));
      assert.ok(isValidTransition(GenerationRunStatus.RUNNING, GenerationRunStatus.VALIDATING));
      assert.ok(isValidTransition(GenerationRunStatus.VALIDATING, GenerationRunStatus.COMPLETED));

      // 3. Persist Revision 1 with atomic revisionNumber = 1 and set currentRevisionId
      let capturedRevisionData: any = null;
      let capturedProjectUpdate: any = null;

      prisma.$transaction = (async (callback: any) => {
        const tx = {
          projectRevision: {
            findFirst: async () => null, // No prior revision
            create: async (args: any) => {
              capturedRevisionData = {
                id: "rev-001",
                ...args.data,
              };
              return capturedRevisionData;
            },
          },
          project: {
            update: async (args: any) => {
              capturedProjectUpdate = args;
              return { id: projectId, currentRevisionId: "rev-001" };
            },
            findUnique: async () => ({
              id: projectId,
              currentRevisionId: null,
            }),
          },
        };
        return callback(tx);
      }) as any;

      const createdRev = await createProjectRevision({
        projectId,
        generationRunId: runId,
        parentRevisionId: null,
        expectedCurrentRevisionId: null,
        title: "Initial Storefront",
        summary: "Created homepage and package.json",
        files: initialFiles,
      });

      assert.equal(createdRev.id, "rev-001");
      assert.equal(createdRev.revisionNumber, 1);
      assert.equal(createdRev.parentRevisionId, null);
      assert.equal(capturedProjectUpdate.data.currentRevisionId, "rev-001");

      // 4. Verify run transition to COMPLETED links resultRevisionId
      let runStatusState: GenerationRunStatus = GenerationRunStatus.VALIDATING;
      prisma.generationRun.findUnique = (async () => ({
        id: runId,
        status: runStatusState,
      })) as any;

      prisma.generationRun.update = (async (args: any) => {
        runStatusState = args.data.status;
        return { id: runId, ...args.data };
      }) as any;

      const runTransition = await transitionRun(runId, GenerationRunStatus.COMPLETED, {
        resultRevisionId: createdRev.id,
      });

      assert.equal(runTransition.success, true);
      assert.equal(runStatusState, GenerationRunStatus.COMPLETED);
    } finally {
      prisma.project.findUnique = originalFindUnique;
      prisma.projectRevision.findFirst = originalFindFirstRev;
      prisma.$transaction = originalTx;
      prisma.generationRun.update = originalUpdateRun;
      prisma.generationRun.findUnique = originalFindUniqueRun;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Follow-Up Modification on Existing Revision (V1 -> V2)
  // ─────────────────────────────────────────────────────────────────────────
  it("orchestrates follow-up prompt: links parentRevisionId V1, creates monotonic V2, updates pointer", async () => {
    const projectId = "proj-followup-test";
    const runId2 = "run-gen-002";
    const rev1Id = "rev-001";

    const v2Files = {
      "app/page.tsx": "export default function Page() { return <h1>CodeMytra V2 with Cart</h1>; }",
      "app/cart.tsx": "export function Cart() { return <div>Cart</div>; }",
      "package.json": JSON.stringify({ name: "codemytra-app", version: "0.2.0" }),
    };

    const originalFindUniqueProject = prisma.project.findUnique;
    const originalFindFirstRev = prisma.projectRevision.findFirst;
    const originalTx = prisma.$transaction;

    prisma.project.findUnique = (async () => ({
      id: projectId,
      currentRevisionId: rev1Id,
    })) as any;

    prisma.projectRevision.findFirst = (async (args: any) => {
      if (args?.where?.generationRunId) {
        return null;
      }
      return {
        id: rev1Id,
        projectId,
        revisionNumber: 1,
        files: { "app/page.tsx": "..." },
      };
    }) as any;

    try {
      // 1. Follow-up generation resolves the current project revision as base
      const baseRev = await resolveBaseRevision(projectId, rev1Id);
      assert.ok(baseRev);
      assert.equal(baseRev.id, rev1Id);
      assert.equal(baseRev.revisionNumber, 1);

      // 2. Persist Revision 2 with parentRevisionId = rev1Id and monotonic revisionNumber = 2
      let capturedRevisionData: any = null;
      let capturedProjectUpdate: any = null;

      prisma.$transaction = (async (callback: any) => {
        const tx = {
          projectRevision: {
            findFirst: async (args: any) => {
              if (args?.where?.generationRunId) {
                return null;
              }
              return {
                id: rev1Id,
                revisionNumber: 1,
              };
            },
            create: async (args: any) => {
              capturedRevisionData = {
                id: "rev-002",
                ...args.data,
              };
              return capturedRevisionData;
            },
          },
          project: {
            findUnique: async () => ({
              id: projectId,
              currentRevisionId: rev1Id,
            }),
            update: async (args: any) => {
              capturedProjectUpdate = args;
              return { id: projectId, currentRevisionId: "rev-002" };
            },
          },
        };
        return callback(tx);
      }) as any;

      const rev2 = await createProjectRevision({
        projectId,
        generationRunId: runId2,
        parentRevisionId: rev1Id,
        expectedCurrentRevisionId: rev1Id,
        title: "Added Cart Drawer",
        summary: "Implemented shopping cart in app/cart.tsx",
        files: v2Files,
      });

      assert.equal(rev2.id, "rev-002");
      assert.equal(rev2.revisionNumber, 2);
      assert.equal(rev2.parentRevisionId, rev1Id);
      assert.equal(capturedProjectUpdate.data.currentRevisionId, "rev-002");
    } finally {
      prisma.project.findUnique = originalFindUniqueProject;
      prisma.projectRevision.findFirst = originalFindFirstRev;
      prisma.$transaction = originalTx;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: Stale/Outdated Generation Race Guard
  // ─────────────────────────────────────────────────────────────────────────
  it("prevents an outdated generation run from overwriting a newer active revision pointer", async () => {
    const projectId = "proj-race-test";
    const slowRunId = "run-slow-999";

    const originalTx = prisma.$transaction;
    const originalFindFirstRev = prisma.projectRevision.findFirst;

    prisma.projectRevision.findFirst = (async () => null) as any;

    let projectPointerUpdated = false;

    prisma.$transaction = (async (callback: any) => {
      const tx = {
        projectRevision: {
          findFirst: async (args: any) => {
            if (args?.where?.generationRunId) {
              return null;
            }
            return {
              id: "rev-fast-002",
              revisionNumber: 2,
            };
          },
          create: async (args: any) => ({
            id: "rev-slow-003",
            ...args.data,
          }),
        },
        project: {
          findUnique: async () => ({
            id: projectId,
            // The project has already moved ahead to Revision 2!
            currentRevisionId: "rev-fast-002",
          }),
          update: async () => {
            projectPointerUpdated = true;
          },
        },
      };
      return callback(tx);
    }) as any;

    try {
      // Slow run expected project to still be at Revision 1 (rev-001)
      const slowRev = await createProjectRevision({
        projectId,
        generationRunId: slowRunId,
        parentRevisionId: "rev-001",
        expectedCurrentRevisionId: "rev-001", // Mismatch with rev-fast-002
        title: "Slow Generation Finished Late",
        summary: "Calculations took too long",
        files: { "app/page.tsx": "console.log('late')" },
      });

      // The revision itself IS persisted to preserve audit trail
      assert.equal(slowRev.id, "rev-slow-003");
      // But the project's active revision pointer was NOT overwritten!
      assert.equal(projectPointerUpdated, false, "Pointer must not be overwritten when expectedCurrentRevisionId mismatches");
    } finally {
      prisma.$transaction = originalTx;
      prisma.projectRevision.findFirst = originalFindFirstRev;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 4: Historical Revision Restoration
  // ─────────────────────────────────────────────────────────────────────────
  it("restores historical revision: creates new immutable revision V3 cloned from V1 without mutating V1", async () => {
    const projectId = "proj-restore-test";
    const userId = "user-owner-001";
    const targetRevId = "rev-001";

    const rev1Files = {
      "app/page.tsx": "export default function Page() { return <h1>Original Stable V1</h1>; }",
      "package.json": JSON.stringify({ name: "my-app" }),
    };

    const originalFindUniqueProject = prisma.project.findUnique;
    const originalFindFirstRev = prisma.projectRevision.findFirst;
    const originalTx = prisma.$transaction;

    prisma.project.findUnique = (async (args: any) => {
      if (args.where.id === projectId && args.where.userId === userId) {
        return { id: projectId, userId, currentRevisionId: "rev-002" };
      }
      return null;
    }) as any;

    prisma.projectRevision.findFirst = (async (args: any) => {
      if (args.where.id === targetRevId && args.where.projectId === projectId) {
        return {
          id: targetRevId,
          projectId,
          revisionNumber: 1,
          files: rev1Files,
        };
      }
      return null;
    }) as any;

    let capturedNewRevision: any = null;
    prisma.$transaction = (async (callback: any) => {
      const tx = {
        projectRevision: {
          findFirst: async () => ({
            id: "rev-002",
            revisionNumber: 2,
          }),
          create: async (args: any) => {
            capturedNewRevision = {
              id: "rev-003",
              ...args.data,
            };
            return capturedNewRevision;
          },
        },
        project: {
          findUnique: async () => ({
            id: projectId,
            currentRevisionId: "rev-002",
          }),
          update: async (args: any) => {
            return { id: projectId, currentRevisionId: args.data.currentRevisionId };
          },
        },
      };
      return callback(tx);
    }) as any;

    try {
      const restoredRev = await restoreHistoricalRevision(projectId, targetRevId, userId);

      assert.equal(restoredRev.id, "rev-003");
      assert.equal(restoredRev.revisionNumber, 3);
      assert.equal(restoredRev.parentRevisionId, targetRevId);
      assert.match(restoredRev.title, /Restored from V1/i);
      assert.deepEqual(restoredRev.files, rev1Files);

      // Verify authorization check fails for non-owner
      await assert.rejects(
        async () => {
          await restoreHistoricalRevision(projectId, targetRevId, "unauthorized-intruder");
        },
        /Project not found or unauthorized/
      );

      // Verify cross-project revision boundary check
      await assert.rejects(
        async () => {
          await restoreHistoricalRevision(projectId, "rev-foreign-999", userId);
        },
        /Target revision not found or does not belong to this project/
      );
    } finally {
      prisma.project.findUnique = originalFindUniqueProject;
      prisma.projectRevision.findFirst = originalFindFirstRev;
      prisma.$transaction = originalTx;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 5: Outbox Recovery Cycle
  // ─────────────────────────────────────────────────────────────────────────
  it("recovers stale outbox events atomically and enforces maximum retry limits", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;
    const originalUpdate = prisma.outboxEvent.update;

    const claimedEvents = [
      {
        id: "evt-stale-01",
        eventName: "code-agent/run",
        payload: {
          runId: "run-stale-01",
          projectId: "proj-stale-01",
          prompt: "Build dashboard",
          baseRevisionId: null,
        },
        status: OutboxStatus.PROCESSING,
        attempts: 2,
        lastError: null,
        createdAt: new Date(Date.now() - 360000),
        processedAt: null,
      },
    ];

    prisma.$queryRawUnsafe = (async () => claimedEvents) as any;
    const inngestDispatches: any[] = [];
    inngest.send = (async (item: any) => {
      inngestDispatches.push(item);
      return { ids: ["msg-outbox-rec"] };
    }) as any;

    const eventUpdates: any[] = [];
    prisma.outboxEvent.update = (async (args: any) => {
      eventUpdates.push(args);
      return args;
    }) as any;

    try {
      const summary = await recoverStaleOutboxEvents(300000, 10, 5);
      assert.equal(summary.total, 1);
      assert.equal(summary.recovered, 1);
      assert.equal(summary.failed, 0);

      assert.equal(inngestDispatches.length, 1);
      assert.equal(inngestDispatches[0].id, "run-run-stale-01");

      assert.equal(eventUpdates[0].data.status, OutboxStatus.PROCESSED);
      assert.ok(eventUpdates[0].data.processedAt instanceof Date);

      // Verify MAX_OUTBOX_ATTEMPTS bounds enforcement in single-dispatch
      const originalFindUnique = prisma.outboxEvent.findUnique;
      prisma.outboxEvent.findUnique = (async () => ({
        id: "evt-exhausted",
        status: OutboxStatus.FAILED,
        attempts: MAX_OUTBOX_ATTEMPTS,
      })) as any;

      let exhaustedStatusUpdate: any = null;
      prisma.outboxEvent.update = (async (args: any) => {
        exhaustedStatusUpdate = args;
        return args;
      }) as any;

      const singleDispatchResult = await dispatchOutboxEvent("evt-exhausted");
      assert.equal(singleDispatchResult.dispatched, false);
      assert.equal(singleDispatchResult.reason, "Max attempts exceeded");
      assert.equal(exhaustedStatusUpdate.data.status, OutboxStatus.FAILED);
      assert.match(exhaustedStatusUpdate.data.lastError, /Max outbox dispatch attempts/);

      prisma.outboxEvent.findUnique = originalFindUnique;
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
      prisma.outboxEvent.update = originalUpdate;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 6: Export Security & Authorization
  // ─────────────────────────────────────────────────────────────────────────
  it("enforces export authorization and generates clean zip with sanitized files", async () => {
    const projectId = "proj-export-auth-test";
    const ownerUserId = "user-legit-owner";
    const intruderUserId = "user-attacker";

    const originalFindUniqueProject = prisma.project.findUnique;
    const originalFindUniqueRevision = prisma.projectRevision.findUnique;

    prisma.project.findUnique = (async (args: any) => {
      if (args.where.id === projectId && args.where.userId === ownerUserId) {
        return {
          id: projectId,
          name: "portfolio-app",
          currentRevisionId: "rev-export-01",
        };
      }
      return null;
    }) as any;

    prisma.projectRevision.findUnique = (async () => ({
      id: "rev-export-01",
      projectId,
      revisionNumber: 1,
      files: {
        "app/page.tsx": "export default function Page() { return <h1>Portfolio</h1>; }",
        "../../etc/passwd": "malicious content",
        ".env": "SECRET_KEY=123",
      },
    })) as any;

    try {
      // 1. Intruder authorization rejection
      await assert.rejects(
        async () => {
          await generateProjectZip({
            projectId,
            userId: intruderUserId,
          });
        },
        /Project not found or unauthorized/
      );

      // 2. Legitimate owner export
      const exportResult = await generateProjectZip({
        projectId,
        userId: ownerUserId,
      });

      assert.equal(exportResult.filename, "codemytra-portfolio-app-v1.zip");
      assert.ok(exportResult.buffer.length > 0);
      assert.equal(exportResult.revisionNumber, 1);

      // 3. Inspect zip contents to ensure malicious/sensitive files were sanitized
      const zip = await JSZip.loadAsync(exportResult.buffer);
      const zipPaths = Object.keys(zip.files);

      assert.ok(zipPaths.includes("codemytra-portfolio-app-v1/app/page.tsx"));
      assert.ok(zipPaths.includes("codemytra-portfolio-app-v1/README.md"));

      // Zip Slip and .env must NEVER be present in the zip
      assert.ok(!zipPaths.some((p) => p.includes("etc/passwd")));
      assert.ok(!zipPaths.some((p) => p.includes(".env")));
    } finally {
      prisma.project.findUnique = originalFindUniqueProject;
      prisma.projectRevision.findUnique = originalFindUniqueRevision;
    }
  });
});
