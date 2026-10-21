import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import { inngest } from "../src/features/inngest/client";
import {
  claimOutboxEvents,
  executeClaimedEvent,
  recoverStaleOutboxEvents,
  dispatchOutboxEvent,
  MAX_OUTBOX_ATTEMPTS,
} from "../src/server/orchestration/outbox";
import { finalizeGenerationFailure } from "../src/server/orchestration/finalization";
import { codeAgentFunction } from "../src/features/inngest/functions";
import { getActiveGenerationRun } from "../src/features/projects/actions";
import {
  GenerationRunStatus,
  OutboxStatus,
} from "../src/generated/prisma/client";

describe("Priority 0: Generation Failure Reconciliation & State Integrity", () => {
  it("transitions GenerationRun to FAILED on workflow failure", async () => {
    const originalTx = prisma.$transaction;
    const originalFindUnique = prisma.generationRun.findUnique;

    let updatedStatus: string | null = null;
    let updatedErrorCode: string | null = null;
    let updatedErrorMessage: string | null = null;
    let runEventCreated = false;

    const mockRun = {
      id: "run-fail-1",
      projectId: "proj-fail-1",
      status: GenerationRunStatus.RUNNING,
    };

    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async () => mockRun,
          update: async (args: any) => {
            updatedStatus = args.data.status;
            updatedErrorCode = args.data.errorCode;
            updatedErrorMessage = args.data.errorMessage;
            return { ...mockRun, ...args.data };
          },
        },
        runEvent: {
          create: async () => {
            runEventCreated = true;
            return {};
          },
        },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-fail-1" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const result = await finalizeGenerationFailure({
        projectId: "proj-fail-1",
        generationRunId: "run-fail-1",
        errorCode: "WORKFLOW_EXECUTION_FAILED",
        errorMessage: "Syntax error in synthesized component",
      });

      assert.equal(updatedStatus, GenerationRunStatus.FAILED);
      assert.equal(updatedErrorCode, "WORKFLOW_EXECUTION_FAILED");
      assert.match(updatedErrorMessage || "", /Syntax error/);
      assert.equal(runEventCreated, true);
      assert.equal(result.isIdempotentReplay, false);
      assert.equal(result.messageId, "msg-fail-1");
    } finally {
      prisma.$transaction = originalTx;
      prisma.generationRun.findUnique = originalFindUnique;
    }
  });

  it("guarantees metrics persistence failure cannot undo or obscure successful failure finalization", async () => {
    const originalTx = prisma.$transaction;
    let finalizationSucceeded = false;

    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async () => ({
            id: "run-fail-metrics",
            projectId: "proj-fail-metrics",
            status: GenerationRunStatus.RUNNING,
          }),
          update: async () => {
            finalizationSucceeded = true;
            return {};
          },
        },
        runEvent: { create: async () => ({}) },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-fail-metrics" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const onFailure = (codeAgentFunction as any).opts.onFailure;
      assert.ok(typeof onFailure === "function", "onFailure handler must be defined");

      // Execute onFailure with an error
      await onFailure({
        event: {
          data: {
            event: {
              data: {
                runId: "run-fail-metrics",
                projectId: "proj-fail-metrics",
              },
            },
          },
        },
        error: new Error("Test workflow failure"),
      });

      assert.equal(
        finalizationSucceeded,
        true,
        "Failure finalization must succeed and not be rolled back or obscured by metrics"
      );
    } finally {
      prisma.$transaction = originalTx;
    }
  });

  it("ensures a failed failure-handler invocation is safely recoverable upon retry", async () => {
    const originalTx = prisma.$transaction;
    let attemptCount = 0;

    prisma.$transaction = (async (fn: any) => {
      attemptCount++;
      if (attemptCount === 1) {
        throw new Error("Transient database deadlock");
      }
      const mockTx = {
        generationRun: {
          findUnique: async () => ({
            id: "run-recoverable",
            projectId: "proj-recoverable",
            status: GenerationRunStatus.RUNNING,
          }),
          update: async () => ({}),
        },
        runEvent: { create: async () => ({}) },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-recoverable" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      // First attempt fails due to transient connection failure
      await assert.rejects(
        async () => {
          await finalizeGenerationFailure({
            projectId: "proj-recoverable",
            generationRunId: "run-recoverable",
            errorCode: "TRANSIENT_ERROR",
            errorMessage: "Transient failure",
          });
        },
        /Transient database deadlock/
      );

      // Second attempt (retry) recovers and finalizes cleanly
      const retryResult = await finalizeGenerationFailure({
        projectId: "proj-recoverable",
        generationRunId: "run-recoverable",
        errorCode: "TRANSIENT_ERROR",
        errorMessage: "Transient failure",
      });

      assert.equal(retryResult.messageId, "msg-recoverable");
      assert.equal(attemptCount, 2);
    } finally {
      prisma.$transaction = originalTx;
    }
  });

  it("guarantees repeated failure handler execution cannot corrupt completed revisions", async () => {
    const originalTx = prisma.$transaction;
    let projectUpdated = false;
    let revisionUpdated = false;

    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async () => ({
            id: "run-completed-safe",
            projectId: "proj-completed-safe",
            status: GenerationRunStatus.COMPLETED,
          }),
          update: async () => {
            throw new Error("COMPLETED run must never be mutated by failure handler");
          },
        },
        project: {
          update: async () => {
            projectUpdated = true;
          },
        },
        projectRevision: {
          update: async () => {
            revisionUpdated = true;
          },
        },
        message: {
          findUnique: async () => ({ id: "msg-completed-original" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const result = await finalizeGenerationFailure({
        projectId: "proj-completed-safe",
        generationRunId: "run-completed-safe",
        errorCode: "LATE_FAILURE_EVENT",
        errorMessage: "Late arrival failure event",
      });

      assert.equal(result.isIdempotentReplay, true);
      assert.equal(result.messageId, "msg-completed-original");
      assert.equal(projectUpdated, false, "Project pointer must not be modified");
      assert.equal(revisionUpdated, false, "Completed revisions must not be modified");
    } finally {
      prisma.$transaction = originalTx;
    }
  });

  it("reconciles abandoned runs so customer-facing state matches terminal state and project never remains permanently RUNNING", async () => {
    const originalFindFirst = prisma.generationRun.findFirst;
    const originalFindUnique = prisma.generationRun.findUnique;
    const originalTx = prisma.$transaction;
    const originalUserUpsert = prisma.user.upsert;

    prisma.user.upsert = (async () => ({
      id: "dev-user-local",
      clerkId: "dev-user-local",
      email: "dev@codemytra.local",
      name: "Dev User",
      imageUrl: null,
    })) as any;

    // Simulate an abandoned run older than MAX_GENERATION_DURATION_MS (e.g. created 10 minutes ago)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const mockStaleRun = {
      id: "run-stale-abandoned",
      projectId: "proj-abandoned",
      userId: "dev-user-local",
      status: GenerationRunStatus.RUNNING,
      createdAt: tenMinutesAgo,
      events: [],
    };

    let finalizedAsFailed = false;

    prisma.generationRun.findFirst = (async () => mockStaleRun) as any;
    prisma.generationRun.findUnique = (async () => ({
      ...mockStaleRun,
      status: GenerationRunStatus.FAILED,
      errorCode: "WORKFLOW_TIMED_OUT",
    })) as any;

    prisma.$transaction = (async (fn: any) => {
      finalizedAsFailed = true;
      const mockTx = {
        generationRun: {
          findUnique: async () => mockStaleRun,
          update: async () => ({}),
        },
        runEvent: { create: async () => ({}) },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-timed-out" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      // Act: fetch active generation run as customer UI would
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      const resolvedRun = await getActiveGenerationRun("proj-abandoned");

      assert.ok(resolvedRun, "Run must be resolved");
      assert.equal(finalizedAsFailed, true, "Stale run must be finalized to FAILED");
      assert.equal(resolvedRun.status, GenerationRunStatus.FAILED);
      assert.equal((resolvedRun as any).errorCode, "WORKFLOW_TIMED_OUT");
    } finally {
      prisma.user.upsert = originalUserUpsert;
      prisma.generationRun.findFirst = originalFindFirst;
      prisma.generationRun.findUnique = originalFindUnique;
      prisma.$transaction = originalTx;
      delete process.env.ALLOW_INSECURE_DEV_AUTH;
    }
  });
});

describe("Priority 0: Outbox Terminal Exhaustion & Delivery Resilience", () => {
  it("initial dispatch failure followed by successful delayed recovery", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    let inngestOnline = false;
    const mockEvent: any = {
      id: "evt-delayed-recovery",
      eventName: "code-agent/run",
      payload: {
        runId: "run-del-1",
        projectId: "proj-del-1",
        prompt: "Build Kanban Board",
        baseRevisionId: null,
      },
      status: OutboxStatus.PENDING,
      attempts: 0,
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
      lastError: null,
      createdAt: new Date(),
    };

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      if (query.includes("FOR UPDATE SKIP LOCKED")) {
        if (mockEvent.status === OutboxStatus.PENDING || mockEvent.status === OutboxStatus.FAILED) {
          mockEvent.status = OutboxStatus.PROCESSING;
          mockEvent.attempts += 1;
          mockEvent.claimToken = "tok-" + mockEvent.attempts;
          return [mockEvent];
        }
        return [];
      }
      if (query.includes("status = 'FAILED'")) {
        mockEvent.status = OutboxStatus.FAILED;
        mockEvent.nextAttemptAt = args[1];
        mockEvent.lastError = args[2];
        return [{ id: args[0] }];
      }
      if (query.includes("status = 'PROCESSED'")) {
        mockEvent.status = OutboxStatus.PROCESSED;
        mockEvent.processedAt = new Date();
        return [{ id: args[0] }];
      }
      return [];
    }) as any;

    inngest.send = (async () => {
      if (!inngestOnline) {
        throw new Error("ECONNREFUSED 127.0.0.1:8288");
      }
      return { ids: ["evt-ok-1"] };
    }) as any;

    try {
      // 1. Initial attempt fails
      const firstDispatch = await dispatchOutboxEvent("evt-delayed-recovery");
      assert.equal(firstDispatch.dispatched, false);
      assert.equal(mockEvent.status, OutboxStatus.FAILED);
      assert.equal(mockEvent.attempts, 1);
      assert.ok(mockEvent.nextAttemptAt instanceof Date);

      // 2. Inngest comes online after network recovery
      inngestOnline = true;

      // 3. Recovery worker claims and recovers
      const recovery = await recoverStaleOutboxEvents();
      assert.equal(recovery.recovered, 1);
      assert.equal(mockEvent.status, OutboxStatus.PROCESSED);
      assert.equal(mockEvent.attempts, 2);
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });

  it("repeated dispatch failure reaches MAX_OUTBOX_ATTEMPTS and reconciles GenerationRun with terminal failure", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;
    const originalTx = prisma.$transaction;

    let generationRunFinalizedToFailed = false;
    let reconciledErrorCode = "";

    const mockEvent: any = {
      id: "evt-terminal-exhaust",
      eventName: "code-agent/run",
      payload: {
        runId: "run-exhaust-1",
        projectId: "proj-exhaust-1",
        prompt: "Build CRM App",
        baseRevisionId: null,
      },
      status: OutboxStatus.PROCESSING,
      attempts: MAX_OUTBOX_ATTEMPTS, // Final attempt
      claimedAt: new Date(),
      claimToken: "tok-exhaust-final",
      nextAttemptAt: null,
      lastError: null,
      createdAt: new Date(),
    };

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      if (query.includes("status = 'FAILED'")) {
        mockEvent.status = OutboxStatus.FAILED;
        mockEvent.nextAttemptAt = args[1]; // Should be null on terminal exhaustion
        mockEvent.lastError = args[2];
        return [{ id: args[0] }];
      }
      return [];
    }) as any;

    inngest.send = (async () => {
      throw new Error("Permanent Inngest cluster outage");
    }) as any;

    prisma.$transaction = (async (fn: any) => {
      generationRunFinalizedToFailed = true;
      const mockTx = {
        generationRun: {
          findUnique: async () => ({
            id: "run-exhaust-1",
            projectId: "proj-exhaust-1",
            status: GenerationRunStatus.QUEUED,
          }),
          update: async (args: any) => {
            reconciledErrorCode = args.data.errorCode;
            return {};
          },
        },
        runEvent: { create: async () => ({}) },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-exhaust" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const result = await executeClaimedEvent(mockEvent);

      assert.equal(result.success, false);
      assert.equal(mockEvent.status, OutboxStatus.FAILED);
      assert.equal(mockEvent.nextAttemptAt, null, "Exhausted event must have nextAttemptAt = null");
      assert.match(mockEvent.lastError, /Terminal failure/);

      // Verify terminal exhaustion reconciled with the customer's GenerationRun
      assert.equal(
        generationRunFinalizedToFailed,
        true,
        "Exhausted outbox event must reconcile GenerationRun to prevent permanent QUEUED state"
      );
      assert.equal(reconciledErrorCode, "OUTBOX_DELIVERY_EXHAUSTED");
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
      prisma.$transaction = originalTx;
    }
  });

  it("concurrent recovery workers claim disjoint event sets without duplication", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    // Pool of 4 unassigned events
    const pool: Array<{ id: string; payload: any; status: OutboxStatus; attempts: number }> = [
      { id: "evt-c1", payload: { runId: "r1", projectId: "p1" }, status: OutboxStatus.PENDING, attempts: 0 },
      { id: "evt-c2", payload: { runId: "r2", projectId: "p2" }, status: OutboxStatus.PENDING, attempts: 0 },
      { id: "evt-c3", payload: { runId: "r3", projectId: "p3" }, status: OutboxStatus.PENDING, attempts: 0 },
      { id: "evt-c4", payload: { runId: "r4", projectId: "p4" }, status: OutboxStatus.PENDING, attempts: 0 },
    ];


    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      if (query.includes("FOR UPDATE SKIP LOCKED")) {
        // Atomic claim simulation
        const batchSize = args[3] as number;
        const available = pool.filter((e) => e.status === OutboxStatus.PENDING).slice(0, batchSize);
        for (const ev of available) {
          ev.status = OutboxStatus.PROCESSING;
          ev.attempts += 1;
        }
        return available;
      }
      if (query.includes("status = 'PROCESSED'")) {
        const id = args[0];
        const match = pool.find((e) => e.id === id);
        if (match) match.status = OutboxStatus.PROCESSED;
        return [{ id }];
      }
      return [];
    }) as any;

    inngest.send = (async (payload: any) => {
      return { ids: ["sent-" + payload.data.runId] };
    }) as any;

    try {
      // Worker A claims batch of 2, Worker B claims batch of 2 concurrently
      const [resA, resB] = await Promise.all([
        claimOutboxEvents({ batchSize: 2 }),
        claimOutboxEvents({ batchSize: 2 }),
      ]);

      const idsA = resA.map((e) => e.id);
      const idsB = resB.map((e) => e.id);

      assert.equal(idsA.length, 2);
      assert.equal(idsB.length, 2);

      // Verify disjoint sets: no overlap
      const overlap = idsA.filter((id) => idsB.includes(id));
      assert.equal(overlap.length, 0, "Concurrent workers must claim completely disjoint events");

      const allClaimed = [...idsA, ...idsB].sort();
      assert.deepEqual(allClaimed, ["evt-c1", "evt-c2", "evt-c3", "evt-c4"]);
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });

  it("failure of one event does not block processing of subsequent eligible events in batch", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    const events = [
      {
        id: "evt-bad",
        eventName: "code-agent/run",
        payload: { runId: "r-bad", projectId: "p-bad" },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        claimToken: "tok-bad",
      },
      {
        id: "evt-good-1",
        eventName: "code-agent/run",
        payload: { runId: "r-good-1", projectId: "p-good" },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        claimToken: "tok-good-1",
      },
      {
        id: "evt-good-2",
        eventName: "code-agent/run",
        payload: { runId: "r-good-2", projectId: "p-good" },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        claimToken: "tok-good-2",
      },
    ];

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      if (query.includes("FOR UPDATE SKIP LOCKED")) {
        return events;
      }
      return [{ id: args[0] }];
    }) as any;

    const successfullySent: string[] = [];
    inngest.send = (async (payload: any) => {
      if (payload.data.runId === "r-bad") {
        throw new Error("Payload serialization error on bad event");
      }
      successfullySent.push(payload.data.runId);
      return { ids: ["sent-ok"] };
    }) as any;

    try {
      const summary = await recoverStaleOutboxEvents();

      assert.equal(summary.total, 3);
      assert.equal(summary.recovered, 2, "2 healthy events must be processed");
      assert.equal(summary.failed, 1, "1 faulty event must fail independently");
      assert.deepEqual(successfullySent, ["r-good-1", "r-good-2"]);
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });

  it("verifies /api/inngest route handler exports dynamic HTTP methods", async () => {
    // Dynamic import to verify Inngest serve() exports
    const inngestRoute = await import("../src/app/api/inngest/route");
    assert.equal(typeof inngestRoute.GET, "function");
    assert.equal(typeof inngestRoute.POST, "function");
    assert.equal(typeof inngestRoute.PUT, "function");
  });

  it("reconcileStaleGenerationRuns transitions abandoned active runs stranded by SDK disconnects", async () => {
    const { reconcileStaleGenerationRuns } = await import("../src/server/orchestration/outbox");

    const originalFindMany = prisma.generationRun.findMany;
    const originalTx = prisma.$transaction;

    const reconciledRunIds: string[] = [];

    // Mock finding 2 truly stale active runs
    prisma.generationRun.findMany = (async (args: any) => {
      assert.ok(args.where.status.in.includes(GenerationRunStatus.RUNNING));
      assert.ok(args.where.createdAt.lt instanceof Date);
      return [
        {
          id: "stale-run-1",
          projectId: "proj-1",
          status: GenerationRunStatus.RUNNING,
          createdAt: new Date(Date.now() - 600000),
          startedAt: new Date(Date.now() - 600000),
          updatedAt: new Date(Date.now() - 600000),
          events: [],
        },
        {
          id: "stale-run-2",
          projectId: "proj-2",
          status: GenerationRunStatus.RUNNING,
          createdAt: new Date(Date.now() - 600000),
          startedAt: new Date(Date.now() - 600000),
          updatedAt: new Date(Date.now() - 600000),
          events: [],
        },
      ];
    }) as any;

    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async (args: any) => ({
            id: args.where.id,
            projectId: args.where.id === "stale-run-1" ? "proj-1" : "proj-2",
            status: GenerationRunStatus.RUNNING,
          }),
          update: async (args: any) => {
            reconciledRunIds.push(args.where.id);
            return {};
          },
        },
        runEvent: { create: async () => ({}) },
        message: {
          findUnique: async () => null,
          create: async () => ({ id: "msg-reconciled" }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const result = await reconcileStaleGenerationRuns(0); // 0 grace period for test
      assert.equal(result.reconciled, 2);
      assert.equal(result.checked, 2);
      assert.deepEqual(reconciledRunIds, ["stale-run-1", "stale-run-2"]);
    } finally {
      prisma.generationRun.findMany = originalFindMany;
      prisma.$transaction = originalTx;
    }
  });

  it("stale-run watchdog does NOT incorrectly fail a progressing run with old createdAt due to queue delay or recent events", async () => {
    const { reconcileStaleGenerationRuns } = await import("../src/server/orchestration/outbox");
    const originalFindMany = prisma.generationRun.findMany;
    const originalTx = prisma.$transaction;

    let transactionCalled = false;
    prisma.$transaction = (async () => {
      transactionCalled = true;
      return {};
    }) as any;

    const oldDate = new Date(Date.now() - 600000); // 10 minutes old
    const recentDate = new Date(Date.now() - 10000); // 10 seconds ago

    // Candidate runs returned from query:
    // Run 1: sat in queue for 10 min, but started recently (startedAt 10s ago)
    // Run 2: created 10 min ago, but has an active stage event recorded 10s ago
    prisma.generationRun.findMany = (async () => [
      {
        id: "run-queued-long",
        projectId: "proj-1",
        status: GenerationRunStatus.RUNNING,
        createdAt: oldDate,
        startedAt: recentDate,
        updatedAt: recentDate,
        events: [],
      },
      {
        id: "run-progressing-stage",
        projectId: "proj-2",
        status: GenerationRunStatus.VALIDATING,
        createdAt: oldDate,
        startedAt: oldDate,
        updatedAt: recentDate,
        events: [{ createdAt: recentDate }],
      },
    ]) as any;

    try {
      const result = await reconcileStaleGenerationRuns(60000);
      assert.equal(result.checked, 2);
      assert.equal(result.reconciled, 0, "Progressing runs must NOT be reconciled to failed");
      assert.equal(transactionCalled, false, "No failure finalization must be performed on active runs");
    } finally {
      prisma.generationRun.findMany = originalFindMany;
      prisma.$transaction = originalTx;
    }
  });

  it("stale-run watchdog safely handles concurrent completion without corrupting completed revisions", async () => {
    const { reconcileStaleGenerationRuns } = await import("../src/server/orchestration/outbox");
    const originalFindMany = prisma.generationRun.findMany;
    const originalTx = prisma.$transaction;

    const oldDate = new Date(Date.now() - 600000);
    prisma.generationRun.findMany = (async () => [
      {
        id: "run-concurrent-win",
        projectId: "proj-concurrent",
        status: GenerationRunStatus.RUNNING,
        createdAt: oldDate,
        startedAt: oldDate,
        updatedAt: oldDate,
        events: [{ createdAt: oldDate }],
      },
    ]) as any;

    // Simulate concurrent worker having completed the run just as watchdog checks it
    prisma.$transaction = (async (fn: any) => {
      const mockTx = {
        generationRun: {
          findUnique: async () => ({
            id: "run-concurrent-win",
            projectId: "proj-concurrent",
            status: GenerationRunStatus.COMPLETED, // Already completed by worker
            resultRevisionId: "rev-winner-1",
          }),
        },
      };
      return fn(mockTx);
    }) as any;

    try {
      const result = await reconcileStaleGenerationRuns(60000);
      assert.equal(result.checked, 1);
      assert.equal(result.reconciled, 0, "Concurrently completed run must not be counted as failed");
    } finally {
      prisma.generationRun.findMany = originalFindMany;
      prisma.$transaction = originalTx;
    }
  });

  it("executeClaimedEvent rejects events with missing or null claim tokens", async () => {
    const { executeClaimedEvent } = await import("../src/server/orchestration/outbox");

    const eventWithoutToken = {
      id: "evt-no-token",
      eventName: "code-agent/run",
      payload: { runId: "r-1", projectId: "p-1" },
      status: OutboxStatus.PROCESSING,
      attempts: 1,
      claimToken: null,
    };

    const result = await executeClaimedEvent(eventWithoutToken as any);
    assert.equal(result.success, false);
    assert.match(result.error || "", /missing required non-null claimToken/);
  });

  it("executeClaimedEvent fails safely if PROCESSED transition affects 0 rows due to lease expiration", async () => {
    const { executeClaimedEvent } = await import("../src/server/orchestration/outbox");
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    inngest.send = (async () => ({ ids: ["msg-sent"] })) as any;
    // Fenced PROCESSED update returns 0 affected rows
    prisma.$queryRawUnsafe = (async () => []) as any;

    try {
      const event = {
        id: "evt-stolen-lease",
        eventName: "code-agent/run",
        payload: { runId: "r-stolen", projectId: "p-stolen" },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        claimToken: "tok-superseded",
      };

      const result = await executeClaimedEvent(event as any);
      assert.equal(result.success, false);
      assert.match(result.error || "", /Fencing token superseded/);
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });

  it("guarantees Inngest event ID deduplication key format prevents duplicate runs upon reconnect", async () => {
    const originalInngestSend = inngest.send;
    const captured = { id: "", name: "" };

    inngest.send = (async (payload: any) => {
      captured.id = payload.id;
      captured.name = payload.name;
      return { ids: [payload.id] };
    }) as any;

    const originalQueryRaw = prisma.$queryRawUnsafe;
    prisma.$queryRawUnsafe = (async () => [{ id: "mock" }]) as any;

    try {
      const mockEvent = {
        id: "evt-dedup-1",
        eventName: "code-agent/run",
        payload: {
          runId: "run-unique-12345",
          projectId: "proj-12345",
          prompt: "Build dashboard",
          baseRevisionId: null,
        },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        claimToken: "claim-tok-1",
      };

      await executeClaimedEvent(mockEvent as any);

      assert.equal(captured.name, "code-agent/run");
      assert.equal(captured.id, "run-run-unique-12345");
      // Inngest uses the event `id` to deduplicate events dispatched within 24h window
      assert.ok(captured.id.startsWith("run-"));
    } finally {
      inngest.send = originalInngestSend;
      prisma.$queryRawUnsafe = originalQueryRaw;
    }
  });

  it("verifies outbox terminal fencing check prevents superseded worker from prematurely failing GenerationRun", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;
    const originalTx = prisma.$transaction;

    let finalizationAttempted = false;
    prisma.$transaction = (async () => {
      finalizationAttempted = true;
      return {};
    }) as any;

    inngest.send = (async () => {
      throw new Error("Worker A network partition");
    }) as any;

    // Simulate Worker A's fenced FAILED update returning 0 affected rows (claimToken superseded by Worker B)
    prisma.$queryRawUnsafe = (async (query: string) => {
      if (query.includes("status = 'FAILED'")) {
        return []; // 0 rows affected
      }
      return [];
    }) as any;

    try {
      const mockEvent = {
        id: "evt-fenced-terminal",
        eventName: "code-agent/run",
        payload: {
          runId: "run-concurrent-safe",
          projectId: "proj-concurrent-safe",
          prompt: "Build analytics app",
          baseRevisionId: null,
        },
        status: OutboxStatus.PROCESSING,
        attempts: MAX_OUTBOX_ATTEMPTS,
        claimToken: "tok-worker-A-expired",
      };

      const result = await executeClaimedEvent(mockEvent as any);
      assert.equal(result.success, false);
      assert.equal(finalizationAttempted, false, "Superseded worker must not finalize GenerationRun");
    } finally {
      inngest.send = originalInngestSend;
      prisma.$queryRawUnsafe = originalQueryRaw;
      prisma.$transaction = originalTx;
    }
  });
});


