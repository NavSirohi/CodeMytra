import { prisma } from "@/lib/db";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { MessageRole, GenerationRunStatus, Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { getOpenAIModel, isOpenAIPermanentError } from "@/server/providers/openai";
import { NonRetriableError } from "inngest";
import { FRAGMENT_TITLE_PROMPT, RESPONSE_PROMPT } from "@/lib/prompt";
import { agentOutputText, connectSandbox } from "./utils";
import { transitionRun } from "@/server/orchestration/state-machine";
import {
  ModelPreference,
  normalizeModelPreference,
} from "@/lib/models";
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
  PROJECT_WORKSPACE_DIR,
} from "@/server/orchestration/workspace";
import { getBaseProjectFiles, MissingDatabaseModelsError } from "@/server/templates/foundation";
import {
  recordStageMetric,
  aggregateAndPersistRunMetrics,
  extractUsageMetadata,
} from "@/server/observability/metrics";
import {
  canBypassPlanningAndArchitecture,
  filterRelevantFiles,
  selectModelForStage,
  GenerationTimeoutError,
  establishRunDeadline,
  getRemainingTimeMs,
  isPastDeadline,
  checkGenerationDeadline,
  GENERATION_LIMITS,
} from "@/server/orchestration/stage-optimizer";
import { runWithoutStepContext } from "@/server/orchestration/async-context";

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
}

