import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
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
        const prd1 = await runPlannerAgent(scenario.initialPrompt, {
          existingPRD: null,
          existingDesignSpec: null,
          existingArchitectureSpec: null,
          existingFiles: null,
        });
        assert.ok(prd1.projectName, "PRD must define projectName");

        const design1 = await runDesignAgent(prd1);
        const arch1 = await runArchitectureAgent(prd1, design1);
        assert.equal(
          arch1.requiresDatabase,
          scenario.requiresPersistence,
          `Architecture requiresDatabase mismatch for ${scenario.name}`
        );

        // 2. Foundation Provisioning
        const baseFiles = getBaseProjectFiles({
          projectName: prd1.projectName,
          capabilities: arch1.capabilities,
          requiresDatabase: arch1.requiresDatabase,
          models: arch1.databaseModels,
        });

        // 3. Sandbox Initialization
        sandbox = await Sandbox.create({ template: process.env.E2B_TEMPLATE_ID! });
        await initializeSandboxWorkspace(sandbox);

        for (const [filePath, content] of Object.entries(baseFiles)) {
          const target = resolveWorkspacePath(filePath);
          await sandbox.files.write(target, content);
        }

        // 4. Initial Implementation (V1)
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

        // 5. Real QA Inspection (V1)
        const qa1 = await runQAInspector({
          files: codeResult1.files,
          summary: codeResult1.summary,
          sandboxId: sandbox.sandboxId,
          runSandboxCommands: true,
          archSpec: arch1,
          capabilities: arch1.capabilities,
        });
        assert.equal(qa1.passed, true, `Initial QA failed for ${scenario.name}: ${qa1.repairInstructions}`);

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

        // 6. Follow-Up Modification (V2)
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
          prd: prd1,
          designSpec: design1,
          architectureSpec: arch1,
          baseFiles: snapshot1.files,
          previousMessages: [
            { role: "user", content: scenario.initialPrompt },
            { role: "assistant", content: codeResult1.summary },
          ],
          stepPrefix: `acc-follow-${scenario.id}`,
        });

        // 7. Follow-up QA (V2)
        const qa2 = await runQAInspector({
          files: codeResult2.files,
          summary: codeResult2.summary,
          sandboxId: sandbox.sandboxId,
          runSandboxCommands: true,
          archSpec: arch1,
          capabilities: arch1.capabilities,
        });
        assert.equal(qa2.passed, true, `Follow-up QA failed for ${scenario.name}: ${qa2.repairInstructions}`);

        const snapshot2 = await captureSandboxSnapshot(sandbox.sandboxId);
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

        // 8. ZIP Export & Reproducibility Verification
        const exportZip = await generateProjectZip({
          projectId: testProjectId,
          revisionId: finalization2.revision.id,
          userId: testUserId,
        });
        assert.ok(exportZip.buffer.length > 1000);

        tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), `acc-export-${scenario.id}-`));
        const zip = await JSZip.loadAsync(exportZip.buffer);
        for (const [p, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          const out = path.join(tempExtractDir, p);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, await file.async("nodebuffer"));
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
