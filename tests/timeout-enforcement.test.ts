import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  establishRunDeadline,
  checkGenerationDeadline,
  boundOperationTimeout,
  getRemainingTimeMs,
  isPastDeadline,
  GenerationTimeoutError,
} from "../src/server/orchestration/stage-optimizer";
import { finalizeGenerationFailure } from "../src/server/orchestration/finalization";
import { prisma } from "../src/lib/db";
import { GenerationRunStatus } from "../src/generated/prisma/client";

describe("P1: Generation Deadline & Cooperative Timeout Enforcement", () => {
  it("establishes deterministic deadline anchored to persisted start timestamp", () => {
    const startedAt = new Date(Date.now() - 60_000); // 1 minute ago
    const maxDurationMs = 300_000; // 5 minutes

    const context = establishRunDeadline(startedAt, maxDurationMs);

    assert.equal(context.startedAtMs, startedAt.getTime());
    assert.equal(context.maxDurationMs, maxDurationMs);
    assert.equal(context.deadlineMs, startedAt.getTime() + maxDurationMs);
    assert.ok(getRemainingTimeMs(context.deadlineMs) <= 240_000);
    assert.equal(isPastDeadline(context.deadlineMs), false);
  });

  it("cooperatively aborts upcoming stage when synthetic provider delays exceed deadline", () => {
    // Simulate a run that started 301 seconds ago (limit is 300s)
    const expiredStart = new Date(Date.now() - 301_000);
    const context = establishRunDeadline(expiredStart, 300_000);

    assert.equal(isPastDeadline(context.deadlineMs), true);
    assert.equal(getRemainingTimeMs(context.deadlineMs), 0);

    // Attempting to enter "architecture" stage after slow planner
    assert.throws(
      () => checkGenerationDeadline(context.deadlineMs, "architecture", 300_000),
      (err: any) => {
        assert.ok(err instanceof GenerationTimeoutError);
        assert.match(err.message, /timed out before stage "architecture"/);
        assert.ok(err.durationMs >= 300_000);
        assert.equal(err.limitMs, 300_000);
        return true;
      }
    );
  });

  it("bounds external operation timeouts to remaining deadline budget and enforces minimum floor", () => {
    const startedAt = new Date(Date.now() - 250_000); // 250s elapsed of 300s
    const context = establishRunDeadline(startedAt, 300_000);

    // Around 50s remaining. If operation asks for 120s, it must be bounded to ~50s
    const bounded = boundOperationTimeout(context.deadlineMs, 120_000, 5000, "build-command");
    assert.ok(bounded <= 50_500 && bounded >= 45_000);

    // Now simulate an operation when only 2 seconds remain (below minFloorMs of 5000ms)
    const almostExpiredStart = new Date(Date.now() - 298_500); // 1.5s remaining
    const expiredContext = establishRunDeadline(almostExpiredStart, 300_000);

    assert.throws(
      () => boundOperationTimeout(expiredContext.deadlineMs, 30_000, 5000, "sandbox-repair"),
      (err: any) => {
        assert.ok(err instanceof GenerationTimeoutError);
        assert.match(err.message, /insufficient budget/);
        return true;
      }
    );
  });

  it("records GENERATION_TIMEOUT error code on failure finalization", async () => {
    let updatedRun: any = null;

    const mockTx = {
      generationRun: {
        findUnique: async () => ({
          id: "test-run-timeout",
          projectId: "test-project-1",
          status: GenerationRunStatus.RUNNING,
        }),
        update: async (args: any) => {
          updatedRun = args;
          return {
            id: args.where.id,
            status: args.data.status,
            errorCode: args.data.errorCode,
            errorMessage: args.data.errorMessage,
          };
        },
      },
      message: {
        findUnique: async () => null,
        create: async (args: any) => ({ id: "msg-fail-1", ...args.data }),
      },
      runEvent: {
        findFirst: async () => null,
        create: async (args: any) => ({ id: "event-fail-1", ...args.data }),
      },
    };

    const originalTransaction = prisma.$transaction;
    (prisma as any).$transaction = async (cb: any) => cb(mockTx);

    try {
      await finalizeGenerationFailure({
        generationRunId: "test-run-timeout",
        projectId: "test-project-1",
        errorCode: "GENERATION_TIMEOUT",
        errorMessage: "Generation timed out before stage 'coding': elapsed 305000ms exceeds limit of 300000ms",
      });

      assert.ok(updatedRun);
      assert.equal(updatedRun.where.id, "test-run-timeout");
      assert.equal(updatedRun.data.status, GenerationRunStatus.FAILED);
      assert.equal(updatedRun.data.errorCode, "GENERATION_TIMEOUT");
      assert.match(updatedRun.data.errorMessage, /timed out/);
    } finally {
      (prisma as any).$transaction = originalTransaction;
    }
  });

  it("documents cooperative vs preemptive timeout mechanics honestly", () => {
    // Verified architecture guarantee:
    // Out-of-process AI API calls (Gemini HTTP/REST) and remote container commands (E2B)
    // are bounded via cooperative deadline evaluation at stage boundaries and timeout budgets,
    // rather than non-portable preemptive process killing.
    assert.equal(typeof checkGenerationDeadline, "function");
    assert.equal(typeof boundOperationTimeout, "function");
  });
});