interface AgentOutputUsage {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  modelId?: string;
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



/**
 * Concurrency-safe initialization and retrieval of persisted generation start-time.
 * Guarantees:
 * 1. Never overwrites an existing startedAt.
 * 2. Uses atomic CAS (updateMany where startedAt is null) so concurrent workers converge on one timestamp.
 * 3. Never silently adopts a transient local timestamp if persistence fails.
 * 4. Ensures Inngest retries derive an unchanged deadline from the persisted timestamp.
 */
export async function initializeRunStartTime(
  runId: string,
  dbClient: {
    generationRun: {
      findUnique: (args: { where: { id: string }; select: { startedAt: boolean; createdAt?: boolean } }) => Promise<{ startedAt: Date | null; createdAt?: Date } | null>;
      updateMany: (args: { where: { id: string; startedAt: null }; data: { startedAt: Date } }) => Promise<{ count: number }>;
    };
  } = prisma
): Promise<Date> {
  const existingRun = await dbClient.generationRun.findUnique({
    where: { id: runId },
    select: { startedAt: true, createdAt: true },
  });

  if (!existingRun) {
    throw new Error(`GenerationRun "${runId}" not found in database`);
  }

  if (existingRun.startedAt) {
    return existingRun.startedAt;
  }

  const now = new Date();
  await dbClient.generationRun.updateMany({
    where: { id: runId, startedAt: null },
    data: { startedAt: now },
  });

  const reloadedRun = await dbClient.generationRun.findUnique({
    where: { id: runId },
    select: { startedAt: true },
  });

  if (!reloadedRun?.startedAt) {
    throw new Error(
      `Failed to persist start time for GenerationRun "${runId}". Refusing to adopt transient local timestamp.`
    );
  }

  return reloadedRun.startedAt;
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

        const isTimeout =
          error instanceof GenerationTimeoutError ||
          (typeof error?.message === "string" &&
            (error.message.includes("timed out") ||
             error.message.includes("GenerationTimeoutError"))) ||
          (error instanceof Error && error.name === "GenerationTimeoutError");
        const isProviderConfigError = isOpenAIPermanentError(error);
        const errorCode = isTimeout
          ? "GENERATION_TIMEOUT"
          : isProviderConfigError
          ? "PROVIDER_CONFIGURATION_ERROR"
          : "WORKFLOW_EXECUTION_FAILED";

        await finalizeGenerationFailure({
          generationRunId: runId,
          projectId,
          errorCode,
          errorMessage: safeErrorMessage,
        });

        // Keep incomplete-run metrics available when generation fails.
        // Metrics persistence failure must NEVER undo or obscure successful failure finalization.
        try {
          await aggregateAndPersistRunMetrics(runId, projectId, "FAILED");
        } catch (metricsErr) {
          console.error(
            "[Generation] Metrics persistence failed on failure finalization (non-blocking):",
            metricsErr instanceof Error ? metricsErr.message : String(metricsErr)
          );
        }
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
    const rawModelPreference = event.data.modelPreference;
    const modelPreference: ModelPreference = normalizeModelPreference(rawModelPreference);

    // Enforce required persisted runId
    if (!runId) {
      throw new Error("Missing required persisted runId for generation execution");
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new NonRetriableError(
        "OPENAI_API_KEY is not configured. Add your OpenAI API key to environment variables."
      );
    }

    // Concurrency-safe persisted start-time initialization
    const persistedStart = await initializeRunStartTime(runId);
    const { deadlineMs, startedAtMs } = establishRunDeadline(persistedStart);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 0: RESOLVE BASE FILES & EXISTING SPECIFICATIONS
    // ─────────────────────────────────────────────────────────────────────────
    const { baseFiles, baseRev, bypassDecision, existingSpec } = await step.run("resolve-base-files", async () => {
      const rev = await resolveBaseRevision(projectId, baseRevisionId);
      const existing = await prisma.projectSpecification.findUnique({
        where: { projectId },
      });
      const parsedPRD = (existing?.prd as unknown as PRD) || null;
      const parsedDesign = (existing?.designSpec as unknown as DesignSpec) || null;
      const parsedArch = (existing?.architectureSpec as unknown as ArchitectureSpec) || null;

      const bypass = canBypassPlanningAndArchitecture(promptValue, {
        prd: parsedPRD,
        designSpec: parsedDesign,
        architectureSpec: parsedArch,
      });

      return {
        baseFiles: (rev?.files as Record<string, string>) || {},
        baseRev: rev,
        bypassDecision: bypass,
        existingSpec: {
          prd: parsedPRD,
          designSpec: parsedDesign,
          architectureSpec: parsedArch,
        },
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: REQUIREMENTS & PLANNING (Planner Agent with OpenAI)
    // ─────────────────────────────────────────────────────────────────────────
    const prd = await step.run("planner-spec", async () => {
      checkGenerationDeadline(deadlineMs, "planning");
      await transitionRun(runId, GenerationRunStatus.PLANNING);
      const stageStart = Date.now();
      const plannerModel = selectModelForStage("planning", { isComplexFullstack: false, modelPreference });

      if (bypassDecision.canBypass && existingSpec.prd) {
        await recordRunEvent(
          runId,
          "PLANNING",
          "Planner Agent",
          `Reusing approved PRD for ${existingSpec.prd.projectName} (${bypassDecision.reason})`
        );
        await recordStageMetric({
          runId,
          projectId,
          stageName: "planning",
          modelId: plannerModel,
          startedAt: stageStart,
          finishedAt: Date.now(),
          details: { bypassed: true, reason: bypassDecision.reason, modelPreference },
        });
        return existingSpec.prd;
      }

      await recordRunEvent(runId, "PLANNING", "Planner Agent", "Analyzing requirements and drafting product specification");

      const generatedPRD = await runPlannerAgent(
        promptValue,
        {
          existingPRD: existingSpec.prd,
          existingDesignSpec: existingSpec.designSpec,
          existingArchitectureSpec: existingSpec.architectureSpec,
          existingFiles: baseFiles,
        },
        { model: plannerModel }
      );

      await saveProjectPRD(projectId, generatedPRD);

      await recordRunEvent(
        runId,
        "PLANNING",
        "Planner Agent",
        `Generated PRD for ${generatedPRD.projectName} with ${generatedPRD.pages.length} pages`
      );

      const plannerUsage = (generatedPRD as unknown as AgentOutputUsage).usage;
      const plannerModelUsed = (generatedPRD as unknown as AgentOutputUsage).modelId || plannerModel;

      await recordStageMetric({
        runId,
        projectId,
        stageName: "planning",
        modelId: plannerModelUsed,
        startedAt: stageStart,
        finishedAt: Date.now(),
        promptTokens: plannerUsage?.promptTokens,
        completionTokens: plannerUsage?.completionTokens,
        details: { bypassed: false, pagesCount: generatedPRD.pages.length, modelPreference },
      });

      return generatedPRD;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: DESIGN SPECIFICATION (Design Agent with OpenAI)
    // ─────────────────────────────────────────────────────────────────────────
    const designSpec = await step.run("design-spec", async () => {
      checkGenerationDeadline(deadlineMs, "design");
      await transitionRun(runId, GenerationRunStatus.DESIGNING);
      const stageStart = Date.now();
      const designerModel = selectModelForStage("design", { modelPreference });

      if (bypassDecision.canBypass && existingSpec.designSpec) {
        await recordRunEvent(
          runId,
          "DESIGNING",
          "Design Agent",
          `Reusing approved design specification (${existingSpec.designSpec.aestheticTheme} theme)`
        );
        await recordStageMetric({
          runId,
          projectId,
          stageName: "design",
          modelId: designerModel,
          startedAt: stageStart,
          finishedAt: Date.now(),
          details: { bypassed: true, modelPreference },
        });
        return existingSpec.designSpec;
      }

      await recordRunEvent(runId, "DESIGNING", "Design Agent", "Creating accessible color palette, typography, and component styling");

      const spec = await runDesignAgent(prd, { model: designerModel });
      await saveDesignSpec(projectId, spec);

      await recordRunEvent(
        runId,
        "DESIGNING",
        "Design Agent",
        `Selected ${spec.aestheticTheme} theme with primary color ${spec.colorPalette.primary}`
      );

      const designerUsage = (spec as unknown as AgentOutputUsage).usage;
      const designerModelUsed = (spec as unknown as AgentOutputUsage).modelId || designerModel;

      await recordStageMetric({
        runId,
        projectId,
        stageName: "design",
        modelId: designerModelUsed,
        startedAt: stageStart,
        finishedAt: Date.now(),
        promptTokens: designerUsage?.promptTokens,
        completionTokens: designerUsage?.completionTokens,
        details: { bypassed: false, theme: spec.aestheticTheme, modelPreference },
      });

      return spec;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: ARCHITECTURE & CONTRACTS (Architecture Agent with OpenAI)
    // ─────────────────────────────────────────────────────────────────────────
    const archSpec = await step.run("architecture-spec", async () => {
      checkGenerationDeadline(deadlineMs, "architecture");
      await transitionRun(runId, GenerationRunStatus.ARCHITECTING);
      const stageStart = Date.now();
      const architectModel = selectModelForStage("architecture", { modelPreference });

      if (bypassDecision.canBypass && existingSpec.architectureSpec) {
        await recordRunEvent(
          runId,
          "ARCHITECTING",
          "Architecture Agent",
          `Reusing approved full-stack architecture specification (${existingSpec.architectureSpec.routeEndpoints.length} routes)`
        );
        await recordStageMetric({
          runId,
          projectId,
          stageName: "architecture",
          modelId: architectModel,
          startedAt: stageStart,
          finishedAt: Date.now(),
          details: { bypassed: true, modelPreference },
        });
        return existingSpec.architectureSpec;
      }

      await recordRunEvent(runId, "ARCHITECTING", "Architecture Agent", "Establishing route contracts and file ownership boundaries");

      const spec = await runArchitectureAgent(prd, designSpec, 1, { model: architectModel });
      await saveArchitectureSpec(projectId, spec);

      await recordRunEvent(
        runId,
        "ARCHITECTING",
        "Architecture Agent",
        `Configured ${spec.routeEndpoints.length} route endpoints with Next.js full-stack architecture`
      );

      // Task 3: Reject architecture requiring database persistence but lacking database models
      if (spec.requiresDatabase && (!spec.databaseModels || spec.databaseModels.length === 0)) {
        throw new MissingDatabaseModelsError(
          `Architecture specification for "${prd.projectName}" requires database persistence, but contains no database models.`
        );
      }

      const architectUsage = (spec as unknown as AgentOutputUsage).usage;
      const architectModelUsed = (spec as unknown as AgentOutputUsage).modelId || architectModel;

      await recordStageMetric({
        runId,
        projectId,
        stageName: "architecture",
        modelId: architectModelUsed,
        startedAt: stageStart,
        finishedAt: Date.now(),
        promptTokens: architectUsage?.promptTokens,
        completionTokens: architectUsage?.completionTokens,
        details: {
          bypassed: false,
          routesCount: spec.routeEndpoints.length,
          requiresDatabase: spec.requiresDatabase,
          modelPreference,
        },
      });

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
      checkGenerationDeadline(deadlineMs, "sandbox-init");
      const stageStart = Date.now();
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

      // 2. Initial vs Follow-up Generation File Preparation
      const isInitialGeneration = Object.keys(baseFiles).length === 0;
      let workspaceInitialFiles: Record<string, string> = baseFiles;

      if (isInitialGeneration) {
        // Initial generation: generate clean capability-driven foundation
        workspaceInitialFiles = getBaseProjectFiles({
          projectName: prd.projectName,
          capabilities: archSpec.capabilities,
          requiresDatabase: archSpec.requiresDatabase,
          models: archSpec.databaseModels,
        });
      }

      const fileEntries = Object.entries(workspaceInitialFiles);
      if (fileEntries.length > 0) {
        for (const [filePath, content] of fileEntries) {
          try {
            const targetPath = resolveWorkspacePath(filePath);
            await sandbox.files.write(targetPath, content);
          } catch (writeError) {
            throw new RestorationError(`Failed to restore/write file ${filePath} into sandbox workspace: ${String(writeError)}`);
          }
        }

        // 3. Verify completeness
        for (const [filePath] of fileEntries) {
          try {
            const targetPath = resolveWorkspacePath(filePath);
            await sandbox.files.read(targetPath);
          } catch {
            throw new RestorationError(`Completeness check failed: File ${filePath} could not be read from workspace`);
          }
        }
      }

      await recordStageMetric({
        runId,
        projectId,
        stageName: "sandbox-init",
        startedAt: stageStart,
        finishedAt: Date.now(),
        details: {
          templateId: getE2BTemplateId(),
          workspacePath: PROJECT_WORKSPACE_DIR,
          restoredFileCount: fileEntries.length,
        },
      });

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
    checkGenerationDeadline(deadlineMs, "coding");
    const effectiveBaseFiles = Object.keys(baseFiles).length === 0
      ? getBaseProjectFiles({
          projectName: prd.projectName,
          capabilities: archSpec.capabilities,
          requiresDatabase: archSpec.requiresDatabase,
          models: archSpec.databaseModels,
        })
      : baseFiles;

    const relevantBaseFiles = filterRelevantFiles(effectiveBaseFiles, promptValue);
    const coderModel = selectModelForStage("coding", {
      isComplexFullstack: archSpec.requiresDatabase,
      modelPreference,
    });
    const codingStageStart = Date.now();

    const { summary, files, usage: codingUsage, modelId: coderModelUsed } = await runCodingAgent({
      sandboxId,
      prompt: promptValue,
      prd,
      designSpec,
      architectureSpec: archSpec,
      baseFiles: relevantBaseFiles,
      previousMessages,
      step,
      stepPrefix: "initial-coding",
      model: coderModel,
    });

    await recordStageMetric({
      runId,
      projectId,
      stageName: "coding",
      modelId: coderModelUsed || coderModel,
      startedAt: codingStageStart,
      finishedAt: Date.now(),
      promptTokens: codingUsage?.promptTokens,
      completionTokens: codingUsage?.completionTokens,
      details: {
        filesCount: Object.keys(files || {}).length,
        modelPreference,
      },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 6: TITLE & RESPONSE TEXT HELPERS (Auxiliary AI Calls)
    // ─────────────────────────────────────────────────────────────────────────
    const auxStageStart = Date.now();
    const { fragmentTitle, responseText, auxPromptTokens, auxCompletionTokens } = await step.run(
      "generate-response-metadata",
      async () => {
        const openAIModel = getOpenAIModel({
          model: "gpt-4o-mini",
        });

        const makeTextAgent = (name: string, system: string) =>
          createAgent({ name, system, model: openAIModel });

        const fragmentTitleGenerator = makeTextAgent(
          "fragment-title-generator",
          FRAGMENT_TITLE_PROMPT
        );
        const responseGenerator = makeTextAgent(
          "response-generator",
          RESPONSE_PROMPT
        );

        const [fragmentTitleResult, responseResult] = await runWithoutStepContext(() =>
          Promise.all([
            fragmentTitleGenerator.run(summary),
            responseGenerator.run(summary),
          ])
        );

        const title = agentOutputText(fragmentTitleResult.output, prd.projectName || "Application Update");
        const respText = agentOutputText(responseResult.output, "Here is your built application.");

        const fragUsage = extractUsageMetadata(fragmentTitleResult);
        const respUsage = extractUsageMetadata(responseResult);
        const hasAuxUsage = Boolean(fragUsage || respUsage);
        const promptTokens = hasAuxUsage
          ? (fragUsage?.promptTokens || 0) + (respUsage?.promptTokens || 0)
          : undefined;
        const completionTokens = hasAuxUsage
          ? (fragUsage?.completionTokens || 0) + (respUsage?.completionTokens || 0)
          : undefined;

        return {
          fragmentTitle: title,
          responseText: respText,
          auxPromptTokens: promptTokens,
          auxCompletionTokens: completionTokens,
        };
      }
    );

    await recordStageMetric({
      runId,
      projectId,
      stageName: "auxiliary-text",
      modelId: "gpt-4o-mini",
      startedAt: auxStageStart,
      finishedAt: Date.now(),
      promptTokens: auxPromptTokens,
      completionTokens: auxCompletionTokens,
      details: {
        fragmentTitleGenerated: Boolean(fragmentTitle),
        responseGenerated: Boolean(responseText),
      },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 7: QUALITY ASSURANCE, VERIFICATION & BOUNDED REPAIR
    // ─────────────────────────────────────────────────────────────────────────
    const qaResult = await step.run("qa-agent", async () => {
      checkGenerationDeadline(deadlineMs, "qa-and-repair");
      await transitionRun(runId, GenerationRunStatus.VALIDATING);
      await recordRunEvent(runId, "VALIDATING", "QA Agent", "Running comprehensive sandbox verification pipeline");
      const qaStageStart = Date.now();
      let repairAttempts = 0;
      let repairPromptTokens: number | undefined;
      let repairCompletionTokens: number | undefined;
      let repairModelUsed: string | undefined;

      let currentFiles = { ...(files || {}) };
      let currentSummary = summary;

      // Pass 1: Run comprehensive verification checks
      let report = await runQAInspector({
        files: currentFiles,
        summary: currentSummary,
        sandboxId,
        runSandboxCommands: true,
        archSpec,
        capabilities: prd.capabilities,
      });

      // Bounded self-repair (1 repair iteration)
      if (!report.passed && report.repairNeeded) {
        // Enforce timeout: stop scheduling new repair after deadline or with insufficient budget
        if (isPastDeadline(deadlineMs) || getRemainingTimeMs(deadlineMs) < 15000) {
          await recordRunEvent(
            runId,
            "VALIDATING",
            "QA Agent",
            `Generation deadline reached or insufficient time remaining (${getRemainingTimeMs(deadlineMs)}ms remaining). Skipping self-repair.`
          );
          throw new GenerationTimeoutError(
            `Generation timed out: cannot initiate repair attempt with ${getRemainingTimeMs(deadlineMs)}ms remaining (deadline exceeded)`,
            Date.now() - startedAtMs,
            GENERATION_LIMITS.maxGenerationDurationMs
          );
        }

        repairAttempts++;
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
          const repairBaseFiles = filterRelevantFiles(currentFiles, repairPrompt);
          const repairModel = selectModelForStage("repair", { isRepairAttempt: true, modelPreference });
          const repairResult = await runCodingAgent({
            sandboxId,
            prompt: repairPrompt,
            prd,
            designSpec,
            architectureSpec: archSpec,
            baseFiles: repairBaseFiles,
            previousMessages: [
              { role: "user", content: promptValue },
              { role: "assistant", content: currentSummary },
            ],
            step,
            stepPrefix: "qa-repair-1",
            model: repairModel,
          });
          currentFiles = repairResult.files;
          currentSummary = repairResult.summary;
          if (repairResult.usage) {
            repairPromptTokens = repairResult.usage.promptTokens;
            repairCompletionTokens = repairResult.usage.completionTokens;
          }
          repairModelUsed = repairResult.modelId || repairModel;

          // Re-verify after repair attempt, enforcing deadline
          checkGenerationDeadline(deadlineMs, "qa-repair-verify");
          report = await runQAInspector({
            files: currentFiles,
            summary: currentSummary,
            sandboxId,
            runSandboxCommands: true,
            archSpec,
            capabilities: prd.capabilities,
          });
        } catch (repairErr) {
          if (repairErr instanceof GenerationTimeoutError) {
            throw repairErr;
          }
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

      await recordStageMetric({
        runId,
        projectId,
        stageName: "qa-and-repair",
        modelId: repairModelUsed,
        startedAt: qaStageStart,
        finishedAt: Date.now(),
        promptTokens: repairPromptTokens,
        completionTokens: repairCompletionTokens,
        details: {
          passed: report.passed,
          score: report.score,
          verificationMode: report.verificationMode,
          repairAttempts,
        },
      });

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
      const saveStageStart = Date.now();

      if (!qaReport.passed || qaReport.verificationMode === "static-only") {
        const failureReason = qaReport.verificationMode === "static-only"
          ? "Static-only validation is not permitted for verified builds. Live sandbox verification required."
          : (qaReport.repairInstructions || "Validation checks failed");

        const failResult = await finalizeGenerationFailure({
          projectId,
          generationRunId: runId,
          errorCode: "QA_VERIFICATION_FAILED",
          errorMessage: failureReason,
        });

        await recordStageMetric({
          runId,
          projectId,
          stageName: "save-result",
          startedAt: saveStageStart,
          finishedAt: Date.now(),
          details: { passed: false, errorCode: "QA_VERIFICATION_FAILED" },
        });

        await aggregateAndPersistRunMetrics(runId, projectId, "FAILED");

        return failResult;
      }

      const successResult = await finalizeGenerationSuccess({
        projectId,
        generationRunId: runId,
        baseRevisionId,
        fragmentTitle,
        summary: responseText,
        files: finalFiles || {},
        sandboxUrl,
      });

      await recordStageMetric({
        runId,
        projectId,
        stageName: "save-result",
        startedAt: saveStageStart,
        finishedAt: Date.now(),
        details: { passed: true, revisionId: successResult.revision.id },
      });

      await aggregateAndPersistRunMetrics(runId, projectId, "COMPLETED");

      return successResult;
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