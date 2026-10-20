import { prisma } from "@/lib/db";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { MessageRole, GenerationRunStatus, DraftValidationStatus, Prisma } from "@/generated/prisma/client";
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
  generateManifest,
  sanitizeProjectFiles,
} from "@/server/orchestration/revisions";
import {
  finalizeGenerationSuccess,
  finalizeGenerationFailure,
  isRunActiveInDb,
} from "@/server/orchestration/finalization";
import {
  upsertGenerationDraft,
} from "@/server/orchestration/drafts";
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
  ensureSandboxPreviewServer,
  writeWorkspaceFiles,
} from "@/server/orchestration/workspace";
import {
  getBaseProjectFiles,
  MissingDatabaseModelsError,
  synthesizeComponentsBarrel,
} from "@/server/templates/foundation";
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
  RunAbortedError,
  TokenBudgetExceededError,
  NoProgressError,
  IterationLimitExceededError,
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

export interface SourceCheckpoint {
  files: Record<string, string>;
  manifest: FileTreeManifest;
  source: string;
  diagnostics?: Record<string, unknown>;
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

        const isAborted =
          error instanceof RunAbortedError ||
          (error instanceof Error && error.name === "RunAbortedError") ||
          (typeof error?.message === "string" && error.message.includes("RunAbortedError"));

        const isTokenBudget =
          error instanceof TokenBudgetExceededError ||
          (error instanceof Error && error.name === "TokenBudgetExceededError") ||
          (typeof error?.message === "string" && error.message.includes("TokenBudgetExceededError"));

        const isNoProgress =
          error instanceof NoProgressError ||
          (error instanceof Error && error.name === "NoProgressError") ||
          (typeof error?.message === "string" && error.message.includes("NoProgressError"));

        const isIterationLimit =
          error instanceof IterationLimitExceededError ||
          (error instanceof Error && error.name === "IterationLimitExceededError") ||
          (typeof error?.message === "string" && error.message.includes("IterationLimitExceededError"));

        const isTimeout =
          error instanceof GenerationTimeoutError ||
          (typeof error?.message === "string" &&
            (error.message.includes("timed out") ||
             error.message.includes("GenerationTimeoutError"))) ||
          (error instanceof Error && error.name === "GenerationTimeoutError");
        const isProviderConfigError = isOpenAIPermanentError(error);

        // If aborted because run was already marked terminal in DB (e.g. by watchdog or user cancellation),
        // verify active status. If already terminal, do not overwrite terminal state or emit duplicate messages.
        if (isAborted) {
          const stillActive = await isRunActiveInDb(runId);
          if (!stillActive) {
            console.log(`[Generation onFailure] Run ${runId} is already terminal in DB. Skipping failure finalization.`);
            return;
          }
        }

        const errorCode = isAborted
          ? "RUN_ABORTED"
          : isTokenBudget
          ? "TOKEN_BUDGET_EXCEEDED"
          : isNoProgress
          ? "NO_PROGRESS_LIMIT"
          : isIterationLimit
          ? "ITERATION_LIMIT_EXCEEDED"
          : isTimeout
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

