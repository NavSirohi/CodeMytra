import { prisma } from "@/lib/db";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { MessageRole, GenerationRunStatus, Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { getGeminiModel } from "@/server/providers/gemini";
import { FRAGMENT_TITLE_PROMPT, RESPONSE_PROMPT } from "@/lib/prompt";
import { agentOutputText, connectSandbox } from "./utils";
import { transitionRun } from "@/server/orchestration/state-machine";
import {
  resolveBaseRevision,
  validateRevisionManifest,
  RestorationError,
  FileTreeManifest,
} from "@/server/orchestration/revisions";
import {
  finalizeGenerationSuccess,
  finalizeGenerationFailure,
  FinalizeGenerationSuccessResult,
} from "@/server/orchestration/finalization";
import { runPlannerAgent, saveProjectPRD } from "@/server/agents/planner";
import { runDesignAgent, saveDesignSpec } from "@/server/agents/designer";
import { runArchitectureAgent, saveArchitectureSpec } from "@/server/agents/architect";
import { runQAInspector } from "@/server/agents/qa";
import { captureSandboxSnapshot } from "@/server/orchestration/sandbox-snapshot";
import { PRD, DesignSpec, ArchitectureSpec } from "@/server/agent-contracts/schemas";
import { runCodingAgent } from "@/server/agents/coder";
import {
  initializeSandboxWorkspace,
  resolveWorkspacePath,
} from "@/server/orchestration/workspace";

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
}

function getE2BTemplateId(): string {
  const id = process.env.E2B_TEMPLATE_ID;
  if (!id) {
    throw new Error(
      "E2B_TEMPLATE_ID is not set. Add it to your .env file. " +
      "Create your own E2B account at https://e2b.dev"
    );
  }
  return id;
}

/**
 * Records an immutable event in the run timeline for real-time UI streaming.
 */
async function recordRunEvent(
  runId: string | undefined,
  stage: string,
  agentRole: string,
  message: string,
  payload?: Record<string, unknown>
) {
  if (!runId) return;
  try {
    await prisma.runEvent.create({
      data: {
        runId,
        stage,
        agentRole,
        message,
        payload: payload ? (payload as unknown as Prisma.InputJsonObject) : undefined,
      },
    });
  } catch (err) {
    console.error("[RunEvent] Failed to log event:", err);
  }
}



