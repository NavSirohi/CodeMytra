"use server";

import { getCurrentUser } from "@/features/auth/actions";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";
import { generateSlug } from "random-word-slugs";
import { prisma } from "@/lib/db";
import { dispatchOutboxEvent } from "@/server/orchestration/outbox";
import { restoreHistoricalRevision } from "@/server/orchestration/revisions";

export const createProject = async (value: string) => {
  const user = await getCurrentUser();

  if (!user) {
    return {
      error: "Unauthorized",
    };
  }

  try {
    const { project, outboxEvent } = await prisma.$transaction(async (tx) => {
      const newProject = await tx.project.create({
        data: {
          name: generateSlug(2, { format: "kebab" }),
          userId: user.id,
          messages: {
            create: {
              content: value,
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
          prompt: value,
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
            prompt: value,
            baseRevisionId: null,
          },
        },
      });

      return { project: newProject, outboxEvent: event };
    });

    // Fire outbox dispatch
    await dispatchOutboxEvent(outboxEvent.id);

    return project;
  } catch (error) {
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
  });
};
