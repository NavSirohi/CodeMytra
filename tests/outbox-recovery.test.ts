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
      assert.match(capturedQuery, /SET\s+status\s*=\s*'PROCESSING',\s*attempts\s*=\s*attempts\s*\+\s*1,\s*"claimedAt"\s*=\s*NOW\(\)/i);
      assert.match(capturedQuery, /FOR UPDATE SKIP LOCKED/i);
      assert.match(capturedQuery, /nextAttemptAt/i);
      assert.match(capturedQuery, /claimedAt/i);

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
    }) as any;

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
      assert.match(updateCalls[0].query, /claimedAt/);
      assert.equal(updateCalls[0].args[0], "evt-1");
      assert.equal(updateCalls[0].args[1], mockClaimedAt);
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
    }) as any;

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
      assert.equal(failUpdate.args[3], mockClaimedAt);
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
});
