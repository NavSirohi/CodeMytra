"use server";

import { getCurrentUser, getAuthSessionState } from "@/features/auth/actions";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";
import { generateSlug } from "random-word-slugs";
import { prisma } from "@/lib/db";
import { dispatchOutboxEvent } from "@/server/orchestration/outbox";
import { restoreHistoricalRevision } from "@/server/orchestration/revisions";
import { finalizeGenerationFailure } from "@/server/orchestration/finalization";
import { GENERATION_LIMITS } from "@/server/orchestration/stage-optimizer";
import {
  ModelPreference,
  isValidModelPreference,
  AVAILABLE_MODEL_IDS,
} from "@/lib/models";

export interface CreateProjectInput {
  value: string;
  idempotencyKey?: string;
  modelPreference?: string;
}

export const createProject = async (
  inputOrValue: string | CreateProjectInput,
  legacyIdempotencyKey?: string,
  legacyModelPreference?: string
) => {
  const session = await getAuthSessionState();

  if (session.status !== "authenticated" || !session.user) {
    return {
      error: "Unauthorized",
    };
  }

  const user = session.user;

  const value =
    typeof inputOrValue === "object" && inputOrValue !== null
      ? inputOrValue.value
      : inputOrValue;
  const idempotencyKey =
    typeof inputOrValue === "object" && inputOrValue !== null
      ? inputOrValue.idempotencyKey
      : legacyIdempotencyKey;
  const rawModelPreference =
    typeof inputOrValue === "object" && inputOrValue !== null
      ? inputOrValue.modelPreference
      : legacyModelPreference;

  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < 3) {
    return {
      error: "Prompt must be at least 3 characters long",
    };
  }
  if (trimmed.length > 4000) {
    return {
      error: "Prompt exceeds maximum length of 4000 characters",
    };
  }

  // Validate model selection server-side
  let modelPreference: ModelPreference = "auto";
  if (
    rawModelPreference !== undefined &&
    rawModelPreference !== null &&
    rawModelPreference !== ""
  ) {
    if (!isValidModelPreference(rawModelPreference)) {
      return {
        error: `Invalid model selection "${rawModelPreference}". Supported models are: ${AVAILABLE_MODEL_IDS.join(", ")}`,
      };
    }
    modelPreference = rawModelPreference;
  }

  const cleanKey = idempotencyKey?.trim() || null;

  // Helper to fetch existing project and verify canonical prompt binding
  const findExistingWithPromptCheck = async (key: string) => {
    const existing = await prisma.project.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: user.id,
          idempotencyKey: key,
        },
      },
      include: {
        generationRuns: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { prompt: true },
        },
        messages: {
          where: { role: MessageRole.USER },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { content: true },
        },
      },
    });

    if (!existing) return null;

    // Compare canonicalized prompt
    const existingPrompt =
      existing.generationRuns?.[0]?.prompt?.trim() ??
      existing.messages?.[0]?.content?.trim();

    if (existingPrompt !== undefined && existingPrompt !== trimmed) {
      return {
        conflict: true as const,
        error: "Idempotency conflict: key already used with different prompt",
      };
    }

    const { id, name, userId, idempotencyKey, currentRevisionId, createdAt, updatedAt } = existing;
    return {
      conflict: false as const,
      project: { id, name, userId, idempotencyKey, currentRevisionId, createdAt, updatedAt },
    };
  };

  // 1. If an idempotency key is provided, check for existing project for this user
  if (cleanKey) {
    try {
      const match = await findExistingWithPromptCheck(cleanKey);
      if (match) {
        if (match.conflict) {
          return { error: match.error };
        }
        return match.project;
      }
    } catch (dbErr) {
      console.error("❌ Failed to verify existing idempotency record:", dbErr);
      return {
        error: "Database error during idempotency verification. Please try again.",
      };
    }
  }

  try {
    const { project, outboxEvent } = await prisma.$transaction(async (tx) => {
      const newProject = await tx.project.create({
        data: {
          name: generateSlug(2, { format: "kebab" }),
          userId: user.id,
          idempotencyKey: cleanKey,
          messages: {
            create: {
              content: trimmed,
              role: MessageRole.USER,
              type: MessageType.RESULT,
            },
          },
        },
      });

      const run = await tx.generationRun.create({
        data: {
          projectId: newProject.id,
          userId: user.id,
          prompt: trimmed,
          status: GenerationRunStatus.QUEUED,
          baseRevisionId: null,
        },
      });

      const event = await tx.outboxEvent.create({
        data: {
          eventName: "code-agent/run",
          payload: {
            runId: run.id,
            projectId: newProject.id,
            prompt: trimmed,
            baseRevisionId: null,
            modelPreference,
          },
        },
      });

      if (tx.runEvent?.create) {
        await tx.runEvent.create({
          data: {
            runId: run.id,
            stage: "QUEUED",
            agentRole: "Orchestrator",
            message: `Generation queued with model selection: ${modelPreference}`,
            payload: { modelPreference },
          },
        });
      }

      return { project: newProject, outboxEvent: event };
    });

    // Fire outbox dispatch
    await dispatchOutboxEvent(outboxEvent.id);

    return project;
  } catch (error: unknown) {
    // 2. Handle concurrent duplicate submission race condition:
    // If a unique constraint violation occurs on userId_idempotencyKey, return the already created project
    const err = error as { code?: string; message?: string; meta?: { target?: string[] } };
    if (
      cleanKey &&
      (err?.code === "P2002" ||
        err?.message?.includes("unique") ||
        err?.code === "23505" ||
        err?.meta?.target?.includes("idempotencyKey"))
    ) {
      try {
        const match = await findExistingWithPromptCheck(cleanKey);
        if (match) {
          if (match.conflict) {
            return { error: match.error };
          }
          return match.project;
        }
      } catch (lookupErr) {
        console.error("❌ Error fetching existing project after race condition:", lookupErr);
      }
    }

    console.error("❌ Error creating project:", error);
    return {
      error: "Failed to create project",
    };
  }
};

