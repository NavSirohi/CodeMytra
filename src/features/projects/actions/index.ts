"use server";

import { getCurrentUser } from "@/features/auth/actions";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";
import { generateSlug } from "random-word-slugs";
import { prisma } from "@/lib/db";
import { dispatchOutboxEvent } from "@/server/orchestration/outbox";
import { restoreHistoricalRevision } from "@/server/orchestration/revisions";

export const createProject = async (value: string, idempotencyKey?: string) => {
  const user = await getCurrentUser();

  if (!user) {
    return {
      error: "Unauthorized",
    };
  }

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

  const cleanKey = idempotencyKey?.trim() || null;

  // 1. If an idempotency key is provided, check for existing project for this user
  if (cleanKey) {
    try {
      const existing = await prisma.project.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: user.id,
            idempotencyKey: cleanKey,
          },
        },
      });
      if (existing) {
        return existing;
      }
    } catch {
      // Continue to creation if lookup fails
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
          },
        },
      });

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
        const existing = await prisma.project.findUnique({
          where: {
            userId_idempotencyKey: {
              userId: user.id,
              idempotencyKey: cleanKey,
            },
          },
        });
        if (existing) {
          return existing;
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

  return prisma.generationRun.findFirst({
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

