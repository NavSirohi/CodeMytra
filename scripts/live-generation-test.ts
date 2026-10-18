import { Sandbox } from "@e2b/code-interpreter";
import { runPlannerAgent } from "../src/server/agents/planner";
import { runDesignAgent } from "../src/server/agents/designer";
import { runArchitectureAgent } from "../src/server/agents/architect";
import { runCodingAgent } from "../src/server/agents/coder";
import { runQAInspector } from "../src/server/agents/qa";
import { captureSandboxSnapshot } from "../src/server/orchestration/sandbox-snapshot";
import { initializeSandboxWorkspace } from "../src/server/orchestration/workspace";
import { finalizeGenerationSuccess } from "../src/server/orchestration/finalization";
import { prisma } from "../src/lib/db";
import { GenerationRunStatus } from "../src/generated/prisma/client";

/**
 * =============================================================================
 * Category 2: Live Generation Integration Test
 * =============================================================================
 * Distinct from:
 *   - Category 1 (Unit & Database Integration Tests): State machines, manifests,
 *     outbox claiming, transactions, and mocks.
 *   - Category 3 (Full Product E2E Test): Customer-facing workflow with modifications,
 *     restoration, authenticated ZIP export, and standalone host compilation.
 *
 * Scope: Directly invokes the shared real coding engine (runCodingAgent),
 * Gemini model, E2B sandbox container, QA inspector, and database services.
 * =============================================================================
 */
async function main() {
  console.log("=".repeat(80));
  console.log(" CodeMytra Category 2: Live Generation Integration Test");
  console.log(" Direct verification of shared coding engine, Gemini, E2B, QA & DB");
  console.log("=".repeat(80));

  const e2bKey = process.env.E2B_API_KEY;
  const e2bTemplate = process.env.E2B_TEMPLATE_ID;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!e2bKey || !e2bTemplate || !geminiKey) {
    console.log("\n" + "-".repeat(80));
    console.log("STATUS: [SKIPPED] Missing credentials for live generation integration test");
    console.log("-".repeat(80));
    console.log("The following environment variables are required for live cloud verification:");
    if (!e2bKey) console.log("  - E2B_API_KEY");
    if (!e2bTemplate) console.log("  - E2B_TEMPLATE_ID");
    if (!geminiKey) console.log("  - GEMINI_API_KEY");
    console.log("\nNote: Unit & database tests (npm test) provide offline deterministic proof.");
    console.log("-".repeat(80));
    process.exit(0);
  }

  let sandbox: Sandbox | null = null;
  const timestamp = Date.now();
  const testUserId = `clerk_live_gen_${timestamp}`;
  const testProjectId = `proj_live_gen_${timestamp}`;
  const testRunId = `run_live_gen_${timestamp}`;

  try {
    // 1. Database setup
    await prisma.user.create({
      data: {
        id: testUserId,
        clerkId: testUserId,
        email: `live-${timestamp}@codemytra.test`,
        name: "Live Test User",
      },
    });
    await prisma.project.create({
      data: { id: testProjectId, userId: testUserId, name: "Live Counter Application" },
    });
    await prisma.generationRun.create({
      data: {
        id: testRunId,
        projectId: testProjectId,
        userId: testUserId,
        prompt: "Build an interactive counter app with increment, decrement, and reset buttons",
        status: GenerationRunStatus.RUNNING,
      },
    });

    // 2. Multi-agent specs
    console.log("\n▶ Running Planner, Designer, and Architect specs...");
    const prompt = "Build an interactive counter app with increment, decrement, and reset buttons";
    const prd = await runPlannerAgent(prompt, {
      existingPRD: null,
      existingDesignSpec: null,
      existingArchitectureSpec: null,
      existingFiles: null,
    });
    const design = await runDesignAgent(prd);
    const arch = await runArchitectureAgent(prd, design);

    // 3. E2B Sandbox provisioning & workspace initialization
    console.log("\n▶ Provisioning E2B sandbox container...");
    sandbox = await Sandbox.create({ template: e2bTemplate });
    await initializeSandboxWorkspace(sandbox);

    // 4. Invoke shared coding engine
    console.log("\n▶ Executing shared authoritative coding engine (runCodingAgent)...");
    const codingResult = await runCodingAgent({
      sandboxId: sandbox.sandboxId,
      prompt: "Build an interactive counter app",
      prd,
      designSpec: design,
      architectureSpec: arch,
      stepPrefix: "live-gen-test",
    });

    // 5. Run QA inspector in workspace
    console.log("\n▶ Executing QA verification inside workspace...");
    const qaReport = await runQAInspector({
      files: codingResult.files,
      summary: codingResult.summary,
      sandboxId: sandbox.sandboxId,
      runSandboxCommands: true,
    });

    if (!qaReport.passed) {
      throw new Error(`QA Verification failed: ${qaReport.repairInstructions}`);
    }

    // 6. Snapshot & Transactional Finalization
    const snapshot = await captureSandboxSnapshot(sandbox.sandboxId);
    const finalizationResult = await finalizeGenerationSuccess({
      projectId: testProjectId,
      generationRunId: testRunId,
      fragmentTitle: "Interactive Counter App",
      summary: codingResult.summary,
      files: snapshot.files,
      sandboxUrl: `http://${sandbox.getHost(3000)}`,
    });

    console.log("\n" + "=".repeat(80));
    console.log(`STATUS: [PASSED] Live Generation Integration Succeeded`);
    console.log(`Persisted Revision V${finalizationResult.revision.revisionNumber} (ID: ${finalizationResult.revision.id})`);
    console.log("=".repeat(80));
  } finally {
    if (sandbox) {
      try { await sandbox.kill(); } catch {}
    }
    // Clean up disposable database records
    try {
      await prisma.project.deleteMany({ where: { id: testProjectId } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    } catch {}
  }
}

main().catch((err) => {
  console.error("Live generation test failed with error:", err);
  process.exit(1);
});