export const getProjects = async () => {
  const user = await getCurrentUser();

  if (!user) {
    return {
      error: "Unauthorized",
    };
  }

  try {
    const projects = await prisma.project.findMany({
      where: {
        userId: user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return projects;
  } catch (error) {
    console.error("❌ Error getting projects:", error);
    return {
      error: "Failed to get projects",
    };
  }
};

export const getProjectById = async (id: string) => {
  const user = await getCurrentUser();

  if (!user) {
    return {
      error: "Unauthorized",
    };
  }

  try {
    const project = await prisma.project.findUnique({
      where: {
        id,
        userId: user.id,
      },
      include: {
        messages: true,
        currentRevision: true,
      },
    });

    if (!project) {
      return {
        error: "Project not found",
      };
    }

    return project;
  } catch (error) {
    console.error("❌ Error getting project by id:", error);
    return {
      error: "Failed to get project by id",
    };
  }
};

/**
 * Get all immutable revisions for a project.
 */
export const getProjectRevisions = async (projectId: string) => {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  // Ownership verification
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId: user.id },
  });

  if (!project) {
    throw new Error("Project not found or unauthorized");
  }

  return prisma.projectRevision.findMany({
    where: { projectId },
    orderBy: { revisionNumber: "desc" },
    select: {
      id: true,
      revisionNumber: true,
      title: true,
      summary: true,
      createdAt: true,
      generationRunId: true,
      parentRevisionId: true,
      manifest: true,
      files: true,
    },
  });
};

/**
 * Restore a historical revision as a new active revision.
 */
export const restoreProjectRevision = async (projectId: string, revisionId: string) => {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  return restoreHistoricalRevision(projectId, revisionId, user.id);
};

/**
 * Fetch the active generation run for a project (to display status in UI).
 */
export const getActiveGenerationRun = async (projectId: string) => {
  const user = await getCurrentUser();

  if (!user) {
    return null;
  }

  const run = await prisma.generationRun.findFirst({
    where: {
      projectId,
      userId: user.id,
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!run) {
    return null;
  }

  // Active status set
  const activeStatuses: GenerationRunStatus[] = [
    GenerationRunStatus.QUEUED,
    GenerationRunStatus.PLANNING,
    GenerationRunStatus.AWAITING_APPROVAL,
    GenerationRunStatus.DESIGNING,
    GenerationRunStatus.ARCHITECTING,
    GenerationRunStatus.RUNNING,
    GenerationRunStatus.VALIDATING,
  ];

  // If a run is in an active status but has exceeded the maximum duration budget + grace period,
  // it has been abandoned by an unrecoverable failure (e.g., worker crash, network partition).
  // Automatically reconcile the run to FAILED so no project remains permanently RUNNING.
  const STALE_RUN_GRACE_PERIOD_MS = 60 * 1000;
  const isStale =
    activeStatuses.includes(run.status) &&
    Date.now() - run.createdAt.getTime() >
      GENERATION_LIMITS.maxGenerationDurationMs + STALE_RUN_GRACE_PERIOD_MS;

  if (isStale) {
    try {
      await finalizeGenerationFailure({
        projectId,
        generationRunId: run.id,
        errorCode: "WORKFLOW_TIMED_OUT",
        errorMessage:
          "Generation exceeded maximum duration and was reconciled to failed. Prior working revisions preserved.",
      });

      return await prisma.generationRun.findUnique({
        where: { id: run.id },
        include: {
          events: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
    } catch (reconcileErr) {
      console.error("[getActiveGenerationRun] Failed to reconcile stale run:", reconcileErr);
    }
  }

  return run;
};

/**
 * Retrieve the current PRD, DesignSpec, and ArchitectureSpec for a project.
 */
export const getProjectSpecification = async (projectId: string) => {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId, userId: user.id },
  });

  if (!project) {
    throw new Error("Project not found or unauthorized");
  }

  return prisma.projectSpecification.findUnique({
    where: { projectId },
  });
};

