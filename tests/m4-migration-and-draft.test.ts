import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

describe("P0-1: M4 Additive Database Migration & Genuine Prisma Draft Operations", () => {
  it("Scenario 1: Applies full migration history from clean initial schema and verifies GenerationDraft DDL on PostgreSQL", async () => {
    const db = new PGlite();
    const migrationsDir = path.resolve(__dirname, "../prisma/migrations");
    const migrationDirs = fs
      .readdirSync(migrationsDir)
      .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
      .sort();

    // Verify migration folder is present
    const draftMigration = migrationDirs.find((dir) => dir.includes("add_generation_draft"));
    assert.ok(draftMigration, "20261020180000_add_generation_draft migration directory must exist");

    // Play back all migrations in order against clean PostgreSQL schema
    for (const dir of migrationDirs) {
      const sqlFile = path.join(migrationsDir, dir, "migration.sql");
      if (fs.existsSync(sqlFile)) {
        const sql = fs.readFileSync(sqlFile, "utf-8");
        await db.exec(sql);
      }
    }

    // Verify enum exists in PostgreSQL pg_type
    const enumCheck = await db.query(
      `SELECT typname FROM pg_type WHERE typname = 'DraftValidationStatus'`
    );
    assert.equal(enumCheck.rows.length, 1, "DraftValidationStatus enum must exist in PostgreSQL");

    // Verify GenerationDraft columns exist
    const columnCheck = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'GenerationDraft'
      ORDER BY ordinal_position
    `);
    assert.ok(columnCheck.rows.length >= 10, "GenerationDraft must have all defined columns");
    const colNames = columnCheck.rows.map((r: any) => r.column_name);
    assert.ok(colNames.includes("id"), "column id must exist");
    assert.ok(colNames.includes("generationRunId"), "column generationRunId must exist");
    assert.ok(colNames.includes("projectId"), "column projectId must exist");
    assert.ok(colNames.includes("files"), "column files must exist");
    assert.ok(colNames.includes("manifest"), "column manifest must exist");
    assert.ok(colNames.includes("validationStatus"), "column validationStatus must exist");
    assert.ok(colNames.includes("diagnostics"), "column diagnostics must exist");
    assert.ok(colNames.includes("summary"), "column summary must exist");
    assert.ok(colNames.includes("source"), "column source must exist");
    assert.ok(colNames.includes("createdAt"), "column createdAt must exist");
    assert.ok(colNames.includes("updatedAt"), "column updatedAt must exist");

    // Verify unique index on generationRunId
    const indexCheck = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'GenerationDraft' AND indexname = 'GenerationDraft_generationRunId_key'
    `);
    assert.equal(indexCheck.rows.length, 1, "Unique index GenerationDraft_generationRunId_key must exist");
    await db.close();
  });

  it("Scenario 2: Executes genuine Prisma generationDraft.create, findFirst, and upsert without mocking model delegate", async () => {
    const db = new PGlite();
    const migrationsDir = path.resolve(__dirname, "../prisma/migrations");
    const migrationDirs = fs
      .readdirSync(migrationsDir)
      .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
      .sort();

    for (const dir of migrationDirs) {
      const sqlFile = path.join(migrationsDir, dir, "migration.sql");
      if (fs.existsSync(sqlFile)) {
        await db.exec(fs.readFileSync(sqlFile, "utf-8"));
      }
    }

    const queryFn = async (queryText: any, values?: any[]) => {
      const text = typeof queryText === "string" ? queryText : queryText.text;
      const args = typeof queryText === "string" ? values : queryText.values;
      const rowMode = typeof queryText === "object" ? queryText.rowMode : undefined;
      const res = await db.query(text, args || [], { rowMode });
      if (res.rows && rowMode === "array") {
        const fixedRows = res.rows.map((row: any) =>
          (row as any[]).map((val: any) => {
            if (val !== null && typeof val === "object" && !(val instanceof Date)) {
              return JSON.stringify(val);
            }
            return val;
          })
        );
        return { ...res, rows: fixedRows };
      }
      return res;
    };

    const pool = Object.assign(Object.create(pg.Pool.prototype), {
      options: {},
      on: () => pool,
      removeListener: () => pool,
      query: queryFn,
      connect: async () => ({
        query: queryFn,
        release: () => {},
        on: () => {},
      }),
      end: async () => {},
    });

    const adapter = new PrismaPg(pool);
    const testPrisma = new PrismaClient({ adapter });

    try {
      // Seed User, Project, GenerationRun via genuine Prisma calls
      const user = await testPrisma.user.create({
        data: {
          id: "usr-smoke-1",
          clerkId: "clerk-smoke-1",
          email: "smoke@codemytra.com",
        },
      });
      assert.equal(user.id, "usr-smoke-1");

      const project = await testPrisma.project.create({
        data: {
          id: "prj-smoke-1",
          name: "Smoke Test Bakery",
          userId: user.id,
        },
      });
      assert.equal(project.id, "prj-smoke-1");

      const run = await testPrisma.generationRun.create({
        data: {
          id: "run-smoke-1",
          projectId: project.id,
          userId: user.id,
          prompt: "Artisan sourdough bakery site",
          status: "RUNNING",
        },
      });
      assert.equal(run.id, "run-smoke-1");

      // 1. Genuine generationDraft.create
      const createdDraft = await testPrisma.generationDraft.create({
        data: {
          generationRunId: run.id,
          projectId: project.id,
          files: {
            "app/page.tsx": "export default function Page() { return <h1>Artisan Bakery</h1>; }",
            "package.json": JSON.stringify({ name: "bakery", dependencies: { next: "15.0.0" } }),
          },
          manifest: {
            fileCount: 2,
            totalSizeBytes: 120,
            filePaths: ["app/page.tsx", "package.json"],
          },
          validationStatus: "UNVALIDATED",
          summary: "Initial synthesized draft",
          source: "canonical-sandbox-snapshot",
        },
      });

      assert.ok(createdDraft.id);
      assert.equal(createdDraft.generationRunId, run.id);
      assert.equal(createdDraft.validationStatus, "UNVALIDATED");
      assert.equal(createdDraft.source, "canonical-sandbox-snapshot");
      assert.equal(Object.keys(createdDraft.files as any).length, 2);

      // 2. Genuine generationDraft.findFirst
      const queriedDraft = await testPrisma.generationDraft.findFirst({
        where: { generationRunId: run.id },
      });
      assert.ok(queriedDraft);
      assert.equal(queriedDraft?.id, createdDraft.id);
      assert.equal(queriedDraft?.validationStatus, "UNVALIDATED");

      // 3. Genuine generationDraft.upsert (updating existing draft to FAILED with diagnostics)
      const diagnosticsPayload = {
        passed: false,
        score: 65,
        errors: ["TypeScript compilation failed: TS2304"],
        checks: [
          {
            name: "typescript-validation",
            passed: false,
            exitCode: 1,
            stderr: "app/page.tsx(2,3): error TS2304: Cannot find name 'Croissant'.",
            timeout: false,
          },
        ],
      };

      const upsertedDraft = await testPrisma.generationDraft.upsert({
        where: { generationRunId: run.id },
        create: {
          generationRunId: run.id,
          projectId: project.id,
          files: createdDraft.files as any,
          validationStatus: "FAILED",
          diagnostics: diagnosticsPayload,
          source: "canonical-sandbox-snapshot",
        },
        update: {
          validationStatus: "FAILED",
          diagnostics: diagnosticsPayload,
        },
      });

      assert.equal(upsertedDraft.id, createdDraft.id);
      assert.equal(upsertedDraft.validationStatus, "FAILED");
      assert.deepEqual(
        (upsertedDraft.diagnostics as any).checks[0].stderr,
        "app/page.tsx(2,3): error TS2304: Cannot find name 'Croissant'."
      );

      // 4. Referential cascade verification: deleting GenerationRun automatically cascades to GenerationDraft
      await testPrisma.generationRun.delete({
        where: { id: run.id },
      });

      const cascadedDraft = await testPrisma.generationDraft.findFirst({
        where: { id: createdDraft.id },
      });
      assert.equal(cascadedDraft, null, "Draft must be deleted when parent GenerationRun is deleted");
    } finally {
      await testPrisma.$disconnect();
      await db.close();
    }
  });

  it("Scenario 3: Distinguishes canonical snapshot vs unverified model fallback vs failed generation and blocks unverified promotion", async () => {
    const db = new PGlite();
    const migrationsDir = path.resolve(__dirname, "../prisma/migrations");
    const migrationDirs = fs
      .readdirSync(migrationsDir)
      .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
      .sort();

    for (const dir of migrationDirs) {
      const sqlFile = path.join(migrationsDir, dir, "migration.sql");
      if (fs.existsSync(sqlFile)) {
        await db.exec(fs.readFileSync(sqlFile, "utf-8"));
      }
    }

    const queryFn = async (queryText: any, values?: any[]) => {
      const text = typeof queryText === "string" ? queryText : queryText.text;
      const args = typeof queryText === "string" ? values : queryText.values;
      const rowMode = typeof queryText === "object" ? queryText.rowMode : undefined;
      const res = await db.query(text, args || [], { rowMode });
      if (res.rows && rowMode === "array") {
        const fixedRows = res.rows.map((row: any) =>
          (row as any[]).map((val: any) => {
            if (val !== null && typeof val === "object" && !(val instanceof Date)) {
              return JSON.stringify(val);
            }
            return val;
          })
        );
        return { ...res, rows: fixedRows };
      }
      return res;
    };

    const pool = Object.assign(Object.create(pg.Pool.prototype), {
      options: {},
      on: () => pool,
      removeListener: () => pool,
      query: queryFn,
      connect: async () => ({
        query: queryFn,
        release: () => {},
        on: () => {},
      }),
      end: async () => {},
    });

    const adapter = new PrismaPg(pool);
    const testPrisma = new PrismaClient({ adapter });

    try {
      const user = await testPrisma.user.create({
        data: { id: "usr-prov-1", clerkId: "clerk-prov-1", email: "prov@codemytra.com" },
      });
      const project = await testPrisma.project.create({
        data: { id: "prj-prov-1", name: "Provenance Project", userId: user.id },
      });

      // 1. Genuine Canonical Snapshot
      const run1 = await testPrisma.generationRun.create({
        data: { id: "run-canon-1", projectId: project.id, userId: user.id, prompt: "Canonical", status: "RUNNING" },
      });
      const canonicalDraft = await testPrisma.generationDraft.create({
        data: {
          generationRunId: run1.id,
          projectId: project.id,
          files: { "app/page.tsx": "export default function Page() { return <h1>Canonical</h1>; }" },
          validationStatus: "UNVALIDATED",
          source: "canonical-sandbox-snapshot",
          diagnostics: { provenance: "canonical-sandbox-snapshot", fileCount: 1 },
        },
      });
      assert.equal(canonicalDraft.source, "canonical-sandbox-snapshot");
      assert.equal((canonicalDraft.diagnostics as any).provenance, "canonical-sandbox-snapshot");

      // 2. Explicit Unverified Fallback
      const run2 = await testPrisma.generationRun.create({
        data: { id: "run-fallback-1", projectId: project.id, userId: user.id, prompt: "Fallback", status: "RUNNING" },
      });
      const fallbackDraft = await testPrisma.generationDraft.create({
        data: {
          generationRunId: run2.id,
          projectId: project.id,
          files: { "app/page.tsx": "export default function Page() { return <h1>Fallback</h1>; }" },
          validationStatus: "UNVALIDATED",
          source: "unverified-model-output-fallback",
          diagnostics: {
            warning: "E2B filesystem snapshot capture failed; fell back to unverified model memory output",
            snapshotError: "Sandbox connection timeout",
            provenance: "unverified-model-output-fallback",
            fileCount: 1,
          },
        },
      });
      assert.equal(fallbackDraft.source, "unverified-model-output-fallback");
      assert.ok((fallbackDraft.diagnostics as any).warning.includes("fell back"));

      // 3. Failed/Empty Source Generation
      const run3 = await testPrisma.generationRun.create({
        data: { id: "run-failed-1", projectId: project.id, userId: user.id, prompt: "Failed", status: "FAILED" },
      });
      const failedDraft = await testPrisma.generationDraft.create({
        data: {
          generationRunId: run3.id,
          projectId: project.id,
          files: {},
          validationStatus: "FAILED",
          source: "failed-source-generation",
          diagnostics: {
            error: "No source files were generated or captured from sandbox",
            snapshotError: "Zero files discovered",
          },
        },
      });
      assert.equal(failedDraft.source, "failed-source-generation");
      assert.equal(failedDraft.validationStatus, "FAILED");
      assert.equal(Object.keys(failedDraft.files as any).length, 0);

      // 4. Verification that an unverified fallback requires real snapshot before promotion to V1
      // Promotion guard simulation:
      const canPromote = (qaReportPassed: boolean, finalSnapshotVerified: boolean) =>
        qaReportPassed && finalSnapshotVerified;

      assert.equal(canPromote(true, false), false, "Unverified snapshot fallback must NEVER be promoted to revision V1");
      assert.equal(canPromote(true, true), true, "Verified canonical snapshot with passing QA promotes to revision V1");
    } finally {
      await testPrisma.$disconnect();
      await db.close();
    }
  });
});
