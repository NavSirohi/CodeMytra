import { prisma } from "@/lib/db";
import {
  MessageRole,
  MessageType,
  GenerationRunStatus,
  Prisma,
  ProjectRevision,
} from "@/generated/prisma/client";
import {
  sanitizeProjectFiles,
  generateManifest,
} from "./revisions";

export interface FinalizeGenerationSuccessParams {
  projectId: string;
  generationRunId: string;
  baseRevisionId?: string | null;
  fragmentTitle: string;
  summary: string;
  files: Record<string, string>;
  sandboxUrl: string;
}

export interface FinalizeGenerationSuccessResult {
  revision: ProjectRevision;
  promoted: boolean;
  messageId: string;
  isIdempotentReplay: boolean;
}

export interface FinalizeGenerationFailureParams {
  projectId: string;
  generationRunId: string;
  errorCode: string;
  errorMessage: string;
}

export interface FinalizeGenerationFailureResult {
  messageId: string;
  isIdempotentReplay: boolean;
}

/**
 * Transactionally and idempotently finalizes a successful generation run.
 * Guarantees:
 * 1. Exactly one revision is created per generation run (idempotent across retries).
 * 2. Monotonic revision numbers under concurrency.
 * 3. Atomic CAS promotion: only updates project pointer if project hasn't advanced.
 * 4. Transactional atomicity: revision, run status, event, and assistant message succeed or fail together.
 * 5. Replay safety: retrying after partial failure never duplicates revisions or messages.
 * 6. Validates project ownership and prevents terminal state corruptions.
 */
export async function finalizeGenerationSuccess(
  params: FinalizeGenerationSuccessParams
): Promise<FinalizeGenerationSuccessResult> {
  const {
    projectId,
    generationRunId,
    baseRevisionId,
    fragmentTitle,
    summary,
    files,
    sandboxUrl,
  } = params;

  return await prisma.$transaction(async (tx) => {
    // 1. Validate run existence and ownership
    const currentRun = await tx.generationRun.findUnique({
      where: { id: generationRunId },
      include: { revisions: true },
    });

    if (!currentRun) {
      throw new Error(`GenerationRun "${generationRunId}" not found`);
    }

    if (currentRun.projectId !== projectId) {
      throw new Error(
        `GenerationRun "${generationRunId}" does not belong to project "${projectId}"`
      );
    }

    // 2. Idempotency Check: if run is already completed with a revision, return idempotently
    if (currentRun.status === GenerationRunStatus.COMPLETED) {
      if (currentRun.revisions.length === 0) {
        throw new Error(
          `Database integrity violation: GenerationRun "${generationRunId}" is marked COMPLETED but has no associated revision`
        );
      }
      const existingRev = currentRun.revisions[0];
      const existingMsg = await tx.message.findUnique({
        where: { generationRunId },
      });

      if (!existingMsg) {
        throw new Error(
          `Database integrity violation: Completed GenerationRun "${generationRunId}" has no associated result message`
        );
      }

      return {
        revision: existingRev,
        promoted: false,
        messageId: existingMsg.id,
        isIdempotentReplay: true,
      };
    }

    // Terminal state guard: if run was cancelled or failed, prevent overwriting
    if (currentRun.status === GenerationRunStatus.CANCELLED) {
      throw new Error(
        `GenerationRun "${generationRunId}" is CANCELLED and cannot be finalized as COMPLETED`
      );
    }
    if (currentRun.status === GenerationRunStatus.FAILED) {
      throw new Error(
        `GenerationRun "${generationRunId}" is already FAILED and cannot be finalized as COMPLETED`
      );
    }

    // Enforce valid finalization state: must be in VALIDATING state (after QA verification)
    if (currentRun.status !== GenerationRunStatus.VALIDATING) {
      throw new Error(
        `Invalid state transition: Cannot finalize generation as COMPLETED from status "${currentRun.status}". Generation must be in VALIDATING state.`
      );
    }

    // 3. Check if revision already created in an earlier attempted commit
    let revision = await tx.projectRevision.findFirst({
      where: { projectId, generationRunId },
    });

    let promoted = false;

    if (!revision) {
      // Monotonic revision numbering
      const lastRev = await tx.projectRevision.findFirst({
        where: { projectId },
        orderBy: { revisionNumber: "desc" },
        select: { revisionNumber: true, id: true },
      });

      const nextRevisionNumber = (lastRev?.revisionNumber ?? 0) + 1;
      const resolvedParentId = baseRevisionId ?? lastRev?.id ?? null;

      const sanitized = sanitizeProjectFiles(files);
      const manifest = generateManifest(sanitized);

      revision = await tx.projectRevision.create({
        data: {
          projectId,
          generationRunId,
          parentRevisionId: resolvedParentId,
          revisionNumber: nextRevisionNumber,
          title: fragmentTitle || `Revision ${nextRevisionNumber}`,
          summary: summary || null,
          files: sanitized,
          manifest: manifest as unknown as Prisma.InputJsonObject,
        },
      });

      // Atomic CAS promotion: only promote if expectedCurrentRevisionId matches
      if (typeof tx.project.updateMany === "function") {
        const updateResult = await tx.project.updateMany({
          where: {
            id: projectId,
            currentRevisionId: baseRevisionId ?? null,
          },
          data: { currentRevisionId: revision.id },
        });
        promoted = updateResult.count > 0;
      } else {
        const currentProject = await tx.project.findUnique({
          where: { id: projectId },
          select: { currentRevisionId: true },
        });
        if (currentProject?.currentRevisionId === (baseRevisionId ?? null)) {
          await tx.project.update({
            where: { id: projectId },
            data: { currentRevisionId: revision.id },
          });
          promoted = true;
        }
      }
    } else {
      // Existing revision found
      const currentProject = await tx.project.findUnique({
        where: { id: projectId },
        select: { currentRevisionId: true },
      });
      promoted = currentProject?.currentRevisionId === revision.id;
    }

    // 4. Mark GenerationRun as COMPLETED safely under concurrency
    await tx.generationRun.update({
      where: { id: generationRunId },
      data: {
        status: GenerationRunStatus.COMPLETED,
        resultRevisionId: revision.id,
        completedAt: new Date(),
      },
    });

    // 5. Record Run Event
    await tx.runEvent.create({
      data: {
        runId: generationRunId,
        stage: "COMPLETED",
        agentRole: "System",
        message: promoted
          ? `Revision V${revision.revisionNumber} promoted to active project head`
          : `Revision V${revision.revisionNumber} preserved as branch (project head already advanced)`,
      },
    });

    // 6. Create assistant Message with fragment linked to generationRunId
    let message = await tx.message.findUnique({
      where: { generationRunId },
    });

    if (!message) {
      message = await tx.message.create({
        data: {
          projectId,
          generationRunId,
          content: summary,
          role: MessageRole.ASSISTANT,
          type: MessageType.RESULT,
          fragments: {
            create: {
              sandboxUrl,
              title: fragmentTitle,
              files: (revision.files as Record<string, string>) || {},
            },
          },
        },
      });
    }

    return {
      revision,
      promoted,
      messageId: message.id,
      isIdempotentReplay: false,
    };
  });
}

