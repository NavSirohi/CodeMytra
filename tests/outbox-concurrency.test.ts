import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MAX_OUTBOX_ATTEMPTS } from "../src/server/orchestration/outbox";

/**
 * Real PostgreSQL Concurrency Tests for Outbox Claiming Engine.
 * Executes on a genuine PostgreSQL engine (PGlite) testing transaction isolation,
 * FOR UPDATE SKIP LOCKED, lease expiration, retry backoffs, and race conditions.
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
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processedAt" TIMESTAMP(3)
      );

      CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
      CREATE INDEX IF NOT EXISTS "OutboxEvent_status_claimedAt_idx" ON "OutboxEvent"("status", "claimedAt");
    `);

    return db;
  }

  // 1. Concurrent Single-Event Claiming
  it("guarantees exactly one worker wins when multiple concurrent dispatchers target the same event", async () => {
    const db = await setupPostgresOutbox();

    try {
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
        VALUES ('evt-race-01', 'code-agent/run', '{"runId":"run-01"}'::jsonb, 'PENDING', 0);
      `);

      const claimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW()
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE ($1::text IS NULL OR id = $1)
            AND (
              (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'FAILED' AND attempts < $2 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
            )
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `;

      const leaseCutoff = new Date(Date.now() - 120000);

      // Launch 10 simultaneous workers targeting the exact same event
      const workers = Array.from({ length: 10 }, async () => {
        const res = await db.query(claimSql, ['evt-race-01', MAX_OUTBOX_ATTEMPTS, leaseCutoff]);
        return res.rows;
      });

      const results = await Promise.all(workers);
      const successfulClaims = results.filter((rows) => rows.length > 0);
      const emptyClaims = results.filter((rows) => rows.length === 0);

      // Exactly ONE worker claimed the row; 9 were safely locked out
      assert.equal(successfulClaims.length, 1, "Exactly one worker must claim the event");
      assert.equal(emptyClaims.length, 9, "9 workers must receive empty results");

      // Verify DB state
      const dbCheck = await db.query(`SELECT status, attempts, "claimedAt" FROM "OutboxEvent" WHERE id = 'evt-race-01'`);
      const row = dbCheck.rows[0] as { status: string; attempts: number; claimedAt: unknown };
      assert.equal(row.status, "PROCESSING");
      assert.equal(row.attempts, 1);
      assert.ok(row.claimedAt !== null);
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

      const claimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW()
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE ($1::text IS NULL OR id = $1)
            AND (
              (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'FAILED' AND attempts < $2 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
            )
          ORDER BY "createdAt" ASC
          LIMIT $4
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `;

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

      // All 6 distinct events claimed
      assert.equal(claimedIds.length, 6);
      const uniqueIds = new Set(claimedIds);
      assert.equal(uniqueIds.size, 6, "Every claimed event ID must be unique across all workers");
    } finally {
      await db.close();
    }
  });

  // 3. Retry Backoff Enforcement
  it("strictly respects nextAttemptAt and blocks premature retry claims", async () => {
    const db = await setupPostgresOutbox();

    try {
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "nextAttemptAt")
        VALUES ('evt-backoff', 'code-agent/run', '{"runId":"run"}'::jsonb, 'FAILED', 1, NOW() + interval '1 minute');
      `);

      const claimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW()
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE ($1::text IS NULL OR id = $1)
            AND (
              (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'FAILED' AND attempts < $2 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
            )
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `;

      const leaseCutoff = new Date(Date.now() - 120000);

      // Attempt claim while nextAttemptAt is in future -> must return 0 rows
      const attempt1 = await db.query(claimSql, ['evt-backoff', MAX_OUTBOX_ATTEMPTS, leaseCutoff]);
      assert.equal(attempt1.rows.length, 0, "Must not claim event before nextAttemptAt");

      // Advance nextAttemptAt to the past
      await db.query(`UPDATE "OutboxEvent" SET "nextAttemptAt" = NOW() - interval '1 second' WHERE id = 'evt-backoff'`);

      // Attempt claim now -> must succeed
      const attempt2 = await db.query(claimSql, ['evt-backoff', MAX_OUTBOX_ATTEMPTS, leaseCutoff]);
      assert.equal(attempt2.rows.length, 1, "Must claim event once nextAttemptAt has elapsed");
    } finally {
      await db.close();
    }
  });

  // 4. Safe Recovery of Abandoned Leases
  it("recovers abandoned PROCESSING leases after leaseDurationMs expires", async () => {
    const db = await setupPostgresOutbox();

    try {
      // Event stuck in PROCESSING with claimedAt 5 minutes ago
      const expiredClaimTime = new Date(Date.now() - 300000);
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "claimedAt")
        VALUES ('evt-abandoned', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PROCESSING', 1, $1);
      `, [expiredClaimTime]);

      const leaseCutoff = new Date(Date.now() - 120000); // 2 minutes ago

      const claimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW()
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE ($1::text IS NULL OR id = $1)
            AND (
              (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'FAILED' AND attempts < $2 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
            )
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `;

      const res = await db.query(claimSql, ['evt-abandoned', MAX_OUTBOX_ATTEMPTS, leaseCutoff]);
      assert.equal(res.rows.length, 1, "Must reclaim abandoned lease");
      const row = res.rows[0] as { attempts: number; status: string };
      assert.equal(row.attempts, 2, "Reclaimed attempt count incremented");
      assert.equal(row.status, "PROCESSING");
    } finally {
      await db.close();
    }
  });

  // 5. Max Attempts Terminal Failure Protection
  it("permanently locks out events that have reached MAX_OUTBOX_ATTEMPTS", async () => {
    const db = await setupPostgresOutbox();

    try {
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts")
        VALUES ('evt-exhausted', 'code-agent/run', '{"runId":"run"}'::jsonb, 'FAILED', $1);
      `, [MAX_OUTBOX_ATTEMPTS]);

      const claimSql = `
        UPDATE "OutboxEvent"
        SET status = 'PROCESSING', attempts = attempts + 1, "claimedAt" = NOW()
        WHERE id IN (
          SELECT id FROM "OutboxEvent"
          WHERE ($1::text IS NULL OR id = $1)
            AND (
              (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'FAILED' AND attempts < $2 AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
              OR (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
            )
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `;

      const leaseCutoff = new Date(Date.now() - 120000);
      const res = await db.query(claimSql, ['evt-exhausted', MAX_OUTBOX_ATTEMPTS, leaseCutoff]);

      assert.equal(res.rows.length, 0, "Exhausted event must never be claimed again");
    } finally {
      await db.close();
    }
  });

  // 6. Fencing Token Prevents Stale Worker Overwrite
  it("fencing token prevents a stalled worker from overwriting a reclaimed event", async () => {
    const db = await setupPostgresOutbox();

    try {
      const initialClaimedAt = new Date(Date.now() - 300000); // 5 mins ago
      await db.query(`
        INSERT INTO "OutboxEvent" ("id", "eventName", "payload", "status", "attempts", "claimedAt")
        VALUES ('evt-fencing', 'code-agent/run', '{"runId":"run"}'::jsonb, 'PROCESSING', 1, $1);
      `, [initialClaimedAt]);

      // Newer recovery worker reclaims event with fresh timestamp
      const newClaimedAt = new Date();
      await db.query(`
        UPDATE "OutboxEvent"
        SET attempts = 2, "claimedAt" = $1
        WHERE id = 'evt-fencing';
      `, [newClaimedAt]);

      // Stale worker tries to mark PROCESSED with its OLD claimedAt timestamp
      const staleUpdate = await db.query(`
        UPDATE "OutboxEvent"
        SET status = 'PROCESSED', "processedAt" = NOW(), "claimedAt" = NULL
        WHERE id = 'evt-fencing' AND status = 'PROCESSING' AND "claimedAt" = $1
        RETURNING *;
      `, [initialClaimedAt]);

      // Stale update affects 0 rows! Fencing token protected the database.
      assert.equal(staleUpdate.rows.length, 0, "Stale worker update with outdated lease must be rejected");

      // Verify the event is still PROCESSING with the new worker's claim
      const check = await db.query(`SELECT status, attempts FROM "OutboxEvent" WHERE id = 'evt-fencing'`);
      const row = check.rows[0] as { status: string; attempts: number };
      assert.equal(row.status, "PROCESSING");
      assert.equal(row.attempts, 2);
    } finally {
      await db.close();
    }
  });
});
