import { prisma } from "@/lib/db";
import { inngest } from "@/features/inngest/client";
import { OutboxStatus, OutboxEvent } from "@/generated/prisma/client";

export interface GenerationEventPayload {
  runId: string;
  projectId: string;
  prompt: string;
  baseRevisionId: string | null;
  modelPreference?: string;
}

export const MAX_OUTBOX_ATTEMPTS = 5;
export const OUTBOX_LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes lease
export const BASE_RETRY_DELAY_MS = 10 * 1000; // 10 seconds
export const MAX_RETRY_DELAY_MS = 300 * 1000; // 5 minutes

export interface ClaimOptions {
  eventId?: string;
  batchSize?: number;
  leaseDurationMs?: number;
}

/**
 * Shared atomic claiming engine for all dispatchers (initial dispatch & scheduled recovery).
 * Uses PostgreSQL `FOR UPDATE SKIP LOCKED` to atomically lease eligible outbox events.
 * Prevents double-claiming, enforces retry backoff, and reclaims abandoned leases.
 */
export async function claimOutboxEvents(options: ClaimOptions = {}): Promise<OutboxEvent[]> {
  const {
    eventId,
    batchSize = 20,
    leaseDurationMs = OUTBOX_LEASE_DURATION_MS,
  } = options;

  const leaseCutoff = new Date(Date.now() - leaseDurationMs);

  const claimed = await prisma.$queryRawUnsafe<OutboxEvent[]>(
    `UPDATE "OutboxEvent"
SET 
  status = 'PROCESSING',
  attempts = attempts + 1,
  "claimedAt" = NOW(),
  "claimToken" = gen_random_uuid()::text
WHERE id IN (
  SELECT id FROM "OutboxEvent"
  WHERE 
    ($1::text IS NULL OR id = $1)
    AND attempts < $2
    AND (
      -- 1. Ready PENDING events (new or ready for retry)
      (status = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
      OR
      -- 2. Ready FAILED events (retry delay elapsed)
      (status = 'FAILED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
      OR
      -- 3. Stale/abandoned PROCESSING events whose lease has expired
      (status = 'PROCESSING' AND ("claimedAt" IS NULL OR "claimedAt" <= $3))
    )
  ORDER BY "createdAt" ASC
  LIMIT $4
  FOR UPDATE SKIP LOCKED
)
RETURNING *;`,
    eventId ?? null,
    MAX_OUTBOX_ATTEMPTS,
    leaseCutoff,
    batchSize
  );

  return claimed ?? [];
}

/**
 * Dispatches a claimed event to Inngest and updates status with lease fencing tokens.
 */
export async function executeClaimedEvent(
  event: OutboxEvent
): Promise<{ success: boolean; error?: string }> {
  const claimToken = event.claimToken;

  try {
    const payload = (
      typeof event.payload === "string"
        ? JSON.parse(event.payload)
        : event.payload
    ) as GenerationEventPayload;

    if (!payload?.runId) {
      throw new Error(`Invalid outbox event payload: missing runId`);
    }

    // Idempotent dispatch via Inngest event ID keyed on generation runId
    await inngest.send({
      name: "code-agent/run",
      id: `run-${payload.runId}`,
      data: {
        runId: payload.runId,
        projectId: payload.projectId,
        value: payload.prompt,
        baseRevisionId: payload.baseRevisionId,
        modelPreference: payload.modelPreference,
      },
    });

    // Fencing token check: only mark PROCESSED if our unique claimToken was not stolen/reclaimed
    await prisma.$queryRawUnsafe(
      `UPDATE "OutboxEvent"
SET 
  status = 'PROCESSED',
  "processedAt" = NOW(),
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "lastError" = NULL
WHERE id = $1 AND status = 'PROCESSING' AND ($2::text IS NULL OR "claimToken" = $2);`,
      event.id,
      claimToken
    );

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Exponential retry backoff calculation based on previous attempts
    const isExhausted = event.attempts >= MAX_OUTBOX_ATTEMPTS;
    const delayMs = Math.min(
      BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, event.attempts - 1)),
      MAX_RETRY_DELAY_MS
    );
    const nextAttemptAt = isExhausted ? null : new Date(Date.now() + delayMs);

    await prisma.$queryRawUnsafe(
      `UPDATE "OutboxEvent"
SET 
  status = 'FAILED',
  "nextAttemptAt" = $2,
  "claimedAt" = NULL,
  "claimToken" = NULL,
  "lastError" = $3
WHERE id = $1 AND status = 'PROCESSING' AND ($4::text IS NULL OR "claimToken" = $4);`,
      event.id,
      nextAttemptAt,
      isExhausted ? `Terminal failure (max ${MAX_OUTBOX_ATTEMPTS} attempts exhausted): ${errorMessage}` : errorMessage,
      claimToken
    );

    console.error(`[Outbox] Dispatch failed for event ${event.id}:`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Initial dispatcher: Atomically claims the event before sending to Inngest.
 * Shares the exact same claiming engine as the scheduled recovery worker.
 */
export async function dispatchOutboxEvent(eventId: string) {
  const claimed = await claimOutboxEvents({ eventId, batchSize: 1 });

  if (claimed.length === 0) {
    // Check why it was not claimed (already processed, already leased, or exhausted)
    const existing = await prisma.outboxEvent.findUnique({
      where: { id: eventId },
    });

    if (!existing) {
      return { dispatched: false, reason: "Event not found" };
    }
    if (existing.status === OutboxStatus.PROCESSED) {
      return { dispatched: false, reason: "Already processed" };
    }
    if (existing.attempts >= MAX_OUTBOX_ATTEMPTS) {
      return { dispatched: false, reason: "Max attempts exceeded" };
    }
    return { dispatched: false, reason: "Event currently locked by another worker or waiting for retry backoff" };
  }

  const result = await executeClaimedEvent(claimed[0]);
  return { dispatched: result.success, error: result.error };
}

/**
 * Scheduled recovery worker: Atomically claims a batch of ready/abandoned events
 * and executes dispatch with exponential backoff and fencing tokens.
 */
export async function recoverStaleOutboxEvents(
  leaseDurationMs: number = OUTBOX_LEASE_DURATION_MS,
  batchSize: number = 20
) {
  const claimedEvents = await claimOutboxEvents({
    batchSize,
    leaseDurationMs,
  });

  let recovered = 0;
  let failed = 0;

  for (const event of claimedEvents) {
    const result = await executeClaimedEvent(event);
    if (result.success) {
      recovered++;
    } else {
      failed++;
    }
  }

  return { total: claimedEvents.length, recovered, failed };
}
