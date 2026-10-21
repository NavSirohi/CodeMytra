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

describe("P0: Model Registry, Server Validation & Pipeline Propagation (OpenAI)", () => {
  it("defines complete shared OpenAI model registry with expected entries and metadata", () => {
    assert.deepEqual([...AVAILABLE_MODEL_IDS], [
      "auto",
      "gpt-4o",
      "gpt-4o-mini",
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
    // Valid active OpenAI models
    assert.equal(isValidModelPreference("auto"), true);
    assert.equal(isValidModelPreference("gpt-4o"), true);
    assert.equal(isValidModelPreference("gpt-4o-mini"), true);

    // Invalid / unsupported models (including deprecated Gemini models from active selection)
    assert.equal(isValidModelPreference("gemini-2.5-pro"), false);
    assert.equal(isValidModelPreference("gemini-2.5-flash"), false);
    assert.equal(isValidModelPreference("claude-3-5-sonnet"), false);
    assert.equal(isValidModelPreference("gemini-1.5-pro"), false);
    assert.equal(isValidModelPreference(""), false);
    assert.equal(isValidModelPreference(null), false);
    assert.equal(isValidModelPreference(undefined), false);
    assert.equal(isValidModelPreference(123), false);
    assert.equal(isValidModelPreference({}), false);
  });

  it("normalizes unknown or omitted inputs safely to 'auto', protecting historical records", () => {
    assert.equal(normalizeModelPreference("gpt-4o"), "gpt-4o");
    assert.equal(normalizeModelPreference("gpt-4o-mini"), "gpt-4o-mini");
    assert.equal(normalizeModelPreference("auto"), "auto");
    // Historical Gemini preferences safely normalize to auto for new execution
    assert.equal(normalizeModelPreference("gemini-2.5-pro"), "auto");
    assert.equal(normalizeModelPreference("gemini-2.5-flash"), "auto");
    assert.equal(normalizeModelPreference(null), "auto");
    assert.equal(normalizeModelPreference(undefined), "auto");
    assert.equal(normalizeModelPreference("non-existent-model"), "auto");
  });

  describe("Stage Optimizer Model Routing", () => {
    it("routes to gpt-4o across planning, architecture, coding, and repair when user selects GPT-4o", () => {
      const pref: ModelPreference = "gpt-4o";
      assert.equal(selectModelForStage("planning", { modelPreference: pref }), "gpt-4o");
      assert.equal(selectModelForStage("design", { modelPreference: pref }), "gpt-4o");
      assert.equal(selectModelForStage("architecture", { modelPreference: pref }), "gpt-4o");
      assert.equal(selectModelForStage("coding", { modelPreference: pref }), "gpt-4o");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true, modelPreference: pref }), "gpt-4o");
    });

    it("routes to gpt-4o-mini across all stages when user selects GPT-4o mini", () => {
      const pref: ModelPreference = "gpt-4o-mini";
      assert.equal(selectModelForStage("planning", { modelPreference: pref }), "gpt-4o-mini");
      assert.equal(selectModelForStage("design", { modelPreference: pref }), "gpt-4o-mini");
      assert.equal(selectModelForStage("architecture", { modelPreference: pref }), "gpt-4o-mini");
      assert.equal(selectModelForStage("coding", { modelPreference: pref }), "gpt-4o-mini");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true, modelPreference: pref }), "gpt-4o-mini");
    });

    it("uses adaptive routing when modelPreference is 'auto' or omitted", () => {
      // Planning: gpt-4o-mini for simple, gpt-4o for complex fullstack
      assert.equal(selectModelForStage("planning", { isComplexFullstack: false }), "gpt-4o-mini");
      assert.equal(selectModelForStage("planning", { isComplexFullstack: true }), "gpt-4o");

      // Design: always gpt-4o-mini
      assert.equal(selectModelForStage("design"), "gpt-4o-mini");

      // Architecture: always gpt-4o
      assert.equal(selectModelForStage("architecture"), "gpt-4o");

      // Coding: gpt-4o-mini for simple, gpt-4o for complex fullstack
      assert.equal(selectModelForStage("coding", { isComplexFullstack: false }), "gpt-4o-mini");
      assert.equal(selectModelForStage("coding", { isComplexFullstack: true }), "gpt-4o");

      // Repair: gpt-4o-mini without flag, gpt-4o on repair attempt
      assert.equal(selectModelForStage("repair", { isRepairAttempt: false }), "gpt-4o-mini");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true }), "gpt-4o");
    });

    it("demonstrates each user-facing model selection produces measurably distinct provider configurations", () => {
      // Compare architecture stage across the 3 user options:
      const autoArch = selectModelForStage("architecture", { modelPreference: "auto" });
      const miniArch = selectModelForStage("architecture", { modelPreference: "gpt-4o-mini" });
      const proArch = selectModelForStage("architecture", { modelPreference: "gpt-4o" });

      assert.equal(autoArch, "gpt-4o");
      assert.equal(miniArch, "gpt-4o-mini");
      assert.equal(proArch, "gpt-4o");
      assert.notEqual(miniArch, autoArch);

      // Compare coding stage across simple project:
      const autoCoding = selectModelForStage("coding", { isComplexFullstack: false, modelPreference: "auto" });
      const proCoding = selectModelForStage("coding", { isComplexFullstack: false, modelPreference: "gpt-4o" });

      assert.equal(autoCoding, "gpt-4o-mini");
      assert.equal(proCoding, "gpt-4o");
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
        return { ids: ["mock-msg-id-1"] };
      };

      const originalQueryRawUnsafe = prisma.$queryRawUnsafe;
      (prisma as unknown as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }).$queryRawUnsafe = async () => {
        return [{ id: "outbox-test-1" }];
      };

      try {
        const testEvent = {
          id: "outbox-test-1",
          eventName: "code-agent/run",
          payload: {
            runId: "run-test-1",
            projectId: "proj-test-1",
            prompt: "Build an inventory tracker",
            baseRevisionId: null,
            modelPreference: "gpt-4o",
          },
          status: OutboxStatus.PROCESSING,
          attempts: 1,
          claimToken: "tok-test-1",
          claimedAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
          createdAt: new Date(),
          processedAt: null,
        };

        const result = await executeClaimedEvent(testEvent);
        assert.equal(result.success, true);
        assert.equal(sentEvents.length, 1);
        assert.equal(sentEvents[0].name, "code-agent/run");
        assert.equal(sentEvents[0].data.runId, "run-test-1");
        assert.equal(sentEvents[0].data.projectId, "proj-test-1");
        assert.equal(sentEvents[0].data.modelPreference, "gpt-4o");
      } finally {
        (inngest as unknown as { send: typeof originalSend }).send = originalSend;
        (prisma as unknown as { $queryRawUnsafe: typeof originalQueryRawUnsafe }).$queryRawUnsafe = originalQueryRawUnsafe;
      }
    });
  });
});
