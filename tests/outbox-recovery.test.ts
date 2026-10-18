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
  it("executes atomic query with FOR UPDATE SKIP LOCKED, backoff, and no updatedAt", async () => {
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
      const result = await recoverStaleOutboxEvents(300000, 25, 10);

      // Verify query has atomic claiming with SKIP LOCKED
      assert.match(capturedQuery, /UPDATE\s+"OutboxEvent"/i);
      assert.match(capturedQuery, /SET\s+status\s*=\s*'PROCESSING',\s*attempts\s*=\s*attempts\s*\+\s*1/i);
      assert.doesNotMatch(capturedQuery, /updatedAt/i, "Schema has no updatedAt column; must not reference it");
      assert.match(capturedQuery, /FOR UPDATE SKIP LOCKED/i);

      // Verify exponential backoff calculation in WHERE clause
      assert.match(capturedQuery, /interval\s+'1 second'\s*\*\s*power\(2,\s*attempts\)/i);

      // Verify parameters passed
      assert.equal(capturedArgs.length, 4);
      const cutoff = capturedArgs[0] as Date;
      assert.ok(cutoff instanceof Date);
      assert.ok(cutoff.getTime() <= beforeTime - 300000 + 100);
      assert.ok(cutoff.getTime() >= beforeTime - 300000 - 1000);

      assert.equal(capturedArgs[1], MAX_OUTBOX_ATTEMPTS);
      assert.equal(capturedArgs[2], 10); // baseDelaySeconds
      assert.equal(capturedArgs[3], 25); // batchSize

      assert.deepEqual(result, { total: 0, recovered: 0, failed: 0 });
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
    }
  });

  it("dispatches claimed events via inngest.send and marks PROCESSED", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;
    const originalUpdate = prisma.outboxEvent.update;

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
        createdAt: new Date(Date.now() - 200000),
        processedAt: null,
      },
    ];

    const inngestCalls: any[] = [];
    const updateCalls: any[] = [];

    prisma.$queryRawUnsafe = (async () => mockEvents) as any;
    inngest.send = (async (payload: any) => {
      inngestCalls.push(payload);
      return { ids: ["msg-1"] };
    }) as any;
    prisma.outboxEvent.update = (async (args: any) => {
      updateCalls.push(args);
      return args;
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

      assert.equal(updateCalls.length, 2);
      assert.equal(updateCalls[0].where.id, "evt-1");
      assert.equal(updateCalls[0].data.status, OutboxStatus.PROCESSED);
      assert.ok(updateCalls[0].data.processedAt instanceof Date);
      assert.equal(updateCalls[0].data.lastError, null);

      assert.equal(updateCalls[1].where.id, "evt-2");
      assert.equal(updateCalls[1].data.status, OutboxStatus.PROCESSED);
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
      prisma.outboxEvent.update = originalUpdate;
    }
  });

  it("handles dispatch failure gracefully and marks event FAILED with lastError", async () => {
    const originalQueryRaw = prisma.$queryRawUnsafe;
    const originalInngestSend = inngest.send;
    const originalUpdate = prisma.outboxEvent.update;

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
        createdAt: new Date(),
        processedAt: null,
      },
    ];

    const updateCalls: any[] = [];

    prisma.$queryRawUnsafe = (async () => mockEvents) as any;
    inngest.send = (async () => {
      throw new Error("Inngest endpoint down");
    }) as any;
    prisma.outboxEvent.update = (async (args: any) => {
      updateCalls.push(args);
      return args;
    }) as any;

    try {
      const result = await recoverStaleOutboxEvents();

      assert.equal(result.total, 1);
      assert.equal(result.recovered, 0);
      assert.equal(result.failed, 1);

      assert.equal(updateCalls.length, 1);
      assert.equal(updateCalls[0].where.id, "evt-failed");
      assert.equal(updateCalls[0].data.status, OutboxStatus.FAILED);
      assert.equal(updateCalls[0].data.lastError, "Inngest endpoint down");
    } finally {
      prisma.$queryRawUnsafe = originalQueryRaw;
      inngest.send = originalInngestSend;
      prisma.outboxEvent.update = originalUpdate;
    }
  });

  it("configures scheduled Inngest cron function correctly", () => {
    // Verify Inngest function instance
    assert.ok(outboxRecoveryFunction && typeof outboxRecoveryFunction === "object");
    const opts = (outboxRecoveryFunction as any).opts;
    assert.equal(opts.id, "outbox-recovery");
    assert.deepEqual(opts.triggers, [{ cron: "*/5 * * * *" }]);
  });
});
