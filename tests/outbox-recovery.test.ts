import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db";
import { inngest } from "../src/features/inngest/client";
import {
  recoverStaleOutboxEvents,
  MAX_OUTBOX_ATTEMPTS,
} from "../src/server/orchestration/outbox";
import { outboxRecoveryFunction } from "../src/features/inngest/outbox-recovery";
import { OutboxStatus } from "../src/generated/prisma/client";

describe("Outbox Recovery Worker with Atomic Claiming", () => {
  it("executes unified atomic query with FOR UPDATE SKIP LOCKED, claimedAt lease, and nextAttemptAt", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    let capturedQuery = "";
    let capturedArgs: any[] = [];

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      capturedQuery = query;
      capturedArgs = args;
      return [];
    }) as any;

    try {
      const beforeTime = Date.now();
      const result = await recoverStaleOutboxEvents(120000, 25);

      // Verify query has atomic claiming with SKIP LOCKED and lease tracking
      assert.match(capturedQuery, /UPDATE\s+"OutboxEvent"/i);
      assert.match(capturedQuery, /SET\s+status\s*=\s*'PROCESSING',\s*attempts\s*=\s*attempts\s*\+\s*1,\s*"claimedAt"\s*=\s*NOW\(\),\s*"claimToken"\s*=/i);
      assert.match(capturedQuery, /FOR UPDATE SKIP LOCKED/i);
      assert.match(capturedQuery, /nextAttemptAt/i);
      assert.match(capturedQuery, /claimedAt/i);
      assert.match(capturedQuery, /claimToken/i);

      // Verify parameters passed: [eventId (null), MAX_OUTBOX_ATTEMPTS, leaseCutoff, batchSize]
      assert.equal(capturedArgs.length, 4);
      assert.equal(capturedArgs[0], null); // eventId null for batch recovery
      assert.equal(capturedArgs[1], MAX_OUTBOX_ATTEMPTS);
      const cutoff = capturedArgs[2] as Date;
      assert.ok(cutoff instanceof Date);
      assert.ok(cutoff.getTime() <= beforeTime - 120000 + 100);
      assert.equal(capturedArgs[3], 25); // batchSize

      assert.deepEqual(result, { total: 0, recovered: 0, failed: 0 });
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
    }
  });

  it("dispatches claimed events via inngest.send and marks PROCESSED with fencing token", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    const mockClaimedAt = new Date();
    const mockEvents = [
      {
        id: "evt-1",
        eventName: "code-agent/run",
        payload: {
          runId: "101",
          projectId: "proj-1",
          prompt: "Build an inventory app",
          baseRevisionId: null,
        },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        lastError: null,
        claimedAt: mockClaimedAt,
        nextAttemptAt: null,
        claimToken: "tok-test-1",
        createdAt: new Date(Date.now() - 400000),
        processedAt: null,
      },
      {
        id: "evt-2",
        eventName: "code-agent/run",
        payload: JSON.stringify({
          runId: "102",
          projectId: "proj-2",
          prompt: "Build a todo app",
          baseRevisionId: "rev-1",
        }),
        status: OutboxStatus.PROCESSING,
        attempts: 2,
        lastError: "Temporary timeout",
        claimedAt: mockClaimedAt,
        nextAttemptAt: null,
        claimToken: "tok-test-2",
        createdAt: new Date(Date.now() - 200000),
        processedAt: null,
      },
    ];

    const inngestCalls: any[] = [];
    const queryCalls: { query: string; args: any[] }[] = [];

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      queryCalls.push({ query, args });
      // First call is claim query
      if (query.includes("FOR UPDATE SKIP LOCKED")) {
        return mockEvents;
      }
      // Follow-up calls are status updates
      return [{ id: args[0] }];
    }) as unknown as typeof prisma.$queryRawUnsafe;

    inngest.send = (async (payload: any) => {
      inngestCalls.push(payload);
      return { ids: ["msg-1"] };
    }) as any;

    try {
      const result = await recoverStaleOutboxEvents();

      assert.equal(result.total, 2);
      assert.equal(result.recovered, 2);
      assert.equal(result.failed, 0);

      assert.equal(inngestCalls.length, 2);
      assert.equal(inngestCalls[0].name, "code-agent/run");
      assert.equal(inngestCalls[0].id, "run-101");
      assert.equal(inngestCalls[0].data.projectId, "proj-1");

      assert.equal(inngestCalls[1].name, "code-agent/run");
      assert.equal(inngestCalls[1].id, "run-102");
      assert.equal(inngestCalls[1].data.baseRevisionId, "rev-1");

      // Verify fencing token in update query
      const updateCalls = queryCalls.filter((c) => c.query.includes("status = 'PROCESSED'"));
      assert.equal(updateCalls.length, 2);
      assert.match(updateCalls[0].query, /claimToken/);
      assert.equal(updateCalls[0].args[0], "evt-1");
      assert.equal(updateCalls[0].args[1], "tok-test-1");
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });

  it("handles dispatch failure gracefully, applies retry backoff, and marks FAILED with fencing token", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    const mockClaimedAt = new Date();
    const mockEvents = [
      {
        id: "evt-failed",
        eventName: "code-agent/run",
        payload: {
          runId: "run-failed",
          projectId: "proj-err",
          prompt: "Error trigger prompt",
          baseRevisionId: null,
        },
        status: OutboxStatus.PROCESSING,
        attempts: 1,
        lastError: null,
        claimedAt: mockClaimedAt,
        nextAttemptAt: null,
        claimToken: "tok-fail",
        createdAt: new Date(),
        processedAt: null,
      },
    ];

    const queryCalls: { query: string; args: any[] }[] = [];

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      queryCalls.push({ query, args });
      if (query.includes("FOR UPDATE SKIP LOCKED")) {
        return mockEvents;
      }
      return [{ id: args[0] }];
    }) as unknown as typeof prisma.$queryRawUnsafe;

    inngest.send = (async () => {
      throw new Error("Inngest endpoint down");
    }) as any;

    try {
      const result = await recoverStaleOutboxEvents();

      assert.equal(result.total, 1);
      assert.equal(result.recovered, 0);
      assert.equal(result.failed, 1);

      const failUpdate = queryCalls.find((c) => c.query.includes("status = 'FAILED',"));
      assert.ok(failUpdate);
      assert.equal(failUpdate.args[0], "evt-failed");
      assert.ok(failUpdate.args[1] instanceof Date, "nextAttemptAt must be set for retry backoff");
      assert.equal(failUpdate.args[2], "Inngest endpoint down");
      assert.equal(failUpdate.args[3], "tok-fail");
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });

  it("configures scheduled Inngest cron function correctly", () => {
    assert.ok(outboxRecoveryFunction && typeof outboxRecoveryFunction === "object");
    const opts = (outboxRecoveryFunction as any).opts;
    assert.equal(opts.id, "outbox-recovery");
    assert.deepEqual(opts.triggers, [{ cron: "*/5 * * * *" }]);
  });

  it("regression: initial dispatch failure (fetch failed) transitions event to FAILED, then recovery worker successfully claims and delivers", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;

    let inngestAvailable = false;
    const queryCalls: { query: string; args: any[] }[] = [];
    const inngestDispatched: any[] = [];

    // State of the synthetic database event
    const currentEvent: any = {
      id: "evt-network-failure",
      eventName: "code-agent/run",
      payload: {
        runId: "run-e2e-recovery",
        projectId: "proj-e2e",
        prompt: "Build SaaS marketing page",
        baseRevisionId: null,
      },
      status: OutboxStatus.PENDING,
      attempts: 0,
      lastError: null,
      claimedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      createdAt: new Date(),
      processedAt: null,
    };

    prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
      queryCalls.push({ query, args });

      // Claim query (FOR UPDATE SKIP LOCKED)
      if (query.includes("FOR UPDATE SKIP LOCKED")) {
        // Can be claimed if PENDING or FAILED and attempts < max
        if (currentEvent.status === OutboxStatus.PENDING || currentEvent.status === OutboxStatus.FAILED) {
          currentEvent.status = OutboxStatus.PROCESSING;
          currentEvent.attempts += 1;
          currentEvent.claimedAt = new Date();
          currentEvent.claimToken = "claim-tok-e2e-" + currentEvent.attempts;
          return [currentEvent];
        }
        return [];
      }

      // Mark PROCESSED
      if (query.includes("status = 'PROCESSED'")) {
        currentEvent.status = OutboxStatus.PROCESSED;
        currentEvent.processedAt = new Date();
        currentEvent.claimToken = null;
        currentEvent.claimedAt = null;
        return [{ id: args[0] }];
      }

      // Mark FAILED
      if (query.includes("status = 'FAILED'")) {
        currentEvent.status = OutboxStatus.FAILED;
        currentEvent.nextAttemptAt = args[1];
        currentEvent.lastError = args[2];
        currentEvent.claimToken = null;
        currentEvent.claimedAt = null;
        return [{ id: args[0] }];
      }

      return [{ id: args[0] }];
    }) as unknown as typeof prisma.$queryRawUnsafe;

    inngest.send = (async (payload: any) => {
      if (!inngestAvailable) {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:8288");
      }
      inngestDispatched.push(payload);
      return { ids: ["inngest-evt-ok"] };
    }) as any;

    try {
      // Step 1: Initial dispatch fails because Inngest local daemon is starting up
      const { dispatchOutboxEvent } = await import("../src/server/orchestration/outbox");
      const dispatchResult = await dispatchOutboxEvent("evt-network-failure");

      assert.equal(dispatchResult.dispatched, false);
      assert.match(dispatchResult.error || "", /fetch failed/);
      assert.equal(currentEvent.status, OutboxStatus.FAILED);
      assert.equal(currentEvent.attempts, 1);
      assert.match(currentEvent.lastError, /fetch failed/);
      assert.ok(currentEvent.nextAttemptAt instanceof Date);

      // Step 2: Inngest becomes available / daemon starts up
      inngestAvailable = true;

      // Step 3: Scheduled recovery worker runs
      const recoveryResult = await recoverStaleOutboxEvents();

      assert.equal(recoveryResult.total, 1);
      assert.equal(recoveryResult.recovered, 1);
      assert.equal(recoveryResult.failed, 0);

      // Step 4: Verify event was dispatched and transitioned to PROCESSED
      assert.equal(currentEvent.status, OutboxStatus.PROCESSED);
      assert.equal(currentEvent.attempts, 2);
      assert.equal(inngestDispatched.length, 1);
      assert.equal(inngestDispatched[0].id, "run-run-e2e-recovery");
      assert.equal(inngestDispatched[0].data.projectId, "proj-e2e");
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
    }
  });
});
