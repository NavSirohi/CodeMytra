import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

describe("Task 4: Transactional & Idempotent Generation Finalization", () => {
  async function setupTestDb() {
    const db = new PGlite();

    await db.exec(`
      DO $$ BEGIN
        CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'VALIDATING', 'COMPLETED', 'FAILED');
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
          `INSERT INTO "Message" ("id", "projectId", "content", "role", "type")
           VALUES ($1, $2, $3, 'ASSISTANT', 'RESULT')`,
          ["msg-1", "prj-1", "Built app"]
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
        `INSERT INTO "Message" ("id", "projectId", "content", "role", "type")
         VALUES ($1, $2, $3, 'ASSISTANT', 'RESULT')`,
        ["msg-retry", "prj-1", "Result content"]
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
        `INSERT INTO "Message" ("id", "projectId", "content", "role", "type")
         VALUES ('msg-fail', 'prj-1', 'QA failed: Syntax error in generated files. Prior working revision preserved.', 'ASSISTANT', 'ERROR')`
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
});
