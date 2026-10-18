import { prisma } from "@/lib/db";
import { inngest } from "@/features/inngest/client";
import { OutboxStatus } from "@/generated/prisma/client";

export interface GenerationEventPayload {
  runId: string;
  projectId: string;
  prompt: string;
  baseRevisionId: string | null;
}

/**
 * Dispatches an outbox event to Inngest reliably with error tracking and idempotency.
 */
export async function dispatchOutboxEvent(eventId: string) {
  const event = await prisma.outboxEvent.findUnique({
    where: { id: eventId },
  });

  if (!event || event.status === OutboxStatus.PROCESSED) {
    return { dispatched: false, reason: "Already processed or missing" };
  }

  // Mark processing
  await prisma.outboxEvent.update({
    where: { id: eventId },
    data: {
      status: OutboxStatus.PROCESSING,
      attempts: { increment: 1 },
    },
  });

  try {
    const payload = event.payload as unknown as GenerationEventPayload;

    await inngest.send({
      name: "code-agent/run",
      id: `run-${payload.runId}`, // Inngest-level idempotency key
      data: {
        runId: payload.runId,
        projectId: payload.projectId,
        value: payload.prompt,
        baseRevisionId: payload.baseRevisionId,
      },
    });

    await prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: OutboxStatus.PROCESSED,
        processedAt: new Date(),
        lastError: null,
      },
    });

    return { dispatched: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    await prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: OutboxStatus.FAILED,
        lastError: errorMessage,
      },
    });

    console.error(`[Outbox] Failed to dispatch event ${eventId}:`, errorMessage);
    return { dispatched: false, error: errorMessage };
  }
}
