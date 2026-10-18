"use server";

import { getCurrentUser } from "@/features/auth/actions";
import { prisma } from "@/lib/db";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";
import { dispatchOutboxEvent } from "@/server/orchestration/outbox";

/**
 * Create a new user message in a project and kick off a durable agent run.
 *
 * Verifies the caller owns the target project, links the current base revision,
 * records the GenerationRun + OutboxEvent in an atomic transaction, then dispatches the run.
 *
 * @param value - The message content typed by the user.
 * @param projectId - The project the message belongs to.
 * @returns The newly created message record.
 * @throws If the user is unauthorized or the project is not found.
 */
export const createMessage = async (value: string, projectId: string) => {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  // 1. Server-side prompt validation
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < 3) {
    throw new Error("Prompt must be at least 3 characters long");
  }
  if (trimmed.length > 4000) {
    throw new Error("Prompt exceeds maximum length of 4000 characters");
  }

  // Database-level coordination: execute row lock and active run check atomically
  const { newMessage, outboxEvent } = await prisma.$transaction(async (tx) => {
    // 1. Lock project row to serialize concurrent generation requests for this project
    await tx.$queryRawUnsafe(`SELECT id FROM "Project" WHERE id = $1 FOR UPDATE`, projectId);

    // 2. Check project existence and ownership under lock
    const project = await tx.project.findUnique({
      where: {
        id: projectId,
        userId: user.id,
      },
      select: {
        id: true,
        currentRevisionId: true,
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    // 3. Concurrency check: Ensure no active run exists for this project
    const activeRun = await tx.generationRun.findFirst({
      where: {
        projectId,
        status: {
          in: [
            GenerationRunStatus.QUEUED,
            GenerationRunStatus.PLANNING,
            GenerationRunStatus.AWAITING_APPROVAL,
            GenerationRunStatus.DESIGNING,
            GenerationRunStatus.ARCHITECTING,
            GenerationRunStatus.RUNNING,
            GenerationRunStatus.VALIDATING,
          ],
        },
      },
    });

    if (activeRun) {
      throw new Error("A generation run is already in progress for this project. Please wait for it to complete.");
    }

    const message = await tx.message.create({
      data: {
        projectId,
        content: trimmed,
        role: MessageRole.USER,
        type: MessageType.RESULT,
      },
    });

    const run = await tx.generationRun.create({
      data: {
        projectId,
        userId: user.id,
        prompt: trimmed,
        status: GenerationRunStatus.QUEUED,
        baseRevisionId: project.currentRevisionId,
      },
    });

    const event = await tx.outboxEvent.create({
      data: {
        eventName: "code-agent/run",
        payload: {
          runId: run.id,
          projectId,
          prompt: trimmed,
          baseRevisionId: project.currentRevisionId,
        },
      },
    });

    return { newMessage: message, outboxEvent: event };
  });

  // Dispatch via outbox
  await dispatchOutboxEvent(outboxEvent.id);

  return newMessage;
};

/**
 * List all messages for a project, oldest first, including their fragments.
 *
 * Ensures the signed-in user owns the project before returning anything.
 *
 * @param projectId - The project whose messages should be returned.
 * @returns The project's messages (with related fragments) ordered by `createdAt`.
 * @throws If the user is unauthorized or the project is not found.
 */
export const getMessages = async (projectId: string) => {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const project = await prisma.project.findUnique({
    where: {
      id: projectId,
      userId: user.id,
    },
  });

  if (!project) {
    throw new Error("Project not found or unauthorized");
  }

  return prisma.message.findMany({
    where: {
      projectId,
    },
    orderBy: {
      createdAt: "asc",
    },
    include: {
      fragments: true,
    },
  });
};
