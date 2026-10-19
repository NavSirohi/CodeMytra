import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import JSZip from "jszip";
import { prisma } from "../src/lib/db";
import { generateProjectZip } from "../src/server/export/zip-export";
import { getBaseProjectFiles } from "../src/server/templates/foundation";

describe("Task 3: Reproducible Standalone Export Verification", { timeout: 180000 }, () => {
  it("exports a database-backed project via ZIP-export service, extracts it, and verifies local setup, build, and persistence", async (t) => {
    const timestamp = Date.now();
    const testUserId = `user_export_test_${timestamp}`;
    const testProjectId = `proj_export_test_${timestamp}`;
    const testRevisionId = `rev_export_test_${timestamp}`;
    const tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemytra-export-verify-"));

    // 1. Build complete database-backed application files using foundation
    const baseFiles = getBaseProjectFiles({
      projectName: "inventory-pro",
      requiresDatabase: true,
      models: [
        {
          modelName: "Product",
          fields: [
            "sku String @unique",
            "name String",
            "quantity Int @default(0)",
            "price Float @default(0.0)",
          ],
        },
      ],
    });

    const applicationFiles: Record<string, string> = {
      ...baseFiles,
      "app/page.tsx": `
"use client";
import React, { useState } from "react";

export default function InventoryPage() {
  const [items, setItems] = useState([{ id: 1, name: "Sample Item", quantity: 10 }]);
  return (
    <main className="p-8">
      <h1>Inventory Management</h1>
      <ul>
        {items.map((it) => (
          <li key={it.id}>{it.name} - {it.quantity}</li>
        ))}
      </ul>
    </main>
  );
}
`,
      "app/api/products/route.ts": `
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const products = await db.product.findMany();
  return NextResponse.json(products);
}

export async function POST(req: Request) {
  const body = await req.json();
  const product = await db.product.create({
    data: {
      sku: body.sku,
      name: body.name,
      quantity: body.quantity ?? 0,
      price: body.price ?? 0.0,
    },
  });
  return NextResponse.json(product, { status: 201 });
}
`,
    };

    // 2. Isolate test with authentic Prisma model responses
    const originalFindUniqueProject = prisma.project.findUnique;
    const originalFindUniqueRevision = prisma.projectRevision.findUnique;

    prisma.project.findUnique = (async (args: any) => {
      if (args?.where?.id === testProjectId && args?.where?.userId === testUserId) {
        return {
          id: testProjectId,
          name: "inventory-pro",
          currentRevisionId: testRevisionId,
        };
      }
      return null;
    }) as any;

    prisma.projectRevision.findUnique = (async (args: any) => {
      if (args?.where?.id === testRevisionId && args?.where?.projectId === testProjectId) {
        return {
          id: testRevisionId,
          projectId: testProjectId,
          revisionNumber: 1,
          files: applicationFiles,
        };
      }
      return null;
    }) as any;

    try {
      // 3. Generate authentic ZIP export using production service
      const zipResult = await generateProjectZip({
        projectId: testProjectId,
        revisionId: testRevisionId,
        userId: testUserId,
      });

      assert.ok(zipResult.buffer.length > 1000, "ZIP buffer must be non-empty");

      // 4. Extract ZIP archive into clean temporary directory
      const zip = await JSZip.loadAsync(zipResult.buffer);
      for (const [entryPath, fileEntry] of Object.entries(zip.files)) {
        if (fileEntry.dir) continue;
        const destPath = path.join(tempExtractDir, entryPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const content = await fileEntry.async("nodebuffer");
        fs.writeFileSync(destPath, content);
      }

      // Root directory inside the extracted zip
      const extractedEntries = fs.readdirSync(tempExtractDir);
      assert.equal(extractedEntries.length, 1, "Export ZIP should have a single root folder");
      const appDir = path.join(tempExtractDir, extractedEntries[0]);

      // -----------------------------------------------------------------------
      // VERIFICATION 1: All required project and database files are included
      // -----------------------------------------------------------------------
      const requiredFiles = [
        "package.json",
        "tsconfig.json",
        "next.config.mjs",
        "eslint.config.mjs",
        "tailwind.config.ts",
        "postcss.config.mjs",
        "app/globals.css",
        "app/layout.tsx",
        "app/page.tsx",
        "lib/utils.ts",
        "prisma/schema.prisma",
        "prisma.config.ts",
        "lib/db.ts",
        ".env.example",
        "app/api/products/route.ts",
      ];

      for (const reqFile of requiredFiles) {
        const fullPath = path.join(appDir, reqFile);
        assert.ok(fs.existsSync(fullPath), `Required file missing in export: ${reqFile}`);
      }

      // -----------------------------------------------------------------------
      // VERIFICATION 2: .env.example is present without credentials
      // -----------------------------------------------------------------------
      const envExampleContent = fs.readFileSync(path.join(appDir, ".env.example"), "utf8");
      assert.match(envExampleContent, /DATABASE_URL="file:\.\/dev\.db"/);
      assert.equal(envExampleContent.includes("password"), false, ".env.example must not contain passwords");
      assert.equal(envExampleContent.includes("secret"), false, ".env.example must not contain secrets");
      assert.equal(envExampleContent.includes("key"), false, ".env.example must not contain secret keys");

      // -----------------------------------------------------------------------
      // VERIFICATION 3: Documented local database setup works (cp .env.example .env)
      // -----------------------------------------------------------------------
      fs.copyFileSync(path.join(appDir, ".env.example"), path.join(appDir, ".env"));
      assert.ok(fs.existsSync(path.join(appDir, ".env")), ".env must exist after setup");

      // -----------------------------------------------------------------------
      // VERIFICATION 4: Standalone dependency installation from package manifest
      // -----------------------------------------------------------------------
      const installRes = spawnSync(
        "npm",
        [
          "install",
          "--no-audit",
          "--prefer-offline",
          "--fetch-retries=0",
          "--fetch-retry-mintimeout=500",
          "--fetch-retry-maxtimeout=1000",
        ],
        {
          cwd: appDir,
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, CI: "true" },
        }
      );

      if (installRes.status !== 0) {
        const isOffline =
          installRes.stderr?.includes("ENOTCACHED") ||
          installRes.stderr?.includes("ECONNREFUSED") ||
          installRes.stderr?.includes("ENOTFOUND") ||
          installRes.error?.message?.includes("ETIMEDOUT") ||
          installRes.status === null;

        if (isOffline) {
          t.skip(
            `SKIPPED: Standalone npm install requires outbound npm registry access (blocked in offline sandbox): ${installRes.stderr || installRes.error?.message || "timeout"}`
          );
          return;
        }

        assert.equal(
          installRes.status,
          0,
          `Standalone npm install failed: ${installRes.stderr || installRes.stdout}`
        );
      }

      // -----------------------------------------------------------------------
      // VERIFICATION 5: Prisma schema validation and client generation succeed
      // -----------------------------------------------------------------------
      const valRes = spawnSync("npx", ["prisma", "validate"], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(valRes.status, 0, `Prisma validate failed: ${valRes.stderr || valRes.stdout}`);

      const genRes = spawnSync("npx", ["prisma", "generate"], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 45000,
      });
      assert.equal(genRes.status, 0, `Prisma generate failed: ${genRes.stderr || genRes.stdout}`);

      // -----------------------------------------------------------------------
      // VERIFICATION 6: Database initialization succeeds on isolated local DB
      // -----------------------------------------------------------------------
      const pushRes = spawnSync("npx", ["prisma", "db", "push"], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(pushRes.status, 0, `Prisma db push failed: ${pushRes.stderr || pushRes.stdout}`);
      assert.ok(fs.existsSync(path.join(appDir, "dev.db")), "SQLite dev.db database file must be created");

      // -----------------------------------------------------------------------
      // VERIFICATION 7: TypeScript verification passes
      // -----------------------------------------------------------------------
      const tscRes = spawnSync("npx", ["tsc", "--noEmit"], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 45000,
      });
      assert.equal(tscRes.status, 0, `TypeScript check failed: ${tscRes.stderr || tscRes.stdout}`);

      // -----------------------------------------------------------------------
      // VERIFICATION 8: Standalone Production Build succeeds outside CodeMytra
      // -----------------------------------------------------------------------
      const buildRes = spawnSync("npm", ["run", "build"], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 90000,
        env: { ...process.env, CI: "true" },
      });
      assert.equal(
        buildRes.status,
        0,
        `Standalone production build failed: ${buildRes.stderr || buildRes.stdout}`
      );

      // -----------------------------------------------------------------------
      // VERIFICATION 9: An actual generated backend operation persists and retrieves data
      // -----------------------------------------------------------------------
      const testScriptContent = `
import { db } from "./lib/db";

async function verifyPersistence() {
  const item = await db.product.create({
    data: {
      sku: "SKU-EXPORT-1001",
      name: "Mechanical Keyboard",
      quantity: 15,
      price: 149.99,
    },
  });

  const found = await db.product.findUnique({
    where: { sku: "SKU-EXPORT-1001" },
  });

  if (!found || found.name !== "Mechanical Keyboard" || found.quantity !== 15) {
    throw new Error("Persistence verification failed: record not found or mismatched");
  }

  console.log("PERSISTENCE_OPERATION_VERIFIED");
}

verifyPersistence()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
`;
      const testScriptPath = path.join(appDir, "test-persistence.ts");
      fs.writeFileSync(testScriptPath, testScriptContent);

      const opRes = spawnSync("npx", ["tsx", "test-persistence.ts"], {
        cwd: appDir,
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(opRes.status, 0, `Backend persistence operation failed: ${opRes.stderr || opRes.stdout}`);
      assert.match(opRes.stdout, /PERSISTENCE_OPERATION_VERIFIED/);
    } finally {
      // Restore Prisma methods
      prisma.project.findUnique = originalFindUniqueProject;
      prisma.projectRevision.findUnique = originalFindUniqueRevision;

      // Cleanup temporary directory
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
  });
});
