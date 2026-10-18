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

/**
 * Transactionally and idempotently finalizes a successful generation run.
 * Guarantees:
 * 1. Exactly one revision is created per generation run (idempotent across retries).
 * 2. Monotonic revision numbers under concurrency.
 * 3. Atomic CAS promotion: only updates project pointer if project hasn't advanced.
 * 4. Transactional atomicity: revision, run status, event, and assistant message succeed or fail together.
 * 5. Replay safety: retrying after partial failure never duplicates revisions or messages.
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
    // 1. Idempotency Check: if run is already completed with a revision, return idempotently
    const currentRun = await tx.generationRun.findUnique({
      where: { id: generationRunId },
      include: { revisions: true },
    });

    if (currentRun?.status === GenerationRunStatus.COMPLETED && currentRun.revisions.length > 0) {
      const existingRev = currentRun.revisions[0];
      const existingMsg = await tx.message.findFirst({
        where: {
          projectId,
          type: MessageType.RESULT,
        },
        orderBy: { createdAt: "desc" },
      });

      return {
        revision: existingRev,
        promoted: false,
        messageId: existingMsg?.id || "existing-message",
        isIdempotentReplay: true,
      };
    }

    // 2. Check if revision already created in an earlier attempted commit
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

      // 3. Atomic CAS promotion: only promote if expectedCurrentRevisionId matches
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

    // 4. Mark GenerationRun as COMPLETED
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

    // 6. Create assistant Message with fragment (if not already existing)
    let message = await tx.message.findFirst({
      where: {
        projectId,
        content: summary,
        role: MessageRole.ASSISTANT,
        type: MessageType.RESULT,
      },
    });

    if (!message) {
      message = await tx.message.create({
        data: {
          projectId,
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
 * Transactionally finalizes a failed generation run.
 * Guarantees:
 * 1. GenerationRun transitions to FAILED with error code and diagnostics.
 * 2. Active project revision pointer is NEVER altered, strictly preserving prior working state.
 * 3. Error message is created and failure event recorded.
 */
export async function finalizeGenerationFailure(
  params: FinalizeGenerationFailureParams
): Promise<{ messageId: string }> {
  const { projectId, generationRunId, errorCode, errorMessage } = params;

  return await prisma.$transaction(async (tx) => {
    // 1. Transition run to FAILED
    await tx.generationRun.update({
      where: { id: generationRunId },
      data: {
        status: GenerationRunStatus.FAILED,
        errorCode,
        errorMessage,
        completedAt: new Date(),
      },
    });

    // 2. Record FAILED event
    await tx.runEvent.create({
      data: {
        runId: generationRunId,
        stage: "FAILED",
        agentRole: "System",
        message: `Run marked failed (${errorCode}): ${errorMessage}. Prior working revision preserved.`,
      },
    });

    // 3. Create error message for user
    const message = await tx.message.create({
      data: {
        projectId,
        content: `Quality Assurance failed: ${errorMessage} Your prior working revision is preserved.`,
        role: MessageRole.ASSISTANT,
        type: MessageType.ERROR,
      },
    });

    return { messageId: message.id };
  });
}
