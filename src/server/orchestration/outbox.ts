import { prisma } from "@/lib/db";
import { inngest } from "@/features/inngest/client";
import { OutboxStatus, OutboxEvent } from "@/generated/prisma/client";

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
 * Atomically claims and recovers stale or failed outbox events using FOR UPDATE SKIP LOCKED
 * with exponential backoff and stale-event reconciliation.
 */
export async function recoverStaleOutboxEvents(
  maxAgeMs: number = 300000,
  batchSize: number = 20,
  baseDelaySeconds: number = 10
) {
  const cutoff = new Date(Date.now() - maxAgeMs);

  const claimedEvents = (await prisma.$queryRawUnsafe<OutboxEvent[]>(
    `UPDATE "OutboxEvent"
SET status = 'PROCESSING', attempts = attempts + 1
WHERE id IN (
  SELECT id FROM "OutboxEvent"
  WHERE (
    status = 'PENDING'
    OR (status = 'PROCESSING' AND "createdAt" < $1)
    OR (status = 'FAILED' AND attempts < $2)
  )
  AND NOW() > "createdAt" + (interval '1 second' * power(2, attempts) * ($3::numeric))
  ORDER BY "createdAt" ASC
  LIMIT $4
  FOR UPDATE SKIP LOCKED
)
RETURNING *`,
    cutoff,
    MAX_OUTBOX_ATTEMPTS,
    baseDelaySeconds,
    batchSize
  )) ?? [];

  let recovered = 0;
  let failed = 0;

  for (const event of claimedEvents) {
    try {
      const payload = (
        typeof event.payload === "string"
          ? JSON.parse(event.payload)
          : event.payload
      ) as GenerationEventPayload;

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
        where: { id: event.id },
        data: {
          status: OutboxStatus.PROCESSED,
          processedAt: new Date(),
          lastError: null,
        },
      });

      recovered++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OutboxStatus.FAILED,
          lastError: errorMessage,
        },
      });

      console.error(`[Outbox] Failed to recover event ${event.id}:`, errorMessage);
      failed++;
    }
  }

  return { total: claimedEvents.length, recovered, failed };
}

