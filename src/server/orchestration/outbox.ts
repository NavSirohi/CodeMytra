import { prisma } from "@/lib/db";
import { inngest } from "@/features/inngest/client";
import { OutboxStatus } from "@/generated/prisma/client";

export interface GenerationEventPayload {
  runId: string;
  projectId: string;
  prompt: string;
  baseRevisionId: string | null;
}

export const MAX_OUTBOX_ATTEMPTS = 5;

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

  if (event.attempts >= MAX_OUTBOX_ATTEMPTS) {
    await prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: OutboxStatus.FAILED,
        lastError: `Max outbox dispatch attempts (${MAX_OUTBOX_ATTEMPTS}) exceeded`,
      },
    });
    return { dispatched: false, reason: "Max attempts exceeded" };
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

/**
 * Finds and recovers stale or failed outbox events that have not exceeded MAX_OUTBOX_ATTEMPTS.
 */
export async function recoverStaleOutboxEvents(maxAgeMs: number = 60000) {
  const cutoff = new Date(Date.now() - maxAgeMs);

  const staleEvents = await prisma.outboxEvent.findMany({
    where: {
      OR: [
        { status: OutboxStatus.PENDING },
        {
          status: OutboxStatus.PROCESSING,
          createdAt: { lt: cutoff },
        },
        {
          status: OutboxStatus.FAILED,
          attempts: { lt: MAX_OUTBOX_ATTEMPTS },
        },
      ],
    },
    take: 20,
    orderBy: { createdAt: "asc" },
  });

  let recovered = 0;
  let failed = 0;

  for (const event of staleEvents) {
    const result = await dispatchOutboxEvent(event.id);
    if (result.dispatched) {
      recovered++;
    } else {
      failed++;
    }
  }

  return { total: staleEvents.length, recovered, failed };
}