        // 4. Generate Prisma Client immediately if database schema was established
        if (workspaceInitialFiles["prisma/schema.prisma"]) {
          try {
            await sandbox.commands.run(
              `cd "${PROJECT_WORKSPACE_DIR}" && (bunx --bun prisma generate || npx prisma generate)`,
              { timeoutMs: 20000 }
            );
          } catch (prismaGenErr) {
            console.warn("[sandbox-init] Non-fatal prisma generate warning:", prismaGenErr);
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
    await step.run("check-coding-active", async () => {
      checkGenerationDeadline(deadlineMs, "coding");
      const isCodingActive = await isRunActiveInDb(runId);
      if (!isCodingActive) {
        throw new RunAbortedError(`Generation run ${runId} is no longer active in database`);
      }
      await recordRunEvent(
        runId,
        "CODING",
        "Code Agent",
        "Beginning code generation with authoritative AgentKit coder"
      );
      return { active: true };
    });

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

    const { summary, files, usage: codingUsage, modelId: coderModelUsed } = await step.run("initial-coding-agent", () => runCodingAgent({
      sandboxId,
      prompt: promptValue,
      prd,
      designSpec,
      architectureSpec: archSpec,
      baseFiles: relevantBaseFiles,
      previousMessages,
      // Never pass Inngest step into dynamic AgentKit tool callbacks.
      stepPrefix: "initial-coding",
      model: coderModel,
      generationRunId: runId,
      deadlineMs,
      maxIterations: GENERATION_LIMITS.maxCodingIterations,
      tokenBudget: GENERATION_LIMITS.maxRunTokenBudget,
    }));

    await step.run("check-post-coding-active", async () => {
      const isPostCodingActive = await isRunActiveInDb(runId);
      if (!isPostCodingActive) {
        throw new RunAbortedError(`Generation run ${runId} was marked terminal during coding stage`);
      }
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
      return { active: true };
    });

    await step.run("ensure-components-barrel", async () => {
      const filesWithBarrel = synthesizeComponentsBarrel(files || {});
      if (filesWithBarrel["components/index.ts"] && !files?.["components/index.ts"]) {
        try {
          const sandbox = await Sandbox.connect(sandboxId);
          await writeWorkspaceFiles(sandbox, {
            "components/index.ts": filesWithBarrel["components/index.ts"],
          });
          files["components/index.ts"] = filesWithBarrel["components/index.ts"];
        } catch (err) {
          console.warn("[ensure-components-barrel] Non-fatal barrel sync warning:", err);
        }
      }
      return { barrelEnsured: true };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DRAFT PERSISTENCE: CAPTURE AND PERSIST INITIAL DRAFT BEFORE QA
    // Architectural Note: Source code must never be lost if QA times out or fails.
    // Captures the exact workspace files from E2B sandbox immediately following
    // coding agent execution and persists the unverified draft artifact.
    // ─────────────────────────────────────────────────────────────────────────
    const initialCheckpoint = await step.run("capture-initial-draft", async (): Promise<SourceCheckpoint> => {
      let draftFiles: Record<string, string> = {};
      let draftManifest: FileTreeManifest = generateManifest({});
      let draftSource = "canonical-sandbox-snapshot";
      let draftStatus: DraftValidationStatus = DraftValidationStatus.UNVALIDATED;
      let draftDiagnostics: Record<string, unknown> | undefined = undefined;

      try {
        const snapshot = await captureSandboxSnapshot(sandboxId);
        if (snapshot.files && Object.keys(snapshot.files).length > 0) {
          draftFiles = snapshot.files;
          draftManifest = snapshot.manifest;
          draftSource = "canonical-sandbox-snapshot";
          draftDiagnostics = {
            provenance: "canonical-sandbox-snapshot",
            fileCount: Object.keys(draftFiles).length,
            durationMs: snapshot.diagnostics?.durationMs,
            totalBytes: snapshot.diagnostics?.totalBytes,
          };
          await recordRunEvent(
            runId,
            "CODING",
            "Integration Agent",
            `Persisted canonical sandbox filesystem snapshot (${Object.keys(draftFiles).length} files) to draft artifact`
          );
        } else {
          throw new Error("Authoritative workspace snapshot returned zero files");
        }
      } catch (snapErr) {
        const snapErrMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
        // Distinguish genuine snapshot failure with valid model-output fallback vs empty/failed source generation
        const coderFiles = files && typeof files === "object" ? sanitizeProjectFiles(files) : {};
        const validFileEntries = Object.entries(coderFiles).filter(
          ([k, v]) => typeof k === "string" && k.trim().length > 0 && typeof v === "string" && v.length > 0
        );

        if (validFileEntries.length > 0) {
          draftFiles = Object.fromEntries(validFileEntries);
          draftManifest = generateManifest(draftFiles);
          draftSource = "unverified-model-output-fallback";
          draftDiagnostics = {
            warning: "E2B filesystem snapshot capture failed; fell back to unverified model memory output",
            snapshotError: snapErrMsg,
            provenance: "unverified-model-output-fallback",
            fileCount: validFileEntries.length,
          };
          await recordRunEvent(
            runId,
            "CODING",
            "Integration Agent",
            `WARNING: E2B filesystem snapshot failed (${snapErrMsg}). Persisted unverified model-output fallback (${validFileEntries.length} files) to draft. Verification required before promotion.`
          );
        } else {
          draftFiles = {};
          draftManifest = generateManifest({});
          draftSource = "failed-source-generation";
          draftStatus = DraftValidationStatus.FAILED;
          draftDiagnostics = {
            error: "No source files were generated or captured from sandbox",
            snapshotError: snapErrMsg,
            provenance: "failed-source-generation",
          };
          await recordRunEvent(
            runId,
            "CODING",
            "Integration Agent",
            `CRITICAL: Coding stage produced no valid source files and filesystem snapshot failed (${snapErrMsg}). Draft marked FAILED.`
          );
        }
      }

      await upsertGenerationDraft({
        generationRunId: runId,
        projectId,
        files: draftFiles,
        validationStatus: draftStatus,
        summary,
        source: draftSource,
        diagnostics: draftDiagnostics,
      });

      return {
        files: draftFiles,
        manifest: draftManifest,
        source: draftSource,
        diagnostics: draftDiagnostics,
      };
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 6: TITLE & RESPONSE TEXT HELPERS (Auxiliary AI Calls)
    // Architectural Note: Auxiliary metadata (fragment title and summary text)
    // deliberately routes to lightweight gpt-4o-mini to avoid consuming flagship
    // token budget or adding latency for basic 10-word summaries, while the
    // customer's selected modelPreference strictly governed all core generative stages
    // (Planning, Design, Architecture, Coder, and QA Repair).
    // ─────────────────────────────────────────────────────────────────────────
    const auxStageStart = Date.now();
    const { fragmentTitle, responseText } = await step.run(
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

        await recordStageMetric({
          runId,
          projectId,
          stageName: "auxiliary-text",
          modelId: "gpt-4o-mini",
          startedAt: auxStageStart,
          finishedAt: Date.now(),
          promptTokens,
          completionTokens,
          details: {
            fragmentTitleGenerated: Boolean(title),
            responseGenerated: Boolean(respText),
          },
        });

        return {
          fragmentTitle: title,
          responseText: respText,
        };
      }
    );

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

      // Initialize checkpoint from the draft captured before QA
      let activeCheckpoint: SourceCheckpoint = {
        files: initialCheckpoint?.files || files || {},
        manifest: initialCheckpoint?.manifest || generateManifest(initialCheckpoint?.files || files || {}),
        source: initialCheckpoint?.source || "unverified-model-output-fallback",
        diagnostics: initialCheckpoint?.diagnostics,
      };

      let currentFiles = { ...(activeCheckpoint.files) };
      let currentSummary = summary;

      // Pass 1: Run comprehensive verification checks
      let report = await runQAInspector({
        files: currentFiles,
        summary: currentSummary,
        sandboxId,
        runSandboxCommands: true,
        archSpec,
        capabilities: prd.capabilities,
        deadlineMs,
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

CRITICAL REPAIR DIRECTIVES:
1. Targeted File Modifications: Modify ONLY the specific files reported with compiler errors. Do NOT rewrite unrelated code.
2. Foundation Ownership Protection: Do NOT attempt to modify or overwrite foundation files (package.json, tsconfig.json, next.config.mjs, tailwind.config.ts, postcss.config.mjs, lib/db.ts, prisma/schema.prisma). They are deterministically owned and protected.
3. Client Component Type Safety: If TypeScript failed due to 'useState([])' inferring 'never[]' (e.g. in app/profile/page.tsx or app/orders/page.tsx), explicitly supply the model interface generic, e.g. 'useState<Order[]>([])', and ensure all accessed properties ('id', 'totalPrice', 'orderDate', 'status') match the interface.
4. Missing API Route Handlers: Ensure every API route exports standard HTTP methods (export async function GET/POST) and handles inputs/errors with proper HTTP status codes (200, 201, 400).
5. Conclude your response with an updated <task_summary>...</task_summary>.
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
            // QA itself is a durable step; tool callbacks must not register nested steps.
            stepPrefix: "qa-repair-1",
            model: repairModel,
            generationRunId: runId,
            deadlineMs,
            maxIterations: GENERATION_LIMITS.maxRepairIterations,
            tokenBudget: GENERATION_LIMITS.maxRunTokenBudget,
          });
          currentFiles = repairResult.files;
          currentSummary = repairResult.summary;

          const repairWithBarrel = synthesizeComponentsBarrel(currentFiles || {});
          if (repairWithBarrel["components/index.ts"] && !currentFiles?.["components/index.ts"]) {
            try {
              const sandbox = await Sandbox.connect(sandboxId);
              await writeWorkspaceFiles(sandbox, {
                "components/index.ts": repairWithBarrel["components/index.ts"],
              });
              currentFiles["components/index.ts"] = repairWithBarrel["components/index.ts"];
            } catch {
              // Non-fatal
            }
          }

          // Capture actual sandbox files after repair modifications and update persisted draft
          let repairFiles = currentFiles;
          let repairManifest = generateManifest(currentFiles);
          let repairSource = "canonical-repair-sandbox-snapshot";
          let repairDiagnostics: Record<string, unknown> | undefined = undefined;

          try {
            const repairSnapshot = await captureSandboxSnapshot(sandboxId);
            if (repairSnapshot.files && Object.keys(repairSnapshot.files).length > 0) {
              repairFiles = repairSnapshot.files;
              repairManifest = repairSnapshot.manifest;
              repairDiagnostics = {
                provenance: "canonical-repair-sandbox-snapshot",
                fileCount: Object.keys(repairFiles).length,
                durationMs: repairSnapshot.diagnostics?.durationMs,
                totalBytes: repairSnapshot.diagnostics?.totalBytes,
              };
            } else {
              throw new Error("Repair sandbox snapshot returned zero files");
            }
          } catch (repairSnapErr) {
            const snapErrMsg = repairSnapErr instanceof Error ? repairSnapErr.message : String(repairSnapErr);
            const sanitizedCurrent = currentFiles && typeof currentFiles === "object" ? sanitizeProjectFiles(currentFiles) : {};
            if (Object.keys(sanitizedCurrent).length > 0) {
              repairFiles = sanitizedCurrent;
              repairManifest = generateManifest(sanitizedCurrent);
              repairSource = "unverified-repair-output-fallback";
              repairDiagnostics = {
                warning: "Repair filesystem snapshot capture failed; fell back to model repair memory state",
                snapshotError: snapErrMsg,
                provenance: "unverified-repair-output-fallback",
              };
            } else {
              repairFiles = {};
              repairManifest = generateManifest({});
              repairSource = "failed-repair-generation";
              repairDiagnostics = {
                error: "Repair stage produced no files and snapshot failed",
                snapshotError: snapErrMsg,
              };
            }
          }

          // Invalidate previous checkpoint with post-repair state
          activeCheckpoint = {
            files: repairFiles,
            manifest: repairManifest,
            source: repairSource,
            diagnostics: repairDiagnostics,
          };
          currentFiles = repairFiles;

          await upsertGenerationDraft({
            generationRunId: runId,
            projectId,
            files: currentFiles,
            validationStatus: DraftValidationStatus.VALIDATING,
            summary: currentSummary,
            source: repairSource,
            diagnostics: repairDiagnostics,
          });

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
            deadlineMs,
          });
        } catch (repairErr) {
          if (
            repairErr instanceof GenerationTimeoutError ||
            repairErr instanceof RunAbortedError ||
            repairErr instanceof TokenBudgetExceededError
          ) {
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

      // Validated Source-Checkpoint Contract:
      // When QA passes, promote the verified checkpoint (captured pre-QA or refreshed during repair)
      // without a redundant second full filesystem scan that could fail due to transient transport drops.
      // Strictly reject model-memory fallback or unverified snapshots from promotion.
      let finalFiles = activeCheckpoint.files;
      let finalSnapshotVerified = false;

      if (report.passed) {
        const isCanonical =
          activeCheckpoint.source === "canonical-sandbox-snapshot" ||
          activeCheckpoint.source === "canonical-repair-sandbox-snapshot";
        const hasFiles = Object.keys(activeCheckpoint.files).length > 0;
        const hasEntrypoint = Boolean(
          activeCheckpoint.files["app/page.tsx"] ||
          activeCheckpoint.files["src/app/page.tsx"] ||
          activeCheckpoint.files["pages/index.tsx"] ||
          activeCheckpoint.files["page.tsx"]
        );

        if (isCanonical && hasFiles && hasEntrypoint) {
          finalFiles = activeCheckpoint.files;
          finalSnapshotVerified = true;
          await recordRunEvent(
            runId,
            "VALIDATING",
            "QA Agent",
            `Source checkpoint verified directly (${Object.keys(finalFiles).length} files, provenance: ${activeCheckpoint.source})`
          );

          // Update persisted draft validation status to PASSED
          await upsertGenerationDraft({
            generationRunId: runId,
            projectId,
            files: finalFiles,
            validationStatus: DraftValidationStatus.PASSED,
            summary: currentSummary,
            source: activeCheckpoint.source,
            diagnostics: {
              ...activeCheckpoint.diagnostics,
              validatedAt: new Date().toISOString(),
              qaScore: report.score,
            },
          });
        } else {
          // Reject promotion of unverified fallback or corrupt checkpoint
          const rejectionReason = !isCanonical
            ? `Checkpoint provenance is '${activeCheckpoint.source}', which is an unverified fallback. Verified V1 requires authoritative sandbox filesystem capture.`
            : !hasFiles
            ? "Checkpoint contains zero files"
            : "Checkpoint missing required Next.js entrypoint (app/page.tsx)";

          console.error("[QA Checkpoint] Promotion rejected:", rejectionReason);
          report = {
            ...report,
            passed: false,
            score: Math.min(report.score, 50),
            repairNeeded: false,
            repairInstructions: `Validated source-checkpoint contract rejected: ${rejectionReason}`,
          };
          finalSnapshotVerified = false;
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

      return { report, finalFiles, finalSummary: currentSummary, finalSnapshotVerified };
    });

    const { report: qaReport, finalFiles, finalSummary, finalSnapshotVerified } = qaResult;

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 8: PERSISTENCE & PREVIEW (Executed strictly when QA verification succeeds)
    // ─────────────────────────────────────────────────────────────────────────
    if (!qaReport.passed || qaReport.verificationMode === "static-only" || !finalSnapshotVerified) {
      const failureReason = !finalSnapshotVerified
        ? (qaReport.repairInstructions || "Final verified filesystem snapshot could not be captured from live sandbox")
        : qaReport.verificationMode === "static-only"
        ? "Static-only validation is not permitted for verified builds. Live sandbox verification required."
        : (qaReport.repairInstructions || "Validation checks failed");

      const errorCode = qaReport.isInfrastructureTimeout
        ? "INFRASTRUCTURE_TIMEOUT"
        : "QA_VERIFICATION_FAILED";

      const failResult = await step.run("save-result", async () => {
        const saveStageStart = Date.now();
        const res = await finalizeGenerationFailure({
          projectId,
          generationRunId: runId,
          errorCode,
          errorMessage: failureReason,
        });

        await recordStageMetric({
          runId,
          projectId,
          stageName: "save-result",
          startedAt: saveStageStart,
          finishedAt: Date.now(),
          details: { passed: false, errorCode },
        });

        await aggregateAndPersistRunMetrics(runId, projectId, "FAILED");
        return res;
      });

      return {
        status: "FAILED" as const,
        error: failureReason,
        priorRevisionPreserved: true,
        messageId: failResult.messageId,
      };
    }

    // QA passed: start preview server and finalize project revision
    const finalizationResult = await step.run("save-result", async () => {
      const saveStageStart = Date.now();
      let sandboxUrl = "";
      try {
        const sandbox = await connectSandbox(sandboxId);
        await ensureSandboxPreviewServer(sandbox);
        sandboxUrl = `http://${sandbox.getHost(3000)}`;
      } catch (previewErr) {
        const msg = previewErr instanceof Error ? previewErr.message : String(previewErr);
        console.error("[save-result] Preview server startup failed:", msg);
        const failResult = await finalizeGenerationFailure({
          projectId,
          generationRunId: runId,
          errorCode: "PREVIEW_SERVER_FAILED",
          errorMessage: `Preview server failed to start: ${msg}`,
        });

        await recordStageMetric({
          runId,
          projectId,
          stageName: "save-result",
          startedAt: saveStageStart,
          finishedAt: Date.now(),
          details: { passed: false, errorCode: "PREVIEW_SERVER_FAILED" },
        });

        await aggregateAndPersistRunMetrics(runId, projectId, "FAILED");
        return {
          failed: true as const,
          messageId: failResult.messageId,
          error: `Preview server failed to start: ${msg}`,
          sandboxUrl: "",
          successResult: null,
        };
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

      return {
        failed: false as const,
        sandboxUrl,
        successResult,
        messageId: successResult.messageId,
        error: null,
      };
    });

    if (finalizationResult.failed) {
      return {
        status: "FAILED" as const,
        error: finalizationResult.error || "Preview server failed to start",
        priorRevisionPreserved: true,
        messageId: finalizationResult.messageId,
      };
    }

    const { sandboxUrl, successResult } = finalizationResult;

    return {
      status: "COMPLETED" as const,
      url: sandboxUrl,
      title: fragmentTitle,
      files: finalFiles,
      summary: finalSummary,
      revisionId: successResult!.revision.id,
      revisionNumber: successResult!.revision.revisionNumber,
      messageId: successResult!.messageId,
    };
  }
);