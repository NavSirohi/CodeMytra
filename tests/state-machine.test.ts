import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidTransition,
  isTerminalStatus,
  ALLOWED_STATUS_TRANSITIONS,
} from "../src/server/orchestration/state-machine";
import { GenerationRunStatus } from "../src/generated/prisma/client";

describe("GenerationRun State Machine", () => {
  it("allows valid forward transitions", () => {
    assert.equal(
      isValidTransition(GenerationRunStatus.QUEUED, GenerationRunStatus.RUNNING),
      true
    );
    assert.equal(
      isValidTransition(GenerationRunStatus.RUNNING, GenerationRunStatus.VALIDATING),
      true
    );
    assert.equal(
      isValidTransition(GenerationRunStatus.VALIDATING, GenerationRunStatus.COMPLETED),
      true
    );
  });

  it("allows cancellation from non-terminal states", () => {
    assert.equal(
      isValidTransition(GenerationRunStatus.QUEUED, GenerationRunStatus.CANCELLED),
      true
    );
    assert.equal(
      isValidTransition(GenerationRunStatus.RUNNING, GenerationRunStatus.CANCELLED),
      true
    );
  });

  it("allows failure transitions from processing states", () => {
    assert.equal(
      isValidTransition(GenerationRunStatus.QUEUED, GenerationRunStatus.FAILED),
      true
    );
    assert.equal(
      isValidTransition(GenerationRunStatus.RUNNING, GenerationRunStatus.FAILED),
      true
    );
    assert.equal(
      isValidTransition(GenerationRunStatus.VALIDATING, GenerationRunStatus.FAILED),
      true
    );
  });

  it("rejects illegal transitions", () => {
    // Cannot jump from QUEUED directly to COMPLETED without RUNNING & VALIDATING
    assert.equal(
      isValidTransition(GenerationRunStatus.QUEUED, GenerationRunStatus.COMPLETED),
      false
    );
    // Cannot transition backwards
    assert.equal(
      isValidTransition(GenerationRunStatus.VALIDATING, GenerationRunStatus.RUNNING),
      false
    );
    assert.equal(
      isValidTransition(GenerationRunStatus.RUNNING, GenerationRunStatus.QUEUED),
      false
    );
  });

  it("identifies terminal states and allows no transitions out of them", () => {
    assert.equal(isTerminalStatus(GenerationRunStatus.COMPLETED), true);
    assert.equal(isTerminalStatus(GenerationRunStatus.FAILED), true);
    assert.equal(isTerminalStatus(GenerationRunStatus.CANCELLED), true);
    assert.equal(isTerminalStatus(GenerationRunStatus.RUNNING), false);
    assert.equal(isTerminalStatus(GenerationRunStatus.QUEUED), false);

    // Terminal states have empty allowed transitions
    assert.deepEqual(ALLOWED_STATUS_TRANSITIONS[GenerationRunStatus.COMPLETED], []);
    assert.deepEqual(ALLOWED_STATUS_TRANSITIONS[GenerationRunStatus.FAILED], []);
    assert.deepEqual(ALLOWED_STATUS_TRANSITIONS[GenerationRunStatus.CANCELLED], []);
  });
});
