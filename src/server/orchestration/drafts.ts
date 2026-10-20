import { prisma } from "@/lib/db";
import { DraftValidationStatus, GenerationDraft, Prisma } from "@/generated/prisma/client";
import { sanitizeProjectFiles, generateManifest } from "./revisions";

export interface UpsertDraftParams {
  generationRunId: string;
  projectId: string;
  files: Record<string, string>;
  validationStatus?: DraftValidationStatus;
  diagnostics?: Record<string, unknown> | null;
  summary?: string;
  source?: string;
}

export interface GetDraftOptions {
  projectId: string;
  userId: string;
  generationRunId?: string;
  draftId?: string;
}

/**
 * Persists or updates the per-generation unverified draft artifact.
 * Captures the exact source files and sanitized manifest immediately after code generation
 * or QA repair, guaranteeing that source code is never lost even if QA fails.
 */
export async function upsertGenerationDraft(params: UpsertDraftParams): Promise<GenerationDraft> {
  const {
    generationRunId,
    projectId,
    files,
    validationStatus = DraftValidationStatus.UNVALIDATED,
    diagnostics = null,
    summary,
    source = "coding-agent",
  } = params;

  const sanitized = sanitizeProjectFiles(files);
  const manifest = generateManifest(sanitized);

  return prisma.generationDraft.upsert({
    where: { generationRunId },
    create: {
      generationRunId,
      projectId,
      files: sanitized,
      manifest: manifest as unknown as Prisma.InputJsonObject,
      validationStatus,
      diagnostics: diagnostics as unknown as Prisma.InputJsonObject,
      summary: summary || null,
      source,
    },
    update: {
      files: sanitized,
      manifest: manifest as unknown as Prisma.InputJsonObject,
      validationStatus,
      diagnostics: diagnostics as unknown as Prisma.InputJsonObject,
      summary: summary || null,
      source,
    },
  });
}

/**
 * Updates only the validation status and diagnostics of an existing draft.
 */
export async function updateDraftValidationStatus(
  generationRunId: string,
  validationStatus: DraftValidationStatus,
  diagnostics?: Record<string, unknown> | null
): Promise<GenerationDraft | null> {
  try {
    return await prisma.generationDraft.update({
      where: { generationRunId },
      data: {
        validationStatus,
        diagnostics: diagnostics ? (diagnostics as unknown as Prisma.InputJsonObject) : undefined,
      },
    });
  } catch (err) {
    console.warn(`[Drafts] Failed to update draft validation status for run ${generationRunId}:`, err);
    return null;
  }
}

/**
 * Retrieves a generation draft scoped strictly by project ownership.
 * A draft must never be accessible across unauthorized user boundaries.
 */
export async function getAuthorizedDraft(options: GetDraftOptions): Promise<GenerationDraft | null> {
  const { projectId, userId, generationRunId, draftId } = options;

  // Strict ownership verification: project must belong to userId
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
    select: { id: true },
  });

  if (!project) {
    return null;
  }

  if (draftId) {
    return prisma.generationDraft.findFirst({
      where: { id: draftId, projectId },
    });
  }

  if (generationRunId) {
    return prisma.generationDraft.findFirst({
      where: { generationRunId, projectId },
    });
  }

  // Fallback to latest draft for this project
  return prisma.generationDraft.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}
