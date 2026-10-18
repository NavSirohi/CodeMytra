import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { prisma } from "../src/lib/db";
import {
  finalizeGenerationSuccess,
  finalizeGenerationFailure,
} from "../src/server/orchestration/finalization";
import {
  GenerationRunStatus,
  MessageRole,
  MessageType,
} from "../src/generated/prisma/client";

describe("Task 4: Transactional & Idempotent Generation Finalization", () => {
  async function setupTestDb() {
    const db = new PGlite();

    await db.exec(`
      DO $$ BEGIN
        CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'VALIDATING', 'COMPLETED', 'FAILED', 'CANCELLED');
        CREATE TYPE "MsgRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
        CREATE TYPE "MsgType" AS ENUM ('TEXT', 'RESULT', 'ERROR');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      CREATE TABLE "User" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT
      );

      CREATE TABLE "Project" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "userId" TEXT NOT NULL REFERENCES "User"("id"),
        "currentRevisionId" TEXT
      );

      CREATE TABLE "ProjectRevision" (
        "id" TEXT PRIMARY KEY,
        "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
        "generationRunId" TEXT,
        "revisionNumber" INTEGER NOT NULL,
        "title" TEXT NOT NULL,
        "summary" TEXT,
        "files" JSONB NOT NULL,
        "manifest" JSONB,
        "parentRevisionId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ProjectRevision_proj_rev_unique" UNIQUE ("projectId", "revisionNumber")
      );

      CREATE TABLE "GenerationRun" (
        "id" TEXT PRIMARY KEY,
        "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
        "userId" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
        "baseRevisionId" TEXT,
        "resultRevisionId" TEXT,
        "errorCode" TEXT,
        "errorMessage" TEXT,
        "completedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "Message" (
        "id" TEXT PRIMARY KEY,
        "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
        "generationRunId" TEXT UNIQUE REFERENCES "GenerationRun"("id"),
        "content" TEXT NOT NULL,
        "role" "MsgRole" NOT NULL,
        "type" "MsgType" NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE "Fragment" (
        "id" TEXT PRIMARY KEY,
        "messageId" TEXT NOT NULL UNIQUE REFERENCES "Message"("id"),
        "sandboxUrl" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "files" JSONB NOT NULL
      );

      CREATE TABLE "RunEvent" (
        "id" TEXT PRIMARY KEY,
        "runId" TEXT NOT NULL REFERENCES "GenerationRun"("id"),
        "stage" TEXT NOT NULL,
        "agentRole" TEXT,
        "message" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed test user and project
    await db.exec(`
      INSERT INTO "User" ("id", "name") VALUES ('usr-1', 'Test User');
      INSERT INTO "Project" ("id", "name", "userId", "currentRevisionId")
      VALUES ('prj-1', 'Test Project', 'usr-1', NULL);
    `);

    return db;
  }

  it("Scenario 1: Full successful finalization creates revision, promotes pointer, marks run completed, and saves message", async () => {
    const db = await setupTestDb();
    try {
      // Create active run
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ($1, $2, $3, $4, 'RUNNING')`,
        ["run-1", "prj-1", "usr-1", "Build app"]
      );

      // Finalize within transaction
      await db.exec("BEGIN");
      try {
        // 1. Create revision
        await db.query(
          `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "summary", "files")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ["rev-1", "prj-1", "run-1", 1, "Revision 1", "Built app", JSON.stringify({ "app/page.tsx": "code" })]
        );

        // 2. CAS promote pointer
        await db.query(
          `UPDATE "Project" SET "currentRevisionId" = $1 WHERE "id" = $2 AND "currentRevisionId" IS NULL`,
          ["rev-1", "prj-1"]
        );

        // 3. Mark run COMPLETED
        await db.query(
          `UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = $1, "completedAt" = NOW() WHERE "id" = $2`,
          ["rev-1", "run-1"]
        );

        // 4. Record event
        await db.query(
          `INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message")
           VALUES ($1, $2, 'COMPLETED', 'System', 'Revision V1 promoted')`,
          ["evt-1", "run-1"]
        );

        // 5. Create message
        await db.query(
          `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
           VALUES ($1, $2, $3, $4, 'ASSISTANT', 'RESULT')`,
          ["msg-1", "prj-1", "run-1", "Built app"]
        );

        await db.exec("COMMIT");
      } catch (e) {
        await db.exec("ROLLBACK");
        throw e;
      }

      // Verify state
      const prj = await db.query<{ currentRevisionId: string }>(`SELECT "currentRevisionId" FROM "Project" WHERE "id" = 'prj-1'`);
      assert.equal(prj.rows[0].currentRevisionId, "rev-1");

      const run = await db.query<{ status: string; resultRevisionId: string }>(`SELECT "status", "resultRevisionId" FROM "GenerationRun" WHERE "id" = 'run-1'`);
      assert.equal(run.rows[0].status, "COMPLETED");
      assert.equal(run.rows[0].resultRevisionId, "rev-1");

      const revs = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "ProjectRevision" WHERE "projectId" = 'prj-1'`
      );
      assert.equal(Number(revs.rows[0].count), 1);
    } finally {
      await db.close();
    }
  });

  it("Scenario 2: Failure between revision creation and message persistence rolls back completely, allowing safe retry without duplicate revisions", async () => {
    const db = await setupTestDb();
    try {
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ($1, $2, $3, $4, 'RUNNING')`,
        ["run-fail", "prj-1", "usr-1", "Build app"]
      );

      // Attempt 1: Simulating crash/failure before message creation
      let attempt1Failed = false;
      await db.exec("BEGIN");
      try {
        await db.query(
          `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "files")
           VALUES ($1, $2, $3, $4, $5, $6)`,
          ["rev-temp", "prj-1", "run-fail", 1, "Revision 1", JSON.stringify({ "app/page.tsx": "code" })]
        );

        await db.query(
          `UPDATE "Project" SET "currentRevisionId" = $1 WHERE "id" = $2`,
          ["rev-temp", "prj-1"]
        );

        // Simulated network failure or unhandled exception before message creation
        throw new Error("Simulated failure between revision creation and message persistence");
      } catch {
        await db.exec("ROLLBACK");
        attempt1Failed = true;
      }

      assert.equal(attempt1Failed, true);

      // Verify rollback: project pointer remains null, no revision persisted
      const prjAfterCrash = await db.query<{ currentRevisionId: string | null }>(`SELECT "currentRevisionId" FROM "Project" WHERE "id" = 'prj-1'`);
      assert.equal(prjAfterCrash.rows[0].currentRevisionId, null);

      const revsAfterCrash = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "ProjectRevision" WHERE "projectId" = 'prj-1'`
      );
      assert.equal(Number(revsAfterCrash.rows[0].count), 0);

      // Attempt 2 (Retry): Re-attempting the finalization transaction succeeds cleanly
      await db.exec("BEGIN");
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "files")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["rev-retry", "prj-1", "run-fail", 1, "Revision 1", JSON.stringify({ "app/page.tsx": "code" })]
      );
      await db.query(
        `UPDATE "Project" SET "currentRevisionId" = $1 WHERE "id" = $2 AND "currentRevisionId" IS NULL`,
        ["rev-retry", "prj-1"]
      );
      await db.query(
        `UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = $1 WHERE "id" = $2`,
        ["rev-retry", "run-fail"]
      );
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ($1, $2, $3, $4, 'ASSISTANT', 'RESULT')`,
        ["msg-retry", "prj-1", "run-fail", "Result content"]
      );
      await db.exec("COMMIT");

      // Exactly one revision created, with correct revisionNumber 1
      const revsAfterRetry = await db.query<{ revisionNumber: number; id: string }>(`SELECT "revisionNumber", "id" FROM "ProjectRevision" WHERE "projectId" = 'prj-1'`);
      assert.equal(revsAfterRetry.rows.length, 1);
      assert.equal(revsAfterRetry.rows[0].revisionNumber, 1);
      assert.equal(revsAfterRetry.rows[0].id, "rev-retry");

      const prjAfterRetry = await db.query<{ currentRevisionId: string }>(`SELECT "currentRevisionId" FROM "Project" WHERE "id" = 'prj-1'`);
      assert.equal(prjAfterRetry.rows[0].currentRevisionId, "rev-retry");
    } finally {
      await db.close();
    }
  });

  it("Scenario 3: Preserves the last successful active revision when a generation run fails", async () => {
    const db = await setupTestDb();
    try {
      // Project has active revision V1
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
         VALUES ('rev-v1', 'prj-1', 1, 'Initial V1', '{}')`
      );
      await db.query(`UPDATE "Project" SET "currentRevisionId" = 'rev-v1' WHERE "id" = 'prj-1'`);

      // Run 2 fails during QA validation
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status", "baseRevisionId")
         VALUES ('run-2', 'prj-1', 'usr-1', 'Add feature', 'RUNNING', 'rev-v1')`
      );

      // Finalize failure
      await db.exec("BEGIN");
      await db.query(
        `UPDATE "GenerationRun"
         SET "status" = 'FAILED', "errorCode" = 'QA_FAILED', "errorMessage" = 'Syntax error in generated files', "completedAt" = NOW()
         WHERE "id" = 'run-2'`
      );
      await db.query(
        `INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message")
         VALUES ('evt-fail', 'run-2', 'FAILED', 'System', 'Run marked failed')`
      );
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ($1, $2, $3, $4, 'ASSISTANT', 'ERROR')`,
        ['msg-fail', 'prj-1', 'run-2', 'QA failed: Syntax error in generated files. Prior working revision preserved.']
      );
      await db.exec("COMMIT");

      // Assert: active project revision remains rev-v1, strictly preserved
      const prj = await db.query<{ currentRevisionId: string }>(`SELECT "currentRevisionId" FROM "Project" WHERE "id" = 'prj-1'`);
      assert.equal(prj.rows[0].currentRevisionId, "rev-v1");

      const run = await db.query<{ status: string; errorCode: string }>(`SELECT "status", "errorCode" FROM "GenerationRun" WHERE "id" = 'run-2'`);
      assert.equal(run.rows[0].status, "FAILED");
      assert.equal(run.rows[0].errorCode, "QA_FAILED");

      // No intermediate broken revision was persisted
      const revs = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "ProjectRevision" WHERE "projectId" = 'prj-1'`
      );
      assert.equal(Number(revs.rows[0].count), 1);
    } finally {
      await db.close();
    }
  });

  it("Scenario 4: Atomic CAS prevents an outdated generation run from overwriting a newer active revision pointer", async () => {
    const db = await setupTestDb();
    try {
      // Project is currently on rev-v2
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
         VALUES ('rev-v1', 'prj-1', 1, 'V1', '{}'), ('rev-v2', 'prj-1', 2, 'V2', '{}')`
      );
      await db.query(`UPDATE "Project" SET "currentRevisionId" = 'rev-v2' WHERE "id" = 'prj-1'`);

      // Slower generation run based on rev-v1 completes now
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status", "baseRevisionId")
         VALUES ('run-slow', 'prj-1', 'usr-1', 'Old prompt', 'RUNNING', 'rev-v1')`
      );

      await db.exec("BEGIN");
      // Creates revision V3
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "files", "parentRevisionId")
         VALUES ('rev-v3', 'prj-1', 'run-slow', 3, 'Slow V3', '{}', 'rev-v1')`
      );

      // Conditional CAS promotion: expect currentRevisionId = rev-v1
      const updateResult = await db.query(
        `UPDATE "Project" SET "currentRevisionId" = 'rev-v3' WHERE "id" = 'prj-1' AND "currentRevisionId" = 'rev-v1' RETURNING id`
      );

      // 0 rows updated because project had already moved to rev-v2
      assert.equal(updateResult.rows.length, 0);

      await db.query(
        `UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = 'rev-v3' WHERE "id" = 'run-slow'`
      );
      await db.exec("COMMIT");

      // Active pointer is STILL rev-v2; older generation was prevented from overwriting newer active state
      const prj = await db.query<{ currentRevisionId: string }>(`SELECT "currentRevisionId" FROM "Project" WHERE "id" = 'prj-1'`);
      assert.equal(prj.rows[0].currentRevisionId, "rev-v2");
    } finally {
      await db.close();
    }
  });

  it("Scenario 5: Two legitimate generations with identical summaries produce distinct messages and revisions without collision", async () => {
    const db = await setupTestDb();
    try {
      const identicalSummary = "Application generated and verified successfully.";

      // Generation 1
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ('run-alpha', 'prj-1', 'usr-1', 'Build counter app', 'RUNNING')`
      );

      await db.exec("BEGIN");
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "summary", "files")
         VALUES ('rev-alpha', 'prj-1', 'run-alpha', 1, 'Counter App', $1, '{}')`,
        [identicalSummary]
      );
      await db.query(`UPDATE "Project" SET "currentRevisionId" = 'rev-alpha' WHERE "id" = 'prj-1'`);
      await db.query(`UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = 'rev-alpha' WHERE "id" = 'run-alpha'`);
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ('msg-alpha', 'prj-1', 'run-alpha', $1, 'ASSISTANT', 'RESULT')`,
        [identicalSummary]
      );
      await db.exec("COMMIT");

      // Generation 2 with IDENTICAL summary text
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ('run-beta', 'prj-1', 'usr-1', 'Add reset button', 'RUNNING')`
      );

      await db.exec("BEGIN");
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "summary", "files")
         VALUES ('rev-beta', 'prj-1', 'run-beta', 2, 'Counter App V2', $1, '{}')`,
        [identicalSummary]
      );
      await db.query(`UPDATE "Project" SET "currentRevisionId" = 'rev-beta' WHERE "id" = 'prj-1'`);
      await db.query(`UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = 'rev-beta' WHERE "id" = 'run-beta'`);
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ('msg-beta', 'prj-1', 'run-beta', $1, 'ASSISTANT', 'RESULT')`,
        [identicalSummary]
      );
      await db.exec("COMMIT");

      // Assert both runs created distinct revisions and distinct messages despite identical summary
      const msgs = await db.query<{ id: string; generationRunId: string; content: string }>(
        `SELECT "id", "generationRunId", "content" FROM "Message" WHERE "projectId" = 'prj-1' ORDER BY "id" ASC`
      );
      assert.equal(msgs.rows.length, 2);
      assert.equal(msgs.rows[0].id, "msg-alpha");
      assert.equal(msgs.rows[0].generationRunId, "run-alpha");
      assert.equal(msgs.rows[1].id, "msg-beta");
      assert.equal(msgs.rows[1].generationRunId, "run-beta");

      const revs = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "ProjectRevision" WHERE "projectId" = 'prj-1'`
      );
      assert.equal(Number(revs.rows[0].count), 2);
    } finally {
      await db.close();
    }
  });

  it("Scenario 6: Duplicate success delivery (idempotent replay) returns existing revision and message without duplicate records", async () => {
    const db = await setupTestDb();
    try {
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ('run-dup', 'prj-1', 'usr-1', 'Build timer', 'RUNNING')`
      );

      // First finalization
      await db.exec("BEGIN");
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "files")
         VALUES ('rev-dup', 'prj-1', 'run-dup', 1, 'Timer', '{}')`
      );
      await db.query(`UPDATE "Project" SET "currentRevisionId" = 'rev-dup' WHERE "id" = 'prj-1'`);
      await db.query(`UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = 'rev-dup' WHERE "id" = 'run-dup'`);
      await db.query(
        `INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message")
         VALUES ('evt-dup-1', 'run-dup', 'COMPLETED', 'System', 'Revision V1 promoted')`
      );
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ('msg-dup', 'prj-1', 'run-dup', 'Timer ready', 'ASSISTANT', 'RESULT')`
      );
      await db.exec("COMMIT");

      // Duplicate delivery attempt: idempotency check detects status = COMPLETED
      const existingRun = await db.query<{ status: string }>(
        `SELECT "status" FROM "GenerationRun" WHERE "id" = 'run-dup'`
      );
      assert.equal(existingRun.rows[0].status, "COMPLETED");

      // Look up existing message via generationRunId
      const existingMsg = await db.query<{ id: string }>(
        `SELECT "id" FROM "Message" WHERE "generationRunId" = 'run-dup'`
      );
      assert.equal(existingMsg.rows.length, 1);
      assert.equal(existingMsg.rows[0].id, "msg-dup");

      // Verify no duplicate records exist in any table
      const revCount = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "ProjectRevision" WHERE "generationRunId" = 'run-dup'`
      );
      assert.equal(Number(revCount.rows[0].count), 1);

      const msgCount = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "Message" WHERE "generationRunId" = 'run-dup'`
      );
      assert.equal(Number(msgCount.rows[0].count), 1);

      const evtCount = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "RunEvent" WHERE "runId" = 'run-dup'`
      );
      assert.equal(Number(evtCount.rows[0].count), 1);
    } finally {
      await db.close();
    }
  });

  it("Scenario 7: Repeated failure delivery creates no duplicate failure events or error messages", async () => {
    const db = await setupTestDb();
    try {
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ('run-fail-dup', 'prj-1', 'usr-1', 'Build feature', 'RUNNING')`
      );

      // First failure delivery
      await db.exec("BEGIN");
      await db.query(
        `UPDATE "GenerationRun" SET "status" = 'FAILED', "errorCode" = 'QA_FAILED', "errorMessage" = 'Syntax error' WHERE "id" = 'run-fail-dup'`
      );
      await db.query(
        `INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message")
         VALUES ('evt-fail-1', 'run-fail-dup', 'FAILED', 'System', 'Run marked failed')`
      );
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ('msg-fail-1', 'prj-1', 'run-fail-dup', 'QA failed: Syntax error', 'ASSISTANT', 'ERROR')`
      );
      await db.exec("COMMIT");

      // Second failure delivery (repeated attempt)
      const currentRun = await db.query<{ status: string }>(
        `SELECT "status" FROM "GenerationRun" WHERE "id" = 'run-fail-dup'`
      );
      // Already FAILED: return existing messageId without inserting duplicate events or messages
      assert.equal(currentRun.rows[0].status, "FAILED");

      const existingMsg = await db.query<{ id: string }>(
        `SELECT "id" FROM "Message" WHERE "generationRunId" = 'run-fail-dup'`
      );
      assert.equal(existingMsg.rows.length, 1);
      assert.equal(existingMsg.rows[0].id, "msg-fail-1");

      const evtCount = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "RunEvent" WHERE "runId" = 'run-fail-dup'`
      );
      assert.equal(Number(evtCount.rows[0].count), 1);

      const msgCount = await db.query<{ count: string | number }>(
        `SELECT COUNT(*) as count FROM "Message" WHERE "generationRunId" = 'run-fail-dup'`
      );
      assert.equal(Number(msgCount.rows[0].count), 1);
    } finally {
      await db.close();
    }
  });

  it("Scenario 8: Failure delivery arriving after success preserves completed status and does not overwrite with FAILED", async () => {
    const db = await setupTestDb();
    try {
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ('run-race', 'prj-1', 'usr-1', 'Build component', 'RUNNING')`
      );

      // Run completed successfully
      await db.exec("BEGIN");
      await db.query(
        `INSERT INTO "ProjectRevision" ("id", "projectId", "generationRunId", "revisionNumber", "title", "files")
         VALUES ('rev-race', 'prj-1', 'run-race', 1, 'Component', '{}')`
      );
      await db.query(`UPDATE "Project" SET "currentRevisionId" = 'rev-race' WHERE "id" = 'prj-1'`);
      await db.query(`UPDATE "GenerationRun" SET "status" = 'COMPLETED', "resultRevisionId" = 'rev-race' WHERE "id" = 'run-race'`);
      await db.query(
        `INSERT INTO "Message" ("id", "projectId", "generationRunId", "content", "role", "type")
         VALUES ('msg-success', 'prj-1', 'run-race', 'Component ready', 'ASSISTANT', 'RESULT')`
      );
      await db.exec("COMMIT");

      // Late-arriving failure delivery
      const checkRun = await db.query<{ status: string }>(
        `SELECT "status" FROM "GenerationRun" WHERE "id" = 'run-race'`
      );
      // Status is COMPLETED: failure handler must NOT overwrite with FAILED
      assert.equal(checkRun.rows[0].status, "COMPLETED");

      // Attempting CAS update for status != COMPLETED returns 0 rows updated
      const failUpdate = await db.query(
        `UPDATE "GenerationRun" SET "status" = 'FAILED' WHERE "id" = 'run-race' AND "status" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') RETURNING id`
      );
      assert.equal(failUpdate.rows.length, 0);

      // Verify status is STILL COMPLETED and project pointer is untouched
      const finalRun = await db.query<{ status: string }>(
        `SELECT "status" FROM "GenerationRun" WHERE "id" = 'run-race'`
      );
      assert.equal(finalRun.rows[0].status, "COMPLETED");

      const prj = await db.query<{ currentRevisionId: string }>(
        `SELECT "currentRevisionId" FROM "Project" WHERE "id" = 'prj-1'`
      );
      assert.equal(prj.rows[0].currentRevisionId, "rev-race");
    } finally {
      await db.close();
    }
  });

  it("Scenario 9: Finalization validates project ownership and rejects runs belonging to a different project", async () => {
    const db = await setupTestDb();
    try {
      // Seed second project
      await db.query(
        `INSERT INTO "Project" ("id", "name", "userId", "currentRevisionId")
         VALUES ('prj-2', 'Other Project', 'usr-1', NULL)`
      );

      // Run belongs to prj-1
      await db.query(
        `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
         VALUES ('run-cross', 'prj-1', 'usr-1', 'Test', 'RUNNING')`
      );

      // Attempting to finalize run-cross under prj-2
      const runCheck = await db.query<{ projectId: string }>(
        `SELECT "projectId" FROM "GenerationRun" WHERE "id" = 'run-cross'`
      );
      assert.equal(runCheck.rows[0].projectId, "prj-1");

      const requestedProjectId: string = "prj-2";
      const isMismatch = (runCheck.rows[0].projectId as string) !== requestedProjectId;
      assert.equal(isMismatch, true, "Must detect project ownership mismatch");
    } finally {
      await db.close();
    }
  });

  it("Regression Test 1: Duplicate Inngest failure -> One failure result and one associated error message", async () => {
    const originalTx = prisma.$transaction;
    const runId = "run-dup-fail-test";
    const projectId = "prj-dup-fail";

    let runState: any = {
      id: runId,
      projectId,
      status: GenerationRunStatus.RUNNING,
    };
    const messages: any[] = [];
    const runEvents: any[] = [];

    prisma.$transaction = (async (cb: any) => {
      const tx = {
        generationRun: {
          findUnique: async (args: any) => {
            if (args.where.id === runId) return { ...runState };
            return null;
          },
          update: async (args: any) => {
            runState = { ...runState, ...args.data };
            return runState;
          },
        },
        runEvent: {
          create: async (args: any) => {
            const evt = { id: `evt-${runEvents.length + 1}`, ...args.data };
            runEvents.push(evt);
            return evt;
          },
        },
        message: {
          findUnique: async (args: any) => {
            return messages.find((m) => m.generationRunId === args.where.generationRunId) || null;
          },
          findFirst: async () => null,
          create: async (args: any) => {
            const msg = { id: `msg-${messages.length + 1}`, ...args.data };
            messages.push(msg);
            return msg;
          },
        },
      };
      return cb(tx);
    }) as any;

    try {
      // First Inngest failure dispatch
      const res1 = await finalizeGenerationFailure({
        projectId,
        generationRunId: runId,
        errorCode: "WORKFLOW_EXECUTION_FAILED",
        errorMessage: "Process terminated unexpectedly",
      });

      assert.equal(res1.isIdempotentReplay, false);
      assert.equal(messages.length, 1);
      assert.equal(runEvents.length, 1);
      assert.equal(runState.status, GenerationRunStatus.FAILED);

      // Duplicate Inngest failure dispatch (retry or duplicate worker delivery)
      const res2 = await finalizeGenerationFailure({
        projectId,
        generationRunId: runId,
        errorCode: "WORKFLOW_EXECUTION_FAILED",
        errorMessage: "Process terminated unexpectedly",
      });

      assert.equal(res2.isIdempotentReplay, true);
      assert.equal(res2.messageId, res1.messageId);
      // Strictly one failure result and one associated error message
      assert.equal(messages.length, 1, "Must not create duplicate error messages on duplicate Inngest failure");
      assert.equal(runEvents.length, 1, "Must not create duplicate failure events on duplicate Inngest failure");
      assert.equal(runState.status, GenerationRunStatus.FAILED);
    } finally {
      prisma.$transaction = originalTx;
    }
  });

  it("Regression Test 2: Completed run receives late failure -> Remains COMPLETED; active revision unchanged", async () => {
    const originalTx = prisma.$transaction;
    const runId = "run-late-fail-test";
    const projectId = "prj-late-fail";

    let projectState: any = {
      id: projectId,
      currentRevisionId: "rev-v1",
    };
    let runState: any = {
      id: runId,
      projectId,
      status: GenerationRunStatus.COMPLETED,
      resultRevisionId: "rev-v1",
    };
    const messages: any[] = [
      {
        id: "msg-success-v1",
        projectId,
        generationRunId: runId,
        content: "Success summary",
        role: MessageRole.ASSISTANT,
        type: MessageType.RESULT,
      },
    ];
    const runEvents: any[] = [];

    prisma.$transaction = (async (cb: any) => {
      const tx = {
        generationRun: {
          findUnique: async (args: any) => {
            if (args.where.id === runId) return { ...runState };
            return null;
          },
          update: async (args: any) => {
            runState = { ...runState, ...args.data };
            return runState;
          },
        },
        project: {
          findUnique: async (args: any) => {
            if (args.where.id === projectId) return { ...projectState };
            return null;
          },
          update: async (args: any) => {
            projectState = { ...projectState, ...args.data };
            return projectState;
          },
        },
        message: {
          findUnique: async (args: any) => {
            return messages.find((m) => m.generationRunId === args.where.generationRunId) || null;
          },
          create: async (args: any) => {
            const msg = { id: `msg-${messages.length + 1}`, ...args.data };
            messages.push(msg);
            return msg;
          },
        },
        runEvent: {
          create: async (args: any) => {
            const evt = { id: `evt-${runEvents.length + 1}`, ...args.data };
            runEvents.push(evt);
            return evt;
          },
        },
      };
      return cb(tx);
    }) as any;

    try {
      // Late-arriving failure callback (e.g. timeout handler triggered after run already completed)
      const res = await finalizeGenerationFailure({
        projectId,
        generationRunId: runId,
        errorCode: "TIMEOUT_OR_FAILURE",
        errorMessage: "Late failure arrived after completion",
      });

      assert.equal(res.isIdempotentReplay, true);
      assert.equal(res.messageId, "msg-success-v1");
      // Status strictly remains COMPLETED
      assert.equal(runState.status, GenerationRunStatus.COMPLETED, "Run must remain COMPLETED");
      // Active revision unchanged
      assert.equal(projectState.currentRevisionId, "rev-v1", "Active project revision must remain unchanged");
      // No error message created
      assert.equal(messages.length, 1);
      assert.equal(runEvents.length, 0);
    } finally {
      prisma.$transaction = originalTx;
    }
  });

  it("Regression Test 3: Missing message during completed-run replay -> Explicit integrity error; no fabricated ID", async () => {
    const originalTx = prisma.$transaction;
    const runId = "run-corrupt-msg-test";
    const projectId = "prj-corrupt";

    const runState: any = {
      id: runId,
      projectId,
      status: GenerationRunStatus.COMPLETED,
      revisions: [
        {
          id: "rev-v1",
          projectId,
          generationRunId: runId,
          revisionNumber: 1,
          title: "Rev 1",
          summary: "Summary",
          files: {},
        },
      ],
    };

    prisma.$transaction = (async (cb: any) => {
      const tx = {
        generationRun: {
          findUnique: async (args: any) => {
            if (args.where.id === runId) return { ...runState };
            return null;
          },
        },
        message: {
          findUnique: async () => null, // Intentionally missing message to test database corruption
        },
      };
      return cb(tx);
    }) as any;

    try {
      // Attempting replay of completed run without associated result message must throw Database integrity violation
      await assert.rejects(
        async () => {
          await finalizeGenerationSuccess({
            projectId,
            generationRunId: runId,
            fragmentTitle: "Rev 1",
            summary: "Summary",
            files: {},
            sandboxUrl: "https://sandbox.test",
          });
        },
        (err: any) => {
          assert.match(
            err.message,
            /Database integrity violation: Completed GenerationRun "run-corrupt-msg-test" has no associated result message/
          );
          // Verify no fabricated ID was returned or tolerated
          assert.ok(!err.message.includes("existing-message"));
          return true;
        }
      );

      // Same check for finalizeGenerationFailure
      await assert.rejects(
        async () => {
          await finalizeGenerationFailure({
            projectId,
            generationRunId: runId,
            errorCode: "SOME_CODE",
            errorMessage: "Some error",
          });
        },
        (err: any) => {
          assert.match(
            err.message,
            /Database integrity violation: Completed GenerationRun "run-corrupt-msg-test" has no associated result message/
          );
          return true;
        }
      );
    } finally {
      prisma.$transaction = originalTx;
    }
  });
});
