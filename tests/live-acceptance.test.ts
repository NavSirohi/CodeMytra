import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import JSZip from "jszip";
import { Sandbox } from "@e2b/code-interpreter";
import { runPlannerAgent } from "../src/server/agents/planner";
import { runDesignAgent } from "../src/server/agents/designer";
import { runArchitectureAgent } from "../src/server/agents/architect";
import { runCodingAgent } from "../src/server/agents/coder";
import { runQAInspector } from "../src/server/agents/qa";
import { captureSandboxSnapshot } from "../src/server/orchestration/sandbox-snapshot";
import {
  initializeSandboxWorkspace,
  resolveWorkspacePath,
} from "../src/server/orchestration/workspace";
import { getBaseProjectFiles } from "../src/server/templates/foundation";
import {
  finalizeGenerationSuccess,
} from "../src/server/orchestration/finalization";
import { generateProjectZip } from "../src/server/export/zip-export";
import { prisma } from "../src/lib/db";
import { GenerationRunStatus } from "../src/generated/prisma/client";

interface AcceptanceScenario {
  id: string;
  name: string;
  initialPrompt: string;
  followUpPrompt: string;
  expectedCapabilities: string[];
  requiresPersistence: boolean;
}

const ACCEPTANCE_SCENARIOS: AcceptanceScenario[] = [
  {
    id: "scenario-portfolio",
    name: "Static Developer Portfolio",
    initialPrompt:
      "Build a modern developer portfolio showcasing technical projects, engineering skills, and an interactive contact form with responsive layout.",
    followUpPrompt:
      "Add an interactive filterable skill tags section and a dark/light mode toggle while preserving all existing projects and contact form.",
    expectedCapabilities: ["pages-navigation", "forms-validation"],
    requiresPersistence: false,
  },
  {
    id: "scenario-inventory",
    name: "CRUD Inventory Management",
    initialPrompt:
      "Build an inventory management application with persistent SQLite storage for products tracking SKU, name, quantity, and price with complete REST API CRUD handlers.",
    followUpPrompt:
      "Add a real-time low-stock threshold warning banner and search bar to filter products by SKU while retaining existing CRUD routes and product records.",
    expectedCapabilities: ["pages-navigation", "data-persistence", "crud-operations"],
    requiresPersistence: true,
  },
  {
    id: "scenario-booking",
    name: "Appointment Booking Workflow",
    initialPrompt:
      "Build an appointment booking system with SQLite persistence for appointments, customer details, and time slots, enforcing strict business rules preventing double bookings.",
    followUpPrompt:
      "Add a filter to toggle between upcoming and past appointments and an appointment cancellation action while preserving booking conflict validation.",
    expectedCapabilities: ["pages-navigation", "data-persistence", "crud-operations", "business-rules"],
    requiresPersistence: true,
  },
  {
    id: "scenario-ecommerce",
    name: "E-Commerce Coffee Store",
    initialPrompt:
      "Build an artisanal coffee beans e-commerce store with persistent catalogue and orders in SQLite, featuring cart management, checkout, and atomic stock deduction.",
    followUpPrompt:
      "Add roast profile filtering (Light, Medium, Dark) and grind size selection while keeping cart checkout and stock decrement fully operational.",
    expectedCapabilities: ["pages-navigation", "data-persistence", "crud-operations", "business-rules"],
    requiresPersistence: true,
  },
];