export const codeAgentFunction = inngest.createFunction(
  {
    id: "code-agent",
    triggers: { event: "code-agent/run" },
    retries: 2,
    onFailure: async ({ event, error }) => {
      const data = event.data?.event?.data as { runId?: string; projectId?: string } | undefined;
      const runId = data?.runId;
      const projectId = data?.projectId;

      if (typeof runId !== "string" || typeof projectId !== "string") {
        console.error("[Generation] Missing run or project identity in failure handler");
        return;
      }

      try {
        const safeErrorMessage =
          typeof error?.message === "string" && error.message.trim().length > 0
            ? error.message.slice(0, 500)
            : "Generation failed after workflow retries.";

        await finalizeGenerationFailure({
          generationRunId: runId,
          projectId,
          errorCode: "WORKFLOW_EXECUTION_FAILED",
          errorMessage: safeErrorMessage,
        });
      } catch (err) {
        console.error(
          "[Generation] Failure finalization failed:",
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }
    },
  },
  async ({ event, step }) => {
    const projectId = event.data.projectId as string;
    const runId = event.data.runId as string;
    const promptValue = event.data.value as string;
    const baseRevisionId = (event.data.baseRevisionId as string) || undefined;

    // Enforce required persisted runId
    if (!runId) {
      throw new Error("Missing required persisted runId for generation execution");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 0: RESOLVE BASE FILES & EXISTING CONTEXT
    // ─────────────────────────────────────────────────────────────────────────
    const { baseFiles, baseRev } = await step.run("resolve-base-files", async () => {
      const rev = await resolveBaseRevision(projectId, baseRevisionId);
      return {
        baseFiles: (rev?.files as Record<string, string>) || {},
        baseRev: rev,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: REQUIREMENTS & PLANNING (Planner Agent with Gemini 2.5 Pro)
    // ─────────────────────────────────────────────────────────────────────────
    const prd = await step.run("planner-agent", async () => {
      await transitionRun(runId, GenerationRunStatus.PLANNING);
      await recordRunEvent(runId, "PLANNING", "Planner Agent", "Analyzing requirements and drafting product specification");

      const existingSpec = await prisma.projectSpecification.findUnique({
        where: { projectId },
      });

      const generatedPRD = await runPlannerAgent(promptValue, {
        existingPRD: (existingSpec?.prd as unknown as PRD) || null,
        existingDesignSpec: (existingSpec?.designSpec as unknown as DesignSpec) || null,
        existingArchitectureSpec: (existingSpec?.architectureSpec as unknown as ArchitectureSpec) || null,
        existingFiles: baseFiles,
      });

      await saveProjectPRD(projectId, generatedPRD);

      await recordRunEvent(
        runId,
        "PLANNING",
        "Planner Agent",
        `Generated PRD for ${generatedPRD.projectName} with ${generatedPRD.pages.length} pages`
      );

      return generatedPRD;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: DESIGN SPECIFICATION (Design Agent with Gemini 2.5 Flash)
    // ─────────────────────────────────────────────────────────────────────────
    const designSpec = await step.run("designer-agent", async () => {
      await transitionRun(runId, GenerationRunStatus.DESIGNING);
      await recordRunEvent(runId, "DESIGNING", "Design Agent", "Creating accessible color palette, typography, and component styling");

      const spec = await runDesignAgent(prd);
      await saveDesignSpec(projectId, spec);

      await recordRunEvent(
        runId,
        "DESIGNING",
        "Design Agent",
        `Selected ${spec.aestheticTheme} theme with primary color ${spec.colorPalette.primary}`
      );

      return spec;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: ARCHITECTURE & CONTRACTS (Architecture Agent with Gemini 2.5 Pro)
    // ─────────────────────────────────────────────────────────────────────────
    const archSpec = await step.run("architect-agent", async () => {
      await transitionRun(runId, GenerationRunStatus.ARCHITECTING);
      await recordRunEvent(runId, "ARCHITECTING", "Architecture Agent", "Establishing route contracts and file ownership boundaries");

      const spec = await runArchitectureAgent(prd, designSpec);
      await saveArchitectureSpec(projectId, spec);

      await recordRunEvent(
        runId,
        "ARCHITECTING",
        "Architecture Agent",
        `Configured ${spec.routeEndpoints.length} route endpoints with Next.js full-stack architecture`
      );

      return spec;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: FILESYSTEM RESTORATION & SANDBOX INITIALIZATION
    // ─────────────────────────────────────────────────────────────────────────
    await step.run("mark-run-running", async () => {
      await transitionRun(runId, GenerationRunStatus.RUNNING);
      await recordRunEvent(runId, "RUNNING", "Integration Agent", "Restoring previous project filesystem and spinning up execution sandbox");
    });

    const sandboxId = await step.run("get-sandbox-id-and-restore", async () => {
      // 1. Validate manifest before restoring
      if (baseRev?.manifest) {
        const manifestValidation = validateRevisionManifest(
          baseFiles,
          baseRev.manifest as unknown as FileTreeManifest
        );
        if (!manifestValidation.valid) {
          throw new RestorationError(`Base revision manifest invalid: ${manifestValidation.error}`);
        }
      }

      const sandbox = await Sandbox.create({
        template: getE2BTemplateId(),
      });

      // Initialize authoritative project workspace inside sandbox
      await initializeSandboxWorkspace(sandbox);

      // 2. Restore files from base revision into authoritative project workspace
      const fileEntries = Object.entries(baseFiles);
      if (fileEntries.length > 0) {
        for (const [filePath, content] of fileEntries) {
          try {
            const targetPath = resolveWorkspacePath(filePath);
            await sandbox.files.write(targetPath, content);
          } catch (writeError) {
            throw new RestorationError(`Failed to restore file ${filePath} into sandbox workspace: ${String(writeError)}`);
          }
        }

        // 3. Verify restoration completeness
        for (const [filePath] of fileEntries) {
          try {
            const targetPath = resolveWorkspacePath(filePath);
            await sandbox.files.read(targetPath);
          } catch {
            throw new RestorationError(`Completeness check failed: Restored file ${filePath} could not be read from workspace`);
          }
        }
      }

      return sandbox.sandboxId;
    });

    const previousMessages = await step.run("get-previous-messages", async () => {
      const messages = await prisma.message.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      });

      return messages.map((message) => ({
        type: "text" as const,
        role:
          message.role === MessageRole.ASSISTANT
            ? ("assistant" as const)
            : ("user" as const),
        content: message.content,
      }));
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: IMPLEMENTATION (Authoritative Coding Agent Engine)
    // ─────────────────────────────────────────────────────────────────────────
    const { summary, files } = await runCodingAgent({
      sandboxId,
      prompt: promptValue,
      prd,
      designSpec,
      architectureSpec: archSpec,
      baseFiles,
      previousMessages,
      step,
      stepPrefix: "initial-coding",
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 6: TITLE & RESPONSE TEXT HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    const geminiModel = getGeminiModel({
      model: "gemini-2.5-flash",
    });

    const makeTextAgent = (name: string, system: string) =>
      createAgent({ name, system, model: geminiModel });

    const fragmentTitleGenerator = makeTextAgent(
      "fragment-title-generator",
      FRAGMENT_TITLE_PROMPT
    );
    const responseGenerator = makeTextAgent(
      "response-generator",
      RESPONSE_PROMPT
    );

    const [{ output: fragmentTitleOutput }, { output: responseOutput }] =
      await Promise.all([
        fragmentTitleGenerator.run(summary, { step }),
        responseGenerator.run(summary, { step }),
      ]);

    const fragmentTitle = agentOutputText(fragmentTitleOutput, prd.projectName || "Application Update");
    const responseText = agentOutputText(responseOutput, "Here is your built application.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 7: QUALITY ASSURANCE, VERIFICATION & BOUNDED REPAIR
    // ─────────────────────────────────────────────────────────────────────────
    const qaResult = await step.run("qa-agent", async () => {
      await transitionRun(runId, GenerationRunStatus.VALIDATING);
      await recordRunEvent(runId, "VALIDATING", "QA Agent", "Running comprehensive sandbox verification pipeline");

      let currentFiles = { ...(files || {}) };
      let currentSummary = summary;

      // Pass 1: Run comprehensive verification checks
      let report = await runQAInspector({
        files: currentFiles,
        summary: currentSummary,
        sandboxId,
        runSandboxCommands: true,
      });

      // Bounded self-repair (1 repair iteration)
      if (!report.passed && report.repairNeeded) {
        await recordRunEvent(
          runId,
          "VALIDATING",
          "QA Agent",
          `Initial verification failed (${report.score}%). Initiating bounded self-repair.`
        );

        const repairPrompt = `
Your previous code implementation failed quality and build verification checks:
${report.repairInstructions}

Please inspect and fix the errors in the sandbox files using createOrUpdateFiles or terminal.
Ensure all TypeScript and Next.js compiler errors are resolved.
Conclude with an updated <task_summary>...</task_summary>.
`;
        try {
          const repairResult = await runCodingAgent({
            sandboxId,
            prompt: repairPrompt,
            prd,
            designSpec,
            architectureSpec: archSpec,
            baseFiles: currentFiles,
            previousMessages: [
              { role: "user", content: promptValue },
              { role: "assistant", content: currentSummary },
            ],
            step,
            stepPrefix: "qa-repair-1",
          });
          currentFiles = repairResult.files;
          currentSummary = repairResult.summary;

          // Re-verify after repair attempt
          report = await runQAInspector({
            files: currentFiles,
            summary: currentSummary,
            sandboxId,
            runSandboxCommands: true,
          });
        } catch (repairErr) {
          console.error("[QA Repair] Repair loop execution failed:", repairErr);
        }
      }

      await recordRunEvent(
        runId,
        "VALIDATING",
        "QA Agent",
        `Verification complete with quality score ${report.score}% (${report.passed ? "PASSED" : "FAILED"})`
      );

      // Capture exact filesystem snapshot from the canonical workspace directory in sandbox
      let finalFiles = currentFiles;
      if (report.passed) {
        try {
          const snapshot = await captureSandboxSnapshot(sandboxId);
          finalFiles = snapshot.files;
        } catch (snapErr) {
          // Reject incomplete snapshot instead of falling back silently
          const errMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
          console.error("[QA Snapshot] Snapshot capture failed:", errMsg);
          report = {
            ...report,
            passed: false,
            score: Math.min(report.score, 50),
            repairNeeded: true,
            repairInstructions: `Snapshot capture failed: ${errMsg}. Build artifacts or missing entrypoint detected.`,
          };
        }
      }

      return { report, finalFiles, finalSummary: currentSummary };
    });

    const { report: qaReport, finalFiles, finalSummary } = qaResult;

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 8: PERSISTENCE & PREVIEW
    // ─────────────────────────────────────────────────────────────────────────
    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await connectSandbox(sandboxId);
      return `http://${sandbox.getHost(3000)}`;
    });

    const finalizationResult = await step.run("save-result", async () => {
      if (!qaReport.passed || qaReport.verificationMode === "static-only") {
        const failureReason = qaReport.verificationMode === "static-only"
          ? "Static-only validation is not permitted for verified builds. Live sandbox verification required."
          : (qaReport.repairInstructions || "Validation checks failed");

        return await finalizeGenerationFailure({
          projectId,
          generationRunId: runId,
          errorCode: "QA_VERIFICATION_FAILED",
          errorMessage: failureReason,
        });
      }

      return await finalizeGenerationSuccess({
        projectId,
        generationRunId: runId,
        baseRevisionId,
        fragmentTitle,
        summary: responseText,
        files: finalFiles || {},
        sandboxUrl,
      });
    });

    if (!qaReport.passed || qaReport.verificationMode === "static-only") {
      const failureReason = qaReport.verificationMode === "static-only"
        ? "Static-only validation is not permitted for verified builds. Live sandbox verification required."
        : (qaReport.repairInstructions || "Validation checks failed");

      return {
        status: "FAILED" as const,
        error: failureReason,
        priorRevisionPreserved: true,
        messageId: finalizationResult.messageId,
      };
    }

    const successResult = finalizationResult as FinalizeGenerationSuccessResult;

    return {
      status: "COMPLETED" as const,
      url: sandboxUrl,
      title: fragmentTitle,
      files: finalFiles,
      summary: finalSummary,
      revisionId: successResult.revision.id,
      revisionNumber: successResult.revision.revisionNumber,
      messageId: successResult.messageId,
    };
  }
);