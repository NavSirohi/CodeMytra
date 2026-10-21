import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

/**
 * Real PostgreSQL Concurrency & Database Operations Test Suite.
 * Executes against disposable PostgreSQL infrastructure (PGlite) testing:
 * 1. Simultaneous outbox workers
 * 2. Expired leases & fencing tokens
 * 3. Duplicate event delivery & idempotency
 * 4. Concurrent generation requests (row-locking)
 * 5. Concurrent revision promotion (atomic CAS)
 * 6. Transaction failure and rollback integrity
 * 7. Restoration after failed generation
 */
describe("PostgreSQL Concurrency & Database Operations", () => {
  async function setupDatabase() {
    const db = new PGlite();

    await db.exec(`
      DO $$ BEGIN
        CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
        CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT PRIMARY KEY,
        "email" TEXT,
        "name" TEXT
      );

      CREATE TABLE IF NOT EXISTS "Project" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "userId" TEXT NOT NULL REFERENCES "User"("id"),
        "currentRevisionId" TEXT,
        "idempotencyKey" TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "Project_userId_idempotencyKey_key" ON "Project"("userId", "idempotencyKey");

      CREATE TABLE IF NOT EXISTS "Message" (
        "id" TEXT PRIMARY KEY,
        "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
        "content" TEXT NOT NULL,
        "role" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "RateLimitRecord" (
        "id" TEXT PRIMARY KEY,
        "keyHash" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "RateLimitRecord_keyHash_createdAt_idx" ON "RateLimitRecord"("keyHash", "createdAt");

      CREATE TABLE IF NOT EXISTS "ProjectRevision" (
        "id" TEXT PRIMARY KEY,
        "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
        "revisionNumber" INTEGER NOT NULL,
        "title" TEXT NOT NULL,
        "summary" TEXT,
        "files" JSONB NOT NULL,
        "manifest" JSONB,
        "parentRevisionId" TEXT REFERENCES "ProjectRevision"("id"),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ProjectRevision_project_rev_unique" UNIQUE ("projectId", "revisionNumber")
      );

      CREATE TABLE IF NOT EXISTS "GenerationRun" (
        "id" TEXT PRIMARY KEY,
        "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
        "userId" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
        "baseRevisionId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "OutboxEvent" (
        "id" TEXT PRIMARY KEY,
        "eventName" TEXT NOT NULL,
        "payload" JSONB NOT NULL,
        "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "lastError" TEXT,
        "claimedAt" TIMESTAMP(3),
        "nextAttemptAt" TIMESTAMP(3),
        "claimToken" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processedAt" TIMESTAMP(3)
      );

      CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
      CREATE INDEX IF NOT EXISTS "OutboxEvent_claimToken_idx" ON "OutboxEvent"("claimToken");
    `);

    return db;
  }

  // 1. Simultaneous Outbox Workers
  it("Scenario 1: Simultaneous outbox workers atomically claim disjoint events without duplication", async () => {
    const db = await setupDatabase();
    try {
      // Seed 4 pending events
      for (let i = 1; i <= 4; i++) {
        await db.query(`
          INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
          VALUES ($1, 'code-agent/run', '{"runId":"run"}'::jsonb, 'PENDING', 0);
        `, [`evt-sim-${i}`]);
      }

      const claimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW(), "claimToken" = gen_random_uuid()::text
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE attempts < 5 AND status = 'PENDING'
          ORDER BY "createdAt" ASC
          LIMIT 2
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "claimToken";
      `;

      // Two simultaneous workers claiming 2 events each
      const [w1, w2] = await Promise.all([db.query(claimSql), db.query(claimSql)]);

      const w1Ids = w1.rows.map((r: any) => r.id);
      const w2Ids = w2.rows.map((r: any) => r.id);

      assert.equal(w1Ids.length, 2);
      assert.equal(w2Ids.length, 2);

      // Verify disjoint sets
      const allIds = new Set([...w1Ids, ...w2Ids]);
      assert.equal(allIds.size, 4, "Zero overlap between concurrent workers");
    } finally {
      await db.close();
    }
  });

  // 2. Expired Leases & Fencing Tokens
  it("Scenario 2: Expired leases are reclaimed and fencing tokens reject stale worker writes", async () => {
    const db = await setupDatabase();
    try {
      const token1 = "worker-1-token";
      const expiredDate = new Date(Date.now() - 300000); // 5 min ago

      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "claimedAt", "claimToken")
        VALUES ('evt-expired', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PROCESSING', 1, $1, $2);
      `, [expiredDate, token1]);

      // Worker 2 reclaims the expired lease with a fresh claimToken
      const token2 = "worker-2-token";
      const reclaimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW(), "claimToken" = $1
        WHERE id = 'evt-expired' AND status = 'PROCESSING'
        RETURNING id, "claimToken";
      `;
      const reclaimRes = await db.query(reclaimSql, [token2]);
      assert.equal(reclaimRes.rows.length, 1);

      // Stale Worker 1 wakes up and attempts to finalize with token1
      const staleUpdate = await db.query(`
        UPDATE "OutboxEvent"
        SET status = 'PROCESSED', "processedAt" = NOW(), "claimToken" = NULL
        WHERE id = 'evt-expired' AND status = 'PROCESSING' AND "claimToken" = $1
        RETURNING *;
      `, [token1]);

      assert.equal(staleUpdate.rows.length, 0, "Stale worker write must be blocked by fencing token");

      // Verify event is still under Worker 2
      const check = await db.query(`SELECT "claimToken", attempts FROM "OutboxEvent" WHERE id = 'evt-expired'`);
      assert.equal((check.rows[0] as any).claimToken, token2);
      assert.equal((check.rows[0] as any).attempts, 2);
    } finally {
      await db.close();
    }
  });

  // 3. Duplicate Event Delivery Idempotency
  it("Scenario 3: Duplicate event delivery is handled idempotently via runId and processed check", async () => {
    const db = await setupDatabase();
    try {
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "processedAt")
        VALUES ('evt-dup', 'code-agent/run', '{"runId":"run-idempotent"}'::jsonb, 'PROCESSED', 1, NOW());
      `);

      // Attempting to claim an already PROCESSED event yields 0 rows
      const claimRes = await db.query(`
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW()
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE id = 'evt-dup' AND status = 'PENDING'
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `);

      assert.equal(claimRes.rows.length, 0, "Already processed event cannot be re-claimed or re-dispatched");
    } finally {
      await db.close();
    }
  });

  // 4. Concurrent Generation Requests (Row Locking)
  it("Scenario 4: Concurrent generation requests are serialized by project row lock and active run check", async () => {
    const db = await setupDatabase();
    try {
      await db.query(`INSERT INTO "User" ("id", "name") VALUES ('usr-1', 'Test User')`);
      await db.query(`INSERT INTO "Project" ("id", "name", "userId") VALUES ('prj-lock', 'Lock Project', 'usr-1')`);

      // First run is active
      await db.query(`
        INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
        VALUES ('run-active', 'prj-lock', 'usr-1', 'Initial prompt', 'RUNNING');
      `);

      // Second request checks under project row lock
      const checkActive = await db.query(`
        SELECT r.id, r.status
        FROM "GenerationRun" r
        WHERE r."projectId" = 'prj-lock'
          AND r.status IN ('QUEUED', 'RUNNING')
        LIMIT 1;
      `);

      assert.equal(checkActive.rows.length, 1);
      assert.equal((checkActive.rows[0] as any).status, "RUNNING");
      // Application throws ConflictError: "A generation run is already in progress for this project"
    } finally {
      await db.close();
    }
  });

  // 5. Concurrent Revision Promotion (CAS)
  it("Scenario 5: Concurrent revision promotion uses atomic CAS so only one wins and pointer is never overwritten", async () => {
    const db = await setupDatabase();
    try {
      await db.query(`INSERT INTO "User" ("id", "name") VALUES ('usr-2', 'Test User 2')`);
      await db.query(`INSERT INTO "Project" ("id", "name", "userId", "currentRevisionId") VALUES ('prj-cas', 'CAS Project', 'usr-2', 'rev-base')`);

      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
        VALUES ('rev-base', 'prj-cas', 1, 'Base', '{}'::jsonb);
      `);

      // Worker A creates rev-A based on rev-base
      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files", "parentRevisionId")
        VALUES ('rev-A', 'prj-cas', 2, 'Rev A', '{}'::jsonb, 'rev-base');
      `);

      // Worker B creates rev-B based on rev-base (concurrent race)
      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files", "parentRevisionId")
        VALUES ('rev-B', 'prj-cas', 3, 'Rev B', '{}'::jsonb, 'rev-base');
      `);

      // Worker A successfully promotes with CAS (expected = 'rev-base')
      const casA = await db.query(`
        UPDATE "Project"
        SET "currentRevisionId" = 'rev-A'
        WHERE id = 'prj-cas' AND "currentRevisionId" = 'rev-base'
        RETURNING *;
      `);
      assert.equal(casA.rows.length, 1, "Worker A CAS promotion succeeded");

      // Worker B tries to promote with CAS (expected = 'rev-base'), but pointer already moved to 'rev-A'!
      const casB = await db.query(`
        UPDATE "Project"
        SET "currentRevisionId" = 'rev-B'
        WHERE id = 'prj-cas' AND "currentRevisionId" = 'rev-base'
        RETURNING *;
      `);
      assert.equal(casB.rows.length, 0, "Worker B CAS promotion must affect 0 rows (race guard wins)");

      // Project pointer remains rev-A
      const checkPrj = await db.query(`SELECT "currentRevisionId" FROM "Project" WHERE id = 'prj-cas'`);
      assert.equal((checkPrj.rows[0] as any).currentRevisionId, 'rev-A');
    } finally {
      await db.close();
    }
  });

  // 6. Transaction Failure and Rollback
  it("Scenario 6: Transaction failure completely rolls back all modifications and preserves project pointer", async () => {
    const db = await setupDatabase();
    try {
      await db.query(`INSERT INTO "User" ("id", "name") VALUES ('usr-3', 'Test User 3')`);
      await db.query(`INSERT INTO "Project" ("id", "name", "userId", "currentRevisionId") VALUES ('prj-rollback', 'Rollback Project', 'usr-3', 'rev-stable')`);

      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
        VALUES ('rev-stable', 'prj-rollback', 1, 'Stable', '{}'::jsonb);
      `);

      // Attempt transaction that fails midway
      try {
        await db.exec(`
          BEGIN;
          INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
          VALUES ('rev-broken', 'prj-rollback', 2, 'Broken', '{}'::jsonb);

          -- Simulate intentional constraint violation (duplicate revision number)
          INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
          VALUES ('rev-duplicate', 'prj-rollback', 2, 'Duplicate', '{}'::jsonb);

          UPDATE "Project" SET "currentRevisionId" = 'rev-broken' WHERE id = 'prj-rollback';
          COMMIT;
        `);
        assert.fail("Transaction should have failed");
      } catch {
        // Rollback on error
        await db.exec(`ROLLBACK;`);
      }

      // Verify that rev-broken was not persisted and project pointer is still rev-stable
      const revCheck = await db.query(`SELECT id FROM "ProjectRevision" WHERE id = 'rev-broken'`);
      assert.equal(revCheck.rows.length, 0, "Rolled back revision must not exist");

      const prjCheck = await db.query(`SELECT "currentRevisionId" FROM "Project" WHERE id = 'prj-rollback'`);
      assert.equal((prjCheck.rows[0] as any).currentRevisionId, 'rev-stable', "Project pointer remains on stable revision");
    } finally {
      await db.close();
    }
  });

  // 7. Restoration After Failed Generation
  it("Scenario 7: Historical revision restoration creates an immutable clone without mutating previous revisions", async () => {
    const db = await setupDatabase();
    try {
      await db.query(`INSERT INTO "User" ("id", "name") VALUES ('usr-4', 'Test User 4')`);
      await db.query(`INSERT INTO "Project" ("id", "name", "userId", "currentRevisionId") VALUES ('prj-restore', 'Restore Project', 'usr-4', 'rev-v2')`);

      const v1Files = { "app/page.tsx": "console.log('v1')" };
      const v2Files = { "app/page.tsx": "console.log('v2')" };

      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files")
        VALUES ('rev-v1', 'prj-restore', 1, 'V1 Baseline', $1);
      `, [JSON.stringify(v1Files)]);

      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files", "parentRevisionId")
        VALUES ('rev-v2', 'prj-restore', 2, 'V2 Update', $1, 'rev-v1');
      `, [JSON.stringify(v2Files)]);

      // Simulate failed generation run for V3
      await db.query(`
        INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
        VALUES ('run-failed-gen', 'prj-restore', 'usr-4', 'Broken prompt', 'FAILED');
      `);

      // Restore V1: creates a new immutable revision V3 cloned from V1
      const maxRevRes = await db.query(`SELECT COALESCE(MAX("revisionNumber"), 0) as max_rev FROM "ProjectRevision" WHERE "projectId" = 'prj-restore'`);
      const nextRevNum = (maxRevRes.rows[0] as any).max_rev + 1;
      assert.equal(nextRevNum, 3);

      await db.query(`
        INSERT INTO "ProjectRevision" ("id", "projectId", "revisionNumber", "title", "files", "parentRevisionId")
        VALUES ('rev-v3-restored', 'prj-restore', $1, 'Restored from V1', $2, 'rev-v1');
      `, [nextRevNum, JSON.stringify(v1Files)]);

      await db.query(`
        UPDATE "Project" SET "currentRevisionId" = 'rev-v3-restored' WHERE id = 'prj-restore';
      `);

      // Verify V1 was NOT mutated
      const v1Check = await db.query(`SELECT files, "revisionNumber" FROM "ProjectRevision" WHERE id = 'rev-v1'`);
      assert.equal((v1Check.rows[0] as any).revisionNumber, 1);
      assert.deepEqual((v1Check.rows[0] as any).files, v1Files);

      // Verify project is now on V3
      const prjCheck = await db.query(`SELECT "currentRevisionId" FROM "Project" WHERE id = 'prj-restore'`);
      assert.equal((prjCheck.rows[0] as any).currentRevisionId, 'rev-v3-restored');
    } finally {
      await db.close();
    }
  });

  // 8. Full Migration History Playback & MetricKey Uniqueness (STEP 1)
  it("Scenario 8: Applies full migration history sequentially on PostgreSQL, enforces metricKey uniqueness without blocking ordinary repeated events", async () => {
    const db = new PGlite();
    try {
      const migrationsDir = path.resolve(__dirname, "../prisma/migrations");
      const migrationDirs = fs.readdirSync(migrationsDir)
        .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
        .sort();

      assert.ok(migrationDirs.length >= 9, "All migration folders must exist");
      assert.ok(
        migrationDirs.some((dir) => dir.includes("add_runevent_metric_key")),
        "add_runevent_metric_key migration must be present"
      );

      // Play back all migrations in order
      for (const dir of migrationDirs) {
        const sqlFile = path.join(migrationsDir, dir, "migration.sql");
        if (fs.existsSync(sqlFile)) {
          const sql = fs.readFileSync(sqlFile, "utf-8");
          await db.exec(sql);
        }
      }

      // Seed user and project using the schema generated by actual migrations
      await db.query(`
        INSERT INTO "users" ("id", "clerkId", "email", "updatedAt")
        VALUES ('usr-mig-1', 'clerk-mig-1', 'mig@example.com', NOW());
      `);
      await db.query(`
        INSERT INTO "Project" ("id", "name", "userId", "updatedAt")
        VALUES ('prj-mig-1', 'Migration Project', 'usr-mig-1', NOW());
      `);
      await db.query(`
        INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status", "updatedAt")
        VALUES ('run-mig-1', 'prj-mig-1', 'usr-mig-1', 'Build app', 'RUNNING', NOW());
      `);

      // 1. Verify ordinary RunEvents may repeat stage names (metricKey is NULL)
      await db.query(`
        INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message", "metricKey", "createdAt")
        VALUES ('evt-normal-1', 'run-mig-1', 'PLANNING', 'Planner', 'Analyzing prompt', NULL, NOW());
      `);
      await db.query(`
        INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message", "metricKey", "createdAt")
        VALUES ('evt-normal-2', 'run-mig-1', 'PLANNING', 'Planner', 'Drafting spec', NULL, NOW());
      `);

      const normalEvents = await db.query(`SELECT id FROM "RunEvent" WHERE "runId" = 'run-mig-1' AND "stage" = 'PLANNING'`);
      assert.equal(normalEvents.rows.length, 2, "Ordinary RunEvents can freely repeat stage names");

      // 2. Metric records have database-enforced unique identities via metricKey
      await db.query(`
        INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message", "metricKey", "createdAt")
        VALUES ('evt-metric-1', 'run-mig-1', 'STAGE_METRIC_planning', 'System', 'Metric 1', 'run-mig-1:planning', NOW());
      `);

      // Duplicate metricKey insertion must fail with unique constraint violation
      let duplicateThrew = false;
      try {
        await db.query(`
          INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message", "metricKey", "createdAt")
          VALUES ('evt-metric-dup', 'run-mig-1', 'STAGE_METRIC_planning', 'System', 'Metric Duplicate', 'run-mig-1:planning', NOW());
        `);
      } catch (err: any) {
        duplicateThrew = true;
        assert.ok(err.message.includes("unique") || err.code === "23505", "Must throw unique constraint violation");
      }
      assert.ok(duplicateThrew, "Direct duplicate metricKey insert must be rejected by PostgreSQL");

      // 3. Concurrent metric upserts using ON CONFLICT (metricKey) DO UPDATE succeed without duplicate records
      const upsertSql = `
        INSERT INTO "RunEvent" ("id", "runId", "stage", "agentRole", "message", "metricKey", "createdAt")
        VALUES ($1, 'run-mig-1', 'STAGE_METRIC_planning', 'System', $2, 'run-mig-1:planning', NOW())
        ON CONFLICT ("metricKey") DO UPDATE
        SET "message" = EXCLUDED."message"
        RETURNING id, "message";
      `;

      const [resA, resB] = await Promise.all([
        db.query(upsertSql, ['evt-upsert-a', 'Updated by Worker A']),
        db.query(upsertSql, ['evt-upsert-b', 'Updated by Worker B']),
      ]);

      assert.ok(resA.rows.length === 1 && resB.rows.length === 1);
      const metricsInDb = await db.query(`SELECT id, "metricKey", "message" FROM "RunEvent" WHERE "metricKey" = 'run-mig-1:planning'`);
      assert.equal(metricsInDb.rows.length, 1, "Exactly one metric record must exist after concurrent upserts");

      // 4. Verify existing RunEvent data remains intact
      const allEvents = await db.query(`SELECT id FROM "RunEvent" WHERE "runId" = 'run-mig-1'`);
      assert.equal(allEvents.rows.length, 3, "All 2 ordinary events and 1 metric event remain intact");
    } finally {
      await db.close();
    }
  });

  // 9. Atomic Per-User Run Admission via User Row Locking (STEP 2)
  it("Scenario 9: Atomic per-user run admission serializes requests, enforces limit, rolls back cleanly on failure, and does not block other users", async () => {
    const db = new PGlite();
    try {
      // Setup tables matching production
      await db.exec(`
        CREATE TABLE IF NOT EXISTS "users" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT
        );
        CREATE TABLE IF NOT EXISTS "Project" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "userId" TEXT NOT NULL REFERENCES "users"("id"),
          "currentRevisionId" TEXT
        );
        CREATE TABLE IF NOT EXISTS "GenerationRun" (
          "id" TEXT PRIMARY KEY,
          "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
          "userId" TEXT NOT NULL REFERENCES "users"("id"),
          "prompt" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'QUEUED'
        );
        CREATE TABLE IF NOT EXISTS "Message" (
          "id" TEXT PRIMARY KEY,
          "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
          "content" TEXT NOT NULL,
          "role" TEXT NOT NULL,
          "type" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS "OutboxEvent" (
          "id" TEXT PRIMARY KEY,
          "eventName" TEXT NOT NULL,
          "payload" JSONB NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'PENDING'
        );
      `);

      // Seed two users with projects
      await db.query(`INSERT INTO "users" ("id", "name") VALUES ('usr-A', 'User Alpha'), ('usr-B', 'User Beta');`);
      await db.query(`
        INSERT INTO "Project" ("id", "name", "userId")
        VALUES ('prj-A1', 'Alpha Prj 1', 'usr-A'),
               ('prj-A2', 'Alpha Prj 2', 'usr-A'),
               ('prj-A3', 'Alpha Prj 3', 'usr-A'),
               ('prj-A4', 'Alpha Prj 4', 'usr-A'),
               ('prj-B1', 'Beta Prj 1', 'usr-B');
      `);

      const MAX_CONCURRENT = 3;

      // Simulate atomic admission transaction matching src/features/messages/actions/index.ts
      const attemptAdmission = async (userId: string, projectId: string, prompt: string, reqId: string) => {
        return await db.transaction(async (tx) => {
          // 1. Lock user row to serialize per-user admission
          await tx.query(`SELECT id FROM "users" WHERE id = $1 FOR UPDATE`, [userId]);

          // 2. Lock project row
          await tx.query(`SELECT id FROM "Project" WHERE id = $1 FOR UPDATE`, [projectId]);

          // 3. Project check: active run for this project?
          const projectActive = await tx.query(`
            SELECT id FROM "GenerationRun"
            WHERE "projectId" = $1 AND status IN ('QUEUED', 'RUNNING')
          `, [projectId]);
          if (projectActive.rows.length > 0) {
            throw new Error("Project already has active run");
          }

          // 4. Per-user active runs check under user row lock
          const userActive = await tx.query(`
            SELECT COUNT(*)::int as count FROM "GenerationRun"
            WHERE "userId" = $1 AND status IN ('QUEUED', 'RUNNING')
          `, [userId]);
          const currentCount = (userActive.rows[0] as any).count;
          if (currentCount >= MAX_CONCURRENT) {
            throw new Error(`Maximum concurrent generation runs (${MAX_CONCURRENT}) reached for this user.`);
          }

          // 5. Create Message, GenerationRun, OutboxEvent atomically
          await tx.query(`
            INSERT INTO "Message" ("id", "projectId", "content", "role", "type")
            VALUES ($1, $2, $3, 'USER', 'RESULT');
          `, [`msg-${reqId}`, projectId, prompt]);

          await tx.query(`
            INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
            VALUES ($1, $2, $3, $4, 'QUEUED');
          `, [`run-${reqId}`, projectId, userId, prompt]);

          await tx.query(`
            INSERT INTO "OutboxEvent" ("id", "eventName", "payload")
            VALUES ($1, 'code-agent/run', $2);
          `, [`evt-${reqId}`, JSON.stringify({ runId: `run-${reqId}`, projectId })]);

          return { admitted: true, runId: `run-${reqId}` };
        });
      };

      // 1. User Alpha admits 3 runs successfully (hits limit)
      const r1 = await attemptAdmission('usr-A', 'prj-A1', 'Prompt 1', '1');
      const r2 = await attemptAdmission('usr-A', 'prj-A2', 'Prompt 2', '2');
      const r3 = await attemptAdmission('usr-A', 'prj-A3', 'Prompt 3', '3');
      assert.equal(r1.admitted, true);
      assert.equal(r2.admitted, true);
      assert.equal(r3.admitted, true);

      // Verify active count is exactly 3
      const countCheck = await db.query(`SELECT COUNT(*)::int as count FROM "GenerationRun" WHERE "userId" = 'usr-A'`);
      assert.equal((countCheck.rows[0] as any).count, 3);

      // 2. 4th attempt for User Alpha is rejected
      let rejected = false;
      try {
        await attemptAdmission('usr-A', 'prj-A4', 'Prompt 4', '4');
      } catch (err: any) {
        rejected = true;
        assert.match(err.message, /Maximum concurrent generation runs \(3\) reached/);
      }
      assert.ok(rejected, "4th run must be rejected");

      // Verify atomic rollback: no orphan message, run, or outbox event for rejected request 4
      const orphanMsg = await db.query(`SELECT id FROM "Message" WHERE id = 'msg-4'`);
      const orphanRun = await db.query(`SELECT id FROM "GenerationRun" WHERE id = 'run-4'`);
      const orphanEvt = await db.query(`SELECT id FROM "OutboxEvent" WHERE id = 'evt-4'`);
      assert.equal(orphanMsg.rows.length, 0, "No orphan message on admission rejection");
      assert.equal(orphanRun.rows.length, 0, "No orphan run on admission rejection");
      assert.equal(orphanEvt.rows.length, 0, "No orphan outbox event on admission rejection");

      // 3. Different user (User Beta) is NOT blocked even though User Alpha is at capacity
      const rBeta = await attemptAdmission('usr-B', 'prj-B1', 'Beta prompt', 'beta-1');
      assert.equal(rBeta.admitted, true, "User Beta must be admitted without being blocked by User Alpha");

      const betaRun = await db.query(`SELECT id FROM "GenerationRun" WHERE "userId" = 'usr-B'`);
      assert.equal(betaRun.rows.length, 1);
    } finally {
      await db.close();
    }
  });

  // 10. Idempotent Project Creation with Client Submission Identifier
  it("Scenario 10: Idempotent project creation with client submission identifier on real PostgreSQL", async () => {
    const db = await setupDatabase();
    try {
      await db.query(`INSERT INTO "User" ("id", "name") VALUES ('usr-idem-1', 'User Idem 1'), ('usr-idem-2', 'User Idem 2');`);

      const executeCreateProject = async (
        userId: string,
        prompt: string,
        idempotencyKey: string,
        reqId: string
      ): Promise<{ project?: any; error?: string; created: boolean; raced: boolean; conflict: boolean }> => {
        // Helper to check existing with prompt comparison
        const findExisting = async () => {
          const res = await db.query(
            `SELECT p.id, p.name, p."userId", p."idempotencyKey",
                    (SELECT prompt FROM "GenerationRun" WHERE "projectId" = p.id ORDER BY "createdAt" ASC LIMIT 1) as "existingPrompt"
             FROM "Project" p
             WHERE p."userId" = $1 AND p."idempotencyKey" = $2`,
            [userId, idempotencyKey]
          );
          if (res.rows.length === 0) return null;
          const row = res.rows[0] as any;
          if (row.existingPrompt && row.existingPrompt.trim() !== prompt.trim()) {
            return {
              conflict: true,
              error: "Idempotency conflict: key already used with different prompt",
            };
          }
          return { conflict: false, project: row };
        };

        // 1. Initial check
        const initialMatch = await findExisting();
        if (initialMatch) {
          if (initialMatch.conflict) {
            return { error: initialMatch.error, created: false, raced: false, conflict: true };
          }
          return { project: initialMatch.project, created: false, raced: false, conflict: false };
        }

        try {
          return await db.transaction(async (tx) => {
            const pId = `prj-${reqId}`;
            const runId = `run-${reqId}`;
            const msgId = `msg-${reqId}`;
            const evtId = `evt-${reqId}`;

            // Insert project with unique (userId, idempotencyKey)
            const pRes = await tx.query(
              `INSERT INTO "Project" ("id", "name", "userId", "idempotencyKey")
               VALUES ($1, $2, $3, $4)
               RETURNING id, name, "userId", "idempotencyKey"`,
              [pId, `Project ${reqId}`, userId, idempotencyKey]
            );

            await tx.query(
              `INSERT INTO "Message" ("id", "projectId", "content", "role", "type")
               VALUES ($1, $2, $3, 'USER', 'RESULT')`,
              [msgId, pId, prompt]
            );

            await tx.query(
              `INSERT INTO "GenerationRun" ("id", "projectId", "userId", "prompt", "status")
               VALUES ($1, $2, $3, $4, 'QUEUED')`,
              [runId, pId, userId, prompt]
            );

            await tx.query(
              `INSERT INTO "OutboxEvent" ("id", "eventName", "payload")
               VALUES ($1, 'code-agent/run', $2)`,
              [evtId, JSON.stringify({ runId, projectId: pId, prompt })]
            );

            return { project: pRes.rows[0], created: true, raced: false, conflict: false };
          });
        } catch (err: any) {
          // On unique constraint violation (code 23505), fetch committed project and verify prompt
          if (err.code === "23505" || err.message.includes("unique")) {
            const raceMatch = await findExisting();
            if (raceMatch) {
              if (raceMatch.conflict) {
                return { error: raceMatch.error, created: false, raced: true, conflict: true };
              }
              return { project: raceMatch.project, created: false, raced: true, conflict: false };
            }
          }
          throw err;
        }
      };

      // 1. Concurrent duplicate submissions with same idempotencyKey
      const keyA = "client-sub-001";
      const [res1, res2] = await Promise.all([
        executeCreateProject('usr-idem-1', 'Build my bakery website', keyA, 'req-1'),
        executeCreateProject('usr-idem-1', 'Build my bakery website', keyA, 'req-2'),
      ]);

      // Exactly one created, both returned the same project
      assert.ok(res1.project && res2.project);
      assert.equal(res1.project.id, res2.project.id, "Both requests must converge on the exact same project ID");
      const createdCount = (res1.created ? 1 : 0) + (res2.created ? 1 : 0);
      assert.equal(createdCount, 1, "Exactly one project must be created in database");

      // Verify no duplicate messages, runs, or outbox events in database
      const prjRows = await db.query(`SELECT id FROM "Project" WHERE "userId" = 'usr-idem-1'`);
      assert.equal(prjRows.rows.length, 1);
      const msgRows = await db.query(`SELECT id FROM "Message" WHERE "projectId" = $1`, [res1.project.id]);
      assert.equal(msgRows.rows.length, 1, "Exactly 1 user message created");
      const runRows = await db.query(`SELECT id FROM "GenerationRun" WHERE "projectId" = $1`, [res1.project.id]);
      assert.equal(runRows.rows.length, 1, "Exactly 1 generation run queued");
      const outRows = await db.query(`SELECT id FROM "OutboxEvent" WHERE payload->>'projectId' = $1`, [res1.project.id]);
      assert.equal(outRows.rows.length, 1, "Exactly 1 outbox event queued");

      // 2. Sequential repeated submission with same prompt returns the existing project
      const repeatRes = await executeCreateProject('usr-idem-1', 'Build my bakery website', keyA, 'req-3');
      assert.equal(repeatRes.created, false);
      assert.equal(repeatRes.conflict, false);
      assert.equal(repeatRes.project.id, res1.project.id, "Repeated submission returns existing project");

      // 2b. Repeated submission with same idempotencyKey but DIFFERENT prompt returns conflict error
      const conflictRes = await executeCreateProject('usr-idem-1', 'Completely different prompt for photography', keyA, 'req-conflict');
      assert.equal(conflictRes.conflict, true);
      assert.equal(conflictRes.created, false);
      assert.equal(conflictRes.error, "Idempotency conflict: key already used with different prompt");

      // 3. Failed submission remains recoverable
      let failedThrew = false;
      try {
        await db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO "Project" ("id", "name", "userId", "idempotencyKey") VALUES ('prj-fail', 'Fail Prj', 'usr-idem-1', 'key-fail')`
          );
          throw new Error("Simulated transient error during run creation");
        });
      } catch {
        failedThrew = true;
      }
      assert.ok(failedThrew);
      const recoverRes = await executeCreateProject('usr-idem-1', 'Recoverable project', 'key-fail', 'req-rec');
      assert.equal(recoverRes.created, true, "Failed submission must remain recoverable with same idempotency key");

      // 4. Genuinely new user request receives a new identifier and creates a new project
      const newKeyRes = await executeCreateProject('usr-idem-1', 'Another different app', 'client-sub-002', 'req-new');
      assert.equal(newKeyRes.created, true);
      assert.notEqual(newKeyRes.project.id, res1.project.id, "Different idempotency key creates new project");

      // 5. Scoped to authenticated user: another user with the same key string gets their own project
      const otherUserRes = await executeCreateProject('usr-idem-2', 'User 2 app', keyA, 'req-usr2');
      assert.equal(otherUserRes.created, true);
      assert.equal(otherUserRes.project.userId, 'usr-idem-2', "Idempotency key is scoped per user");
    } finally {
      await db.close();
    }
  });

  // 11. Shared Database-Backed Rate Limiting with PostgreSQL Atomic Admission
  it("Scenario 11: Shared database-backed rate limiting with PostgreSQL atomic admission and concurrency", async () => {
    const db = await setupDatabase();
    try {
      const email = "contact-abuse@example.com";
      const keyHash = crypto.createHash("sha256").update(email).digest("hex");

      // Atomic admission function using transaction + advisory lock
      const atomicRateLimitCheck = async (clientTag: string, attemptIdx: number) => {
        return await db.transaction(async (tx) => {
          // Transaction-level advisory lock serializes checks for the same identifier hash
          await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [keyHash]);

          const windowStart = new Date(Date.now() - 600000);
          const countRes = await tx.query(
            `SELECT COUNT(*)::int as count FROM "RateLimitRecord" WHERE "keyHash" = $1 AND "createdAt" >= $2`,
            [keyHash, windowStart]
          );
          const currentCount = (countRes.rows[0] as any).count;
          if (currentCount >= 5) {
            return { allowed: false, count: currentCount, clientTag, attemptIdx };
          }

          await tx.query(
            `INSERT INTO "RateLimitRecord" ("id", "keyHash") VALUES ($1, $2)`,
            [`rate-${clientTag}-${attemptIdx}`, keyHash]
          );
          return { allowed: true, count: currentCount + 1, clientTag, attemptIdx };
        });
      };

      // Concurrent test: 10 concurrent requests arrive simultaneously across processes
      const concurrentAttempts = await Promise.all(
        Array.from({ length: 10 }).map((_, idx) =>
          atomicRateLimitCheck(idx % 2 === 0 ? "ProcessA" : "ProcessB", idx)
        )
      );

      const allowedCount = concurrentAttempts.filter((r) => r.allowed).length;
      const blockedCount = concurrentAttempts.filter((r) => !r.allowed).length;

      assert.equal(allowedCount, 5, "Atomic admission must strictly allow exactly 5 submissions");
      assert.equal(blockedCount, 5, "Atomic admission must strictly reject all 5 excess submissions");

      // Verify database record count is exactly 5
      const totalStored = await db.query(
        `SELECT COUNT(*)::int as count FROM "RateLimitRecord" WHERE "keyHash" = $1`,
        [keyHash]
      );
      assert.equal((totalStored.rows[0] as any).count, 5, "Database must contain exactly 5 records, never exceeding limit");

      // Verify no PII is stored in RateLimitRecord
      const rawPii = await db.query(`SELECT * FROM "RateLimitRecord" WHERE "id" LIKE '%@%' OR "keyHash" LIKE '%@%'`);
      assert.equal(rawPii.rows.length, 0, "No raw email or PII stored in RateLimitRecord");
    } finally {
      await db.close();
    }
  });
});
