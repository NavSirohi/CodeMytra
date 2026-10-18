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

  const project = await prisma.project.findUnique({
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

  const { newMessage, outboxEvent } = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        projectId,
        content: value,
        role: MessageRole.USER,
        type: MessageType.RESULT,
      },
    });

    const run = await tx.generationRun.create({
      data: {
        projectId,
        userId: user.id,
        prompt: value,
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
          prompt: value,
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
