import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MAX_OUTBOX_ATTEMPTS } from "../src/server/orchestration/outbox";

/**
 * Real PostgreSQL Concurrency Tests for Outbox Claiming Engine.
 * Executes on a genuine PostgreSQL engine (PGlite) testing transaction isolation,
 * FOR UPDATE SKIP LOCKED, lease expiration, retry backoffs, claimToken fencing,
 * and global retry limits across PENDING, FAILED, and PROCESSING states.
 */
describe("Outbox Claiming: Real PostgreSQL Concurrency & Lease Engine", () => {
  async function setupPostgresOutbox() {
    const db = new PGlite();

    await db.exec(`
      DO $$ BEGIN
        CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

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
      CREATE INDEX IF NOT EXISTS "OutboxEvent_status_claimedAt_idx" ON "OutboxEvent"("status", "claimedAt");
      CREATE INDEX IF NOT EXISTS "OutboxEvent_claimToken_idx" ON "OutboxEvent"("claimToken");
    `);

    return db;
  }

  const claimSql = `
    UPDATE "OutboxEvent"
    SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW(), "claimToken" = gen_random_uuid()::text
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE ($1::text IS NULL OR id = $1)
        AND attempts < $2
        AND (
          (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
          OR (status = 'FAILED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
          OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
        )
      ORDER BY "createdAt" ASC
      LIMIT $4
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  // 1. Concurrent Single-Event Claiming
  it("guarantees exactly one worker wins when multiple concurrent dispatchers target the same event", async () => {
    const db = await setupPostgresOutbox();

    try {
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
        VALUES ('evt-race-01', 'code-agent/run', '{"runId":"run-01"}'::jsonb, 'PENDING', 0);
      `);

      const leaseCutoff = new Date(Date.now() - 120000);

      // Launch 10 simultaneous workers targeting the exact same event
      const workers = Array.from({ length: 10 }, async () => {
        const res = await db.query(claimSql, ['evt-race-01', MAX_OUTBOX_ATTEMPTS, leaseCutoff, 1]);
        return res.rows;
      });

      const results = await Promise.all(workers);
      const successfulClaims = results.filter((rows) => rows.length > 0);
      const emptyClaims = results.filter((rows) => rows.length === 0);

      // Exactly ONE worker claimed the row; 9 were safely locked out
      assert.equal(successfulClaims.length, 1, "Exactly one worker must claim the event");
      assert.equal(emptyClaims.length, 9, "9 workers must receive empty results");

      // Verify DB state
      const dbCheck = await db.query(`SELECT status, attempts, "claimedAt", "claimToken" FROM "OutboxEvent" WHERE id = 'evt-race-01'`);
      const row = dbCheck.rows[0] as { status: string; attempts: number; claimedAt: unknown; claimToken: string };
      assert.equal(row.status, "PROCESSING");
      assert.equal(row.attempts, 1);
      assert.ok(row.claimedAt !== null);
      assert.ok(row.claimToken && row.claimToken.length > 10, "Must have generated a claimToken");
    } finally {
      await db.close();
    }
  });

  // 2. Batch Claiming with Disjoint Sets
  it("partitions ready events across concurrent batch workers with zero duplication", async () => {
    const db = await setupPostgresOutbox();

    try {
      // Seed 6 pending events
      for (let i = 1; i <= 6; i++) {
        await db.query(`
          INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
          VALUES ($1, 'code-agent/run', '{"runId":"run"}'::jsonb, 'PENDING', 0);
        `, [`evt-batch-${i}`]);
      }

      const leaseCutoff = new Date(Date.now() - 120000);

      // 3 workers each requesting batch size 2
      const worker1 = db.query(claimSql, [null, MAX_OUTBOX_ATTEMPTS, leaseCutoff, 2]);
      const worker2 = db.query(claimSql, [null, MAX_OUTBOX_ATTEMPTS, leaseCutoff, 2]);
      const worker3 = db.query(claimSql, [null, MAX_OUTBOX_ATTEMPTS, leaseCutoff, 2]);

      const [res1, res2, res3] = await Promise.all([worker1, worker2, worker3]);

      const claimedIds = [
        ...res1.rows.map((r: any) => r.id),
        ...res2.rows.map((r: any) => r.id),
        ...res3.rows.map((r: any) => r.id),
      ];

      // Exactly 6 events claimed in total
      assert.equal(claimedIds.length, 6, "All 6 events should be claimed across workers");

      // Zero duplicates (disjoint sets)
      const uniqueIds = new Set(claimedIds);
      assert.equal(uniqueIds.size, 6, "Every claimed event must belong to exactly one worker batch");
    } finally {
      await db.close();
    }
  });

  // 3. Retry Backoff Protection
  it("strictly respects nextAttemptAt and blocks premature retry claims", async () => {
    const db = await setupPostgresOutbox();

    try {
      // Event failed with a nextAttemptAt 5 minutes in the future
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "nextAttemptAt")
        VALUES ('evt-future', 'code-agent/run', '{"runId":"run"}'::jsonb, 'FAILED', 1, NOW() + interval '5 minutes');
      `);

      const leaseCutoff = new Date(Date.now() - 120000);
      const res = await db.query(claimSql, ['evt-future', MAX_OUTBOX_ATTEMPTS, leaseCutoff, 1]);

      assert.equal(res.rows.length, 0, "Event with future nextAttemptAt must not be claimed");
    } finally {
      await db.close();
    }
  });

  // 4. Stale Lease Reclamation
  it("recovers abandoned PROCESSING leases after leaseDurationMs expires", async () => {
    const db = await setupPostgresOutbox();

    try {
      // Event stuck in PROCESSING since 5 minutes ago
      const expiredClaimTime = new Date(Date.now() - 300000);
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "claimedAt", "claimToken")
        VALUES ('evt-abandoned', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PROCESSING', 1, $1, 'old-token');
      `, [expiredClaimTime]);

      const leaseCutoff = new Date(Date.now() - 120000); // 2 minute lease
      const res = await db.query(claimSql, ['evt-abandoned', MAX_OUTBOX_ATTEMPTS, leaseCutoff, 1]);

      assert.equal(res.rows.length, 1, "Must reclaim abandoned lease");
      const row = res.rows[0] as { attempts: number; status: string; claimToken: string };
      assert.equal(row.attempts, 2, "Reclaimed attempt count incremented");
      assert.equal(row.status, "PROCESSING");
      assert.notEqual(row.claimToken, 'old-token', "Must generate a fresh claimToken upon reclaim");
    } finally {
      await db.close();
    }
  });

  // 5. Global Max Attempts Terminal Failure Protection across PENDING, FAILED, and PROCESSING
  it("permanently locks out events that have reached MAX_OUTBOX_ATTEMPTS across PENDING, FAILED, and stale PROCESSING", async () => {
    const db = await setupPostgresOutbox();

    try {
      // Insert exhausted events across all three eligible states
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
        VALUES ('evt-exhausted-pending', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PENDING', $1);
      `, [MAX_OUTBOX_ATTEMPTS]);

      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
        VALUES ('evt-exhausted-failed', 'code-agent/run', '{"runId":"run"}'::jsonb, 'FAILED', $1);
      `, [MAX_OUTBOX_ATTEMPTS]);

      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "claimedAt")
        VALUES ('evt-exhausted-stale-proc', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PROCESSING', $1, NOW() - interval '10 minutes');
      `, [MAX_OUTBOX_ATTEMPTS]);

      const leaseCutoff = new Date(Date.now() - 120000);
      const res = await db.query(claimSql, [null, MAX_OUTBOX_ATTEMPTS, leaseCutoff, 10]);

      assert.equal(res.rows.length, 0, "Exhausted events across all states must never be claimed again");
    } finally {
      await db.close();
    }
  });

  // 6. Fencing Token Prevents Stale Worker Overwrite
  it("claimToken fencing prevents a stalled worker from overwriting a newer reclaimed claim", async () => {
    const db = await setupPostgresOutbox();

    try {
      const initialClaimToken = "token-worker-1";
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "claimedAt", "claimToken")
        VALUES ('evt-fencing', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PROCESSING', 1, NOW() - interval '5 minutes', $1);
      `, [initialClaimToken]);

      // Worker 2 reclaims abandoned event with a fresh claimToken
      const newClaimToken = "token-worker-2";
      await db.query(`
        UPDATE "OutboxEvent"
        SET attempts = 2, "claimedAt" = NOW(), "claimToken" = $1
        WHERE id = 'evt-fencing';
      `, [newClaimToken]);

      // Stale Worker 1 wakes up and tries to mark PROCESSED using its obsolete initialClaimToken
      const staleUpdate = await db.query(`
        UPDATE "OutboxEvent"
        SET status = 'PROCESSED', "processedAt" = NOW(), "claimedAt" = NULL, "claimToken" = NULL
        WHERE id = 'evt-fencing' AND status = 'PROCESSING' AND "claimToken" = $1
        RETURNING *;
      `, [initialClaimToken]);

      // Stale update affects 0 rows! Fencing token protected the database.
      assert.equal(staleUpdate.rows.length, 0, "Stale worker update with outdated claimToken must be rejected");

      // Verify the event is still PROCESSING with Worker 2's claimToken
      const check = await db.query(`SELECT status, attempts, "claimToken" FROM "OutboxEvent" WHERE id = 'evt-fencing'`);
      const row = check.rows[0] as { status: string; attempts: number; claimToken: string };
      assert.equal(row.status, "PROCESSING");
      assert.equal(row.attempts, 2);
      assert.equal(row.claimToken, newClaimToken);
    } finally {
      await db.close();
    }
  });
});