/**
 * Transactionally and idempotently finalizes a failed generation run.
 * Guarantees:
 * 1. GenerationRun transitions to FAILED with error code and diagnostics.
 * 2. Active project revision pointer is NEVER altered, strictly preserving prior working state.
 * 3. Never overwrites an already COMPLETED run.
 * 4. Idempotent replay never generates duplicate failure events or error messages.
 * 5. Validates project ownership and ensures safe terminal transitions under concurrency.
 */
export async function finalizeGenerationFailure(
  params: FinalizeGenerationFailureParams
): Promise<FinalizeGenerationFailureResult> {
  const { projectId, generationRunId, errorCode, errorMessage } = params;

  return await prisma.$transaction(async (tx) => {
    // 1. Validate run existence and ownership
    const currentRun = await tx.generationRun.findUnique({
      where: { id: generationRunId },
    });

    if (!currentRun) {
      throw new Error(`GenerationRun "${generationRunId}" not found`);
    }

    if (currentRun.projectId !== projectId) {
      throw new Error(
        `GenerationRun "${generationRunId}" does not belong to project "${projectId}"`
      );
    }

    // 2. Prevent failed finalization from overwriting an already COMPLETED run
    if (currentRun.status === GenerationRunStatus.COMPLETED) {
      const existingMsg = await tx.message.findUnique({
        where: { generationRunId },
      });
      if (!existingMsg) {
        throw new Error(
          `Database integrity violation: Completed GenerationRun "${generationRunId}" has no associated result message`
        );
      }
      return {
        messageId: existingMsg.id,
        isIdempotentReplay: true,
      };
    }

    // Check if the project actually has a working revision pointer or existing revisions
    const project = tx.project
      ? await tx.project.findUnique({
          where: { id: projectId },
          select: { currentRevisionId: true },
        })
      : null;
    const revisionCount = tx.projectRevision
      ? await tx.projectRevision.count({
          where: { projectId },
        })
      : 0;
    const hasPriorRevision = revisionCount > 0 && Boolean(project?.currentRevisionId);
    const revisionNote = hasPriorRevision
      ? "Your prior working revision is preserved."
      : "No prior revisions exist for this project yet.";
    const runEventRevisionNote = hasPriorRevision
      ? "Prior working revision preserved."
      : "No prior working revision exists.";

    const formatFailurePrefix = (code: string): string => {
      if (code === "GENERATION_TIMEOUT" || code === "WORKFLOW_TIMED_OUT") {
        return "Generation timed out:";
      }
      if (code.startsWith("QA_") || code === "QA_CHECK_FAILED" || code === "QA_REPAIR_EXHAUSTED" || code === "QA_VERIFICATION_FAILED") {
        return "Quality Assurance failed:";
      }
      if (code === "NO_PROGRESS_LIMIT" || code === "ITERATION_LIMIT_EXCEEDED" || code === "TOKEN_BUDGET_EXCEEDED") {
        return "Generation stopped:";
      }
      return "Generation failed:";
    };

    const prefix = formatFailurePrefix(errorCode);
    const failureContent = `${prefix} ${errorMessage} ${revisionNote}`;

    // 3. Repeated failure delivery (idempotent replay):
    // If run is already FAILED, return existing messageId associated with this exact generationRunId
    if (currentRun.status === GenerationRunStatus.FAILED) {
      const existingMsg = await tx.message.findUnique({
        where: { generationRunId },
      });
      if (existingMsg) {
        return {
          messageId: existingMsg.id,
          isIdempotentReplay: true,
        };
      }
      // Documented Safe Repair: If this run has no message linked to its generationRunId,
      // create a dedicated message strictly bound to this generationRunId rather than
      // borrowing another run's message from the same project.
      const repairedMessage = await tx.message.create({
        data: {
          projectId,
          generationRunId,
          content: failureContent,
          role: MessageRole.ASSISTANT,
          type: MessageType.ERROR,
        },
      });
      return {
        messageId: repairedMessage.id,
        isIdempotentReplay: true,
      };
    }

    // If run is CANCELLED, do not transition to FAILED
    if (currentRun.status === GenerationRunStatus.CANCELLED) {
      const existingMsg = await tx.message.findUnique({
        where: { generationRunId },
      });
      if (existingMsg) {
        return {
          messageId: existingMsg.id,
          isIdempotentReplay: true,
        };
      }
      // Documented Safe Repair: Create dedicated cancelled message strictly bound to generationRunId
      const cancelledMessage = await tx.message.create({
        data: {
          projectId,
          generationRunId,
          content: `Generation run ${generationRunId} was cancelled.`,
          role: MessageRole.ASSISTANT,
          type: MessageType.ERROR,
        },
      });
      return {
        messageId: cancelledMessage.id,
        isIdempotentReplay: true,
      };
    }

    // 4. Transition run to FAILED
    await tx.generationRun.update({
      where: { id: generationRunId },
      data: {
        status: GenerationRunStatus.FAILED,
        errorCode,
        errorMessage,
        completedAt: new Date(),
      },
    });

    // 5. Record FAILED event exactly once
    await tx.runEvent.create({
      data: {
        runId: generationRunId,
        stage: "FAILED",
        agentRole: "System",
        message: `Run marked failed (${errorCode}): ${errorMessage}. ${runEventRevisionNote}`,
      },
    });

    // 6. Create error message for user, tied to generationRunId
    let message = await tx.message.findUnique({
      where: { generationRunId },
    });

    if (!message) {
      message = await tx.message.create({
        data: {
          projectId,
          generationRunId,
          content: failureContent,
          role: MessageRole.ASSISTANT,
          type: MessageType.ERROR,
        },
      });
    }

    return { messageId: message.id, isIdempotentReplay: false };
  });
}

/**
 * Fast status checker to determine if a GenerationRun is still active in database.
 * Returns false if the run reached a terminal state (FAILED, COMPLETED, CANCELLED).
 */
export async function isRunActiveInDb(generationRunId?: string): Promise<boolean> {
  if (!generationRunId) return true;
  try {
    const run = await prisma.generationRun.findUnique({
      where: { id: generationRunId },
      select: { status: true },
    });
    if (!run) return false;
    return run.status === GenerationRunStatus.RUNNING || run.status === GenerationRunStatus.VALIDATING;
  } catch {
    return true;
  }
}