describe("Task 5: Real Generic-Generation Acceptance Suite", { timeout: 300000 }, () => {
  const hasLiveCredentials = Boolean(
    process.env.E2B_API_KEY &&
    process.env.E2B_TEMPLATE_ID &&
    process.env.GEMINI_API_KEY
  );

  for (const scenario of ACCEPTANCE_SCENARIOS) {
    it(`executes genuine production generation, follow-up, QA, and export for "${scenario.name}"`, async (t) => {
      if (!hasLiveCredentials) {
        t.skip(
          `SKIPPED: Missing live cloud credentials (E2B_API_KEY, E2B_TEMPLATE_ID, GEMINI_API_KEY) for ${scenario.name}`
        );
        return;
      }

      // If live credentials are provided, run through the authoritative multi-agent generation pipeline
      const timestamp = Date.now();
      const testUserId = `user_acc_${scenario.id}_${timestamp}`;
      const testProjectId = `proj_acc_${scenario.id}_${timestamp}`;
      let sandbox: Sandbox | null = null;
      let tempExtractDir: string | null = null;

      try {
        await prisma.user.create({
          data: {
            id: testUserId,
            clerkId: testUserId,
            email: `acc-${scenario.id}-${timestamp}@codemytra.test`,
            name: `Test User ${scenario.name}`,
          },
        });

        await prisma.project.create({
          data: {
            id: testProjectId,
            name: scenario.name,
            userId: testUserId,
          },
        });

        // 1. Unified Specification Pipeline
        // 1. Unified Specification Pipeline & Planner Capability Verification
        const prd1 = await runPlannerAgent(scenario.initialPrompt, {
          existingPRD: null,
          existingDesignSpec: null,
          existingArchitectureSpec: null,
          existingFiles: null,
        });
        assert.ok(prd1.projectName, "PRD must define projectName");

        // Verify the planner produces appropriate capabilities
        for (const cap of scenario.expectedCapabilities) {
          const capCovered =
            prd1.capabilities.includes(cap as any) ||
            prd1.coreFeatures.some(
              (f) =>
                f.name.toLowerCase().includes(cap.replace(/-/g, " ")) ||
                f.description.toLowerCase().includes(cap.replace(/-/g, " "))
            );
          assert.ok(capCovered, `Planner PRD should cover expected capability "${cap}" for ${scenario.name}`);
        }

        // 2. Assert Generated Architecture Matches Capabilities
        const design1 = await runDesignAgent(prd1);
        const arch1 = await runArchitectureAgent(prd1, design1);
        assert.equal(
          arch1.requiresDatabase,
          scenario.requiresPersistence,
          `Architecture requiresDatabase mismatch for ${scenario.name}`
        );
        for (const cap of scenario.expectedCapabilities) {
          assert.ok(
            arch1.capabilities.includes(cap as any),
            `Architecture capabilities should include "${cap}" for ${scenario.name}`
          );
        }

        // Foundation Provisioning
        const baseFiles = getBaseProjectFiles({
          projectName: prd1.projectName,
          capabilities: arch1.capabilities,
          requiresDatabase: arch1.requiresDatabase,
          models: arch1.databaseModels,
        });

        // Sandbox Initialization
        sandbox = await Sandbox.create({ template: process.env.E2B_TEMPLATE_ID! });
        await initializeSandboxWorkspace(sandbox);

        for (const [filePath, content] of Object.entries(baseFiles)) {
          const target = resolveWorkspacePath(filePath);
          await sandbox.files.write(target, content);
        }

        // 3. Authoritative Coding Engine Execution (V1)
        const initialRunId = `run_acc_1_${timestamp}`;
        await prisma.generationRun.create({
          data: {
            id: initialRunId,
            projectId: testProjectId,
            userId: testUserId,
            prompt: scenario.initialPrompt,
            status: GenerationRunStatus.RUNNING,
          },
        });

        const codeResult1 = await runCodingAgent({
          sandboxId: sandbox.sandboxId,
          prompt: scenario.initialPrompt,
          prd: prd1,
          designSpec: design1,
          architectureSpec: arch1,
          baseFiles,
          stepPrefix: `acc-init-${scenario.id}`,
        });

        // 4. Real QA Inspection (V1)
        const qa1 = await runQAInspector({
          files: codeResult1.files,
          summary: codeResult1.summary,
          sandboxId: sandbox.sandboxId,
          runSandboxCommands: true,
          archSpec: arch1,
          capabilities: arch1.capabilities,
        });
        assert.equal(qa1.passed, true, `Initial QA failed for ${scenario.name}: ${qa1.repairInstructions}`);

        // 5. Persist V1
        const snapshot1 = await captureSandboxSnapshot(sandbox.sandboxId);
        const finalization1 = await finalizeGenerationSuccess({
          projectId: testProjectId,
          generationRunId: initialRunId,
          baseRevisionId: null,
          fragmentTitle: `${scenario.name} Initial`,
          summary: codeResult1.summary,
          files: snapshot1.files,
          sandboxUrl: `http://${sandbox.getHost(3000)}`,
        });
        assert.equal(finalization1.revision.revisionNumber, 1);

        // 6. Re-Run Modification-Aware Planning for the Follow-Up Prompt
        const prd2 = await runPlannerAgent(scenario.followUpPrompt, {
          existingPRD: prd1,
          existingDesignSpec: design1,
          existingArchitectureSpec: arch1,
          existingFiles: snapshot1.files,
        });
        const design2 = await runDesignAgent(prd2);
        const arch2 = await runArchitectureAgent(prd2, design2);

        const followUpRunId = `run_acc_2_${timestamp}`;
        await prisma.generationRun.create({
          data: {
            id: followUpRunId,
            projectId: testProjectId,
            userId: testUserId,
            prompt: scenario.followUpPrompt,
            status: GenerationRunStatus.RUNNING,
            baseRevisionId: finalization1.revision.id,
          },
        });

        const codeResult2 = await runCodingAgent({
          sandboxId: sandbox.sandboxId,
          prompt: scenario.followUpPrompt,
          prd: prd2,
          designSpec: design2,
          architectureSpec: arch2,
          baseFiles: snapshot1.files,
          previousMessages: [
            { role: "user", content: scenario.initialPrompt },
            { role: "assistant", content: codeResult1.summary },
          ],
          stepPrefix: `acc-follow-${scenario.id}`,
        });

        // 7. Generate and Verify V2
        const qa2 = await runQAInspector({
          files: codeResult2.files,
          summary: codeResult2.summary,
          sandboxId: sandbox.sandboxId,
          runSandboxCommands: true,
          archSpec: arch2,
          capabilities: arch2.capabilities,
        });
        assert.equal(qa2.passed, true, `Follow-up QA failed for ${scenario.name}: ${qa2.repairInstructions}`);

        const snapshot2 = await captureSandboxSnapshot(sandbox.sandboxId);

        // 8. Assert Previous Required Functionality Survives
        for (const v1Path of Object.keys(snapshot1.files)) {
          if (
            v1Path === "app/page.tsx" ||
            v1Path === "prisma/schema.prisma" ||
            v1Path === "lib/db.ts" ||
            v1Path.startsWith("app/api/")
          ) {
            assert.ok(
              snapshot2.files[v1Path] !== undefined,
              `Previous essential file "${v1Path}" must survive in V2 generation for ${scenario.name}`
            );
          }
        }

        // 9. Export the Resulting Revision
        const finalization2 = await finalizeGenerationSuccess({
          projectId: testProjectId,
          generationRunId: followUpRunId,
          baseRevisionId: finalization1.revision.id,
          fragmentTitle: `${scenario.name} Update`,
          summary: codeResult2.summary,
          files: snapshot2.files,
          sandboxUrl: `http://${sandbox.getHost(3000)}`,
        });
        assert.equal(finalization2.revision.revisionNumber, 2);

        const exportZip = await generateProjectZip({
          projectId: testProjectId,
          revisionId: finalization2.revision.id,
          userId: testUserId,
        });
        assert.ok(exportZip.buffer.length > 1000, "Export ZIP buffer must be non-empty");

        tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), `acc-export-${scenario.id}-`));
        const zip = await JSZip.loadAsync(exportZip.buffer);
        for (const [p, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          const out = path.join(tempExtractDir, p);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, await file.async("nodebuffer"));
        }

        let appDir = tempExtractDir;
        if (!fs.existsSync(path.join(appDir, "package.json"))) {
          const entries = fs.readdirSync(tempExtractDir);
          for (const entry of entries) {
            const cand = path.join(tempExtractDir, entry);
            if (fs.statSync(cand).isDirectory() && fs.existsSync(path.join(cand, "package.json"))) {
              appDir = cand;
              break;
            }
          }
        }

        // 10. Install and Build the Exported Application Independently
        const installRes = spawnSync("npm", ["install", "--no-audit", "--prefer-offline"], {
          cwd: appDir,
          encoding: "utf8",
          timeout: 120000,
          env: { ...process.env, CI: "true" },
        });
        assert.equal(installRes.status, 0, `Exported npm install failed: ${installRes.stderr || installRes.stdout}`);

        if (scenario.requiresPersistence) {
          fs.copyFileSync(path.join(appDir, ".env.example"), path.join(appDir, ".env"));
          const pushRes = spawnSync("npx", ["prisma", "db", "push"], {
            cwd: appDir,
            encoding: "utf8",
            timeout: 30000,
          });
          assert.equal(pushRes.status, 0, `Exported prisma db push failed: ${pushRes.stderr || pushRes.stdout}`);
        }

        const tscRes = spawnSync("npx", ["tsc", "--noEmit"], {
          cwd: appDir,
          encoding: "utf8",
          timeout: 60000,
        });
        assert.equal(tscRes.status, 0, `Exported TypeScript check failed: ${tscRes.stderr || tscRes.stdout}`);

        const buildRes = spawnSync("npm", ["run", "build"], {
          cwd: appDir,
          encoding: "utf8",
          timeout: 90000,
          env: { ...process.env, CI: "true" },
        });
        assert.equal(buildRes.status, 0, `Exported production build failed: ${buildRes.stderr || buildRes.stdout}`);

        // Scenario-specific behavioural verification
        const pageContent = fs.readFileSync(path.join(appDir, "app/page.tsx"), "utf8");
        if (scenario.id === "scenario-portfolio") {
          assert.ok(
            pageContent.includes("project") || pageContent.includes("Project"),
            "Portfolio must showcase projects"
          );
        } else if (scenario.id === "scenario-inventory") {
          assert.ok(
            fs.existsSync(path.join(appDir, "app/api")) || fs.existsSync(path.join(appDir, "src/app/api")),
            "Inventory must have API routes"
          );
        } else if (scenario.id === "scenario-booking") {
          assert.ok(
            fs.existsSync(path.join(appDir, "prisma/schema.prisma")),
            "Booking workflow must have schema.prisma"
          );
        } else if (scenario.id === "scenario-ecommerce") {
          assert.ok(
            pageContent.includes("cart") || pageContent.includes("Cart") || pageContent.includes("order"),
            "E-commerce store must handle cart or order logic"
          );
        }
      } finally {
        if (sandbox) {
          try {
            await (sandbox as unknown as { kill?: () => Promise<void> }).kill?.();
          } catch {
            // Ignore kill errors
          }
        }
        if (tempExtractDir) {
          fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
        try {
          await prisma.message.deleteMany({ where: { projectId: testProjectId } });
          await prisma.projectRevision.deleteMany({ where: { projectId: testProjectId } });
          await prisma.generationRun.deleteMany({ where: { projectId: testProjectId } });
          await prisma.project.delete({ where: { id: testProjectId } });
          await prisma.user.delete({ where: { id: testUserId } });
        } catch {
          // Ignore DB cleanup
        }
      }
    });
  }
});
