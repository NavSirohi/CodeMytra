import { prisma } from "@/lib/db";
import { GenerationRunStatus } from "@/generated/prisma/client";

/**
 * Valid state transitions for a GenerationRun in the Multi-Agent architecture.
 * Terminal states (COMPLETED, FAILED, CANCELLED) have no allowed transitions.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<GenerationRunStatus, readonly GenerationRunStatus[]> = {
  [GenerationRunStatus.QUEUED]: [
    GenerationRunStatus.PLANNING,
    GenerationRunStatus.RUNNING,
    GenerationRunStatus.CANCELLED,
    GenerationRunStatus.FAILED,
  ],
  [GenerationRunStatus.PLANNING]: [
    GenerationRunStatus.AWAITING_APPROVAL,
    GenerationRunStatus.DESIGNING,
    GenerationRunStatus.RUNNING,
    GenerationRunStatus.FAILED,
    GenerationRunStatus.CANCELLED,
  ],
  [GenerationRunStatus.AWAITING_APPROVAL]: [
    GenerationRunStatus.DESIGNING,
    GenerationRunStatus.ARCHITECTING,
    GenerationRunStatus.RUNNING,
    GenerationRunStatus.CANCELLED,
    GenerationRunStatus.FAILED,
  ],
  [GenerationRunStatus.DESIGNING]: [
    GenerationRunStatus.ARCHITECTING,
    GenerationRunStatus.RUNNING,
    GenerationRunStatus.FAILED,
    GenerationRunStatus.CANCELLED,
  ],
  [GenerationRunStatus.ARCHITECTING]: [
    GenerationRunStatus.RUNNING,
    GenerationRunStatus.FAILED,
    GenerationRunStatus.CANCELLED,
  ],
  [GenerationRunStatus.RUNNING]: [
    GenerationRunStatus.VALIDATING,
    GenerationRunStatus.FAILED,
    GenerationRunStatus.CANCELLED,
  ],
  [GenerationRunStatus.VALIDATING]: [
    GenerationRunStatus.COMPLETED,
    GenerationRunStatus.FAILED,
  ],
  [GenerationRunStatus.COMPLETED]: [],
  [GenerationRunStatus.FAILED]: [],
  [GenerationRunStatus.CANCELLED]: [],
};

export function isValidTransition(
  currentStatus: GenerationRunStatus,
  targetStatus: GenerationRunStatus
): boolean {
  const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(targetStatus) : false;
}

export function isTerminalStatus(status: GenerationRunStatus): boolean {
  return (
    status === GenerationRunStatus.COMPLETED ||
    status === GenerationRunStatus.FAILED ||
    status === GenerationRunStatus.CANCELLED
  );
}

export interface TransitionOptions {
  errorCode?: string;
  errorMessage?: string;
  resultRevisionId?: string;
}

/**
 * Atomically transitions a GenerationRun to a new status.
 * Rejects illegal or stale transitions to prevent race conditions from delayed workers.
 */
export async function transitionRun(
  runId: string,
  targetStatus: GenerationRunStatus,
  options: TransitionOptions = {}
) {
  const currentRun = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });

  if (!currentRun) {
    throw new Error(`Generation run ${runId} not found`);
  }

  if (currentRun.status === targetStatus) {
    return { success: true, status: targetStatus, noop: true };
  }

  if (!isValidTransition(currentRun.status, targetStatus)) {
    throw new Error(
      `Invalid generation run state transition from ${currentRun.status} to ${targetStatus}`
    );
  }

  const now = new Date();
  const updateData: Record<string, unknown> = {
    status: targetStatus,
  };

  if (targetStatus === GenerationRunStatus.RUNNING || targetStatus === GenerationRunStatus.PLANNING) {
    updateData.startedAt = now;
  } else if (isTerminalStatus(targetStatus)) {
    updateData.completedAt = now;
  }

  if (options.errorCode !== undefined) {
    updateData.errorCode = options.errorCode;
  }
  if (options.errorMessage !== undefined) {
    updateData.errorMessage = options.errorMessage;
  }
  if (options.resultRevisionId !== undefined) {
    updateData.resultRevisionId = options.resultRevisionId;
  }

  const updated = await prisma.generationRun.update({
    where: {
      id: runId,
      status: currentRun.status, // Optimistic concurrency check
    },
    data: updateData,
  });

  return { success: true, run: updated };
}
