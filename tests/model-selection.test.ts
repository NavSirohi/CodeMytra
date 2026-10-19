import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_REGISTRY,
  AVAILABLE_MODEL_IDS,
  isValidModelPreference,
  normalizeModelPreference,
  ModelPreference,
} from "../src/lib/models";
import { selectModelForStage } from "../src/server/orchestration/stage-optimizer";
import { executeClaimedEvent } from "../src/server/orchestration/outbox";
import { inngest } from "../src/features/inngest/client";
import { prisma } from "../src/lib/db";
import { OutboxStatus } from "../src/generated/prisma/client";

describe("P0: Model Registry, Server Validation & Pipeline Propagation", () => {
  it("defines complete shared model registry with expected entries and metadata", () => {
    assert.deepEqual([...AVAILABLE_MODEL_IDS], [
      "auto",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);

    for (const modelId of AVAILABLE_MODEL_IDS) {
      const def = MODEL_REGISTRY[modelId];
      assert.ok(def, `Missing definition for ${modelId}`);
      assert.equal(def.id, modelId);
      assert.ok(def.name.length > 0, `Missing name for ${modelId}`);
      assert.ok(def.badge.length > 0, `Missing badge for ${modelId}`);
      assert.ok(def.description.length > 0, `Missing description for ${modelId}`);
      assert.ok(def.recommendedFor.length > 0, `Missing recommendation for ${modelId}`);
    }
  });

  it("strictly validates model preferences and rejects unsupported models", () => {
    // Valid models
    assert.equal(isValidModelPreference("auto"), true);
    assert.equal(isValidModelPreference("gemini-2.5-pro"), true);
    assert.equal(isValidModelPreference("gemini-2.5-flash"), true);

    // Invalid / unsupported models
    assert.equal(isValidModelPreference("gpt-4"), false);
    assert.equal(isValidModelPreference("gpt-4o"), false);
    assert.equal(isValidModelPreference("claude-3-5-sonnet"), false);
    assert.equal(isValidModelPreference("gemini-1.5-pro"), false);
    assert.equal(isValidModelPreference("gemini-2.0-flash"), false);
    assert.equal(isValidModelPreference(""), false);
    assert.equal(isValidModelPreference(null), false);
    assert.equal(isValidModelPreference(undefined), false);
    assert.equal(isValidModelPreference(123), false);
    assert.equal(isValidModelPreference({}), false);
  });

  it("normalizes unknown or omitted inputs safely to 'auto'", () => {
    assert.equal(normalizeModelPreference("gemini-2.5-pro"), "gemini-2.5-pro");
    assert.equal(normalizeModelPreference("gemini-2.5-flash"), "gemini-2.5-flash");
    assert.equal(normalizeModelPreference("auto"), "auto");
    assert.equal(normalizeModelPreference(null), "auto");
    assert.equal(normalizeModelPreference(undefined), "auto");
    assert.equal(normalizeModelPreference("non-existent-model"), "auto");
  });

  describe("Stage Optimizer Model Routing", () => {
    it("routes to gemini-2.5-pro across planning, architecture, coding, and repair when user selects Pro", () => {
      const pref: ModelPreference = "gemini-2.5-pro";
      assert.equal(selectModelForStage("planning", { modelPreference: pref }), "gemini-2.5-pro");
      assert.equal(selectModelForStage("design", { modelPreference: pref }), "gemini-2.5-pro");
      assert.equal(selectModelForStage("architecture", { modelPreference: pref }), "gemini-2.5-pro");
      assert.equal(selectModelForStage("coding", { modelPreference: pref }), "gemini-2.5-pro");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true, modelPreference: pref }), "gemini-2.5-pro");
    });

    it("routes to gemini-2.5-flash across all stages when user selects Flash (including architecture & repair)", () => {
      const pref: ModelPreference = "gemini-2.5-flash";
      assert.equal(selectModelForStage("planning", { modelPreference: pref }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("design", { modelPreference: pref }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("architecture", { modelPreference: pref }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("coding", { modelPreference: pref }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true, modelPreference: pref }), "gemini-2.5-flash");
    });

    it("uses adaptive routing when modelPreference is 'auto' or omitted", () => {
      // Planning: Flash for simple, Pro for complex fullstack
      assert.equal(selectModelForStage("planning", { isComplexFullstack: false }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("planning", { isComplexFullstack: true }), "gemini-2.5-pro");

      // Design: always Flash
      assert.equal(selectModelForStage("design"), "gemini-2.5-flash");

      // Architecture: always Pro
      assert.equal(selectModelForStage("architecture"), "gemini-2.5-pro");

      // Coding: Flash for simple, Pro for complex fullstack
      assert.equal(selectModelForStage("coding", { isComplexFullstack: false }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("coding", { isComplexFullstack: true }), "gemini-2.5-pro");

      // Repair: Flash without flag, Pro on repair attempt
      assert.equal(selectModelForStage("repair", { isRepairAttempt: false }), "gemini-2.5-flash");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true }), "gemini-2.5-pro");
    });

    it("demonstrates each user-facing model selection produces measurably distinct provider configurations", () => {
      // Compare architecture stage across the 3 user options:
      const autoArch = selectModelForStage("architecture", { modelPreference: "auto" });
      const flashArch = selectModelForStage("architecture", { modelPreference: "gemini-2.5-flash" });
      const proArch = selectModelForStage("architecture", { modelPreference: "gemini-2.5-pro" });

      assert.equal(autoArch, "gemini-2.5-pro");
      assert.equal(flashArch, "gemini-2.5-flash"); // Flash forced even for architecture!
      assert.equal(proArch, "gemini-2.5-pro");
      assert.notEqual(flashArch, autoArch);

      // Compare coding stage across simple project:
      const autoCoding = selectModelForStage("coding", { isComplexFullstack: false, modelPreference: "auto" });
      const proCoding = selectModelForStage("coding", { isComplexFullstack: false, modelPreference: "gemini-2.5-pro" });

      assert.equal(autoCoding, "gemini-2.5-flash");
      assert.equal(proCoding, "gemini-2.5-pro"); // Pro forced even for simple coding!
      assert.notEqual(autoCoding, proCoding);
    });
  });

  describe("Outbox Execution & Inngest Dispatch Pipeline", () => {
    it("propagates user modelPreference through executeClaimedEvent to inngest.send", async () => {
      const sentEvents: Array<{ name: string; data: Record<string, unknown> }> = [];
      const originalSend = inngest.send;

      // Mock inngest.send
      (inngest as unknown as { send: (arg: unknown) => Promise<unknown> }).send = async (arg: unknown) => {
        sentEvents.push(arg as { name: string; data: Record<string, unknown> });
        return { ids: ["mock-msg-id"] };
      };

      const originalQueryRawUnsafe = prisma.$queryRawUnsafe;
      (prisma as unknown as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }).$queryRawUnsafe = async () => {
        return [];
      };

      try {
        const syntheticEvent = {
          id: "outbox-test-1",
          eventName: "code-agent/run",
          payload: {
            runId: "run-test-pro-1",
            projectId: "proj-test-1",
            prompt: "Build an invoice tracker",
            baseRevisionId: null,
            modelPreference: "gemini-2.5-pro",
          },
          status: OutboxStatus.PROCESSING,
          attempts: 1,
          lastError: null,
          claimedAt: new Date(),
          nextAttemptAt: null,
          claimToken: "token-test-1",
          createdAt: new Date(),
          processedAt: null,
        };

        const result = await executeClaimedEvent(syntheticEvent);
        assert.equal(result.success, true);
        assert.equal(sentEvents.length, 1);
        assert.equal(sentEvents[0].name, "code-agent/run");
        assert.equal(sentEvents[0].data.modelPreference, "gemini-2.5-pro");
        assert.equal(sentEvents[0].data.runId, "run-test-pro-1");
      } finally {
        (inngest as unknown as { send: typeof originalSend }).send = originalSend;
        (prisma as unknown as { $queryRawUnsafe: typeof originalQueryRawUnsafe }).$queryRawUnsafe = originalQueryRawUnsafe;
      }
    });
  });
});
