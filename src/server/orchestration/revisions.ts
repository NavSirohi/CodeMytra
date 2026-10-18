import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import path from "path";

export interface FileTreeManifest {
  fileCount: number;
  totalSizeBytes: number;
  paths: string[];
}

export interface CreateRevisionParams {
  projectId: string;
  generationRunId?: string;
  parentRevisionId?: string | null;
  title?: string;
  summary?: string;
  files: Record<string, string>;
}

/**
 * Filter and validate file paths to prevent directory traversal or storing sensitive files.
 */
export function sanitizeProjectFiles(files: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [rawPath, content] of Object.entries(files)) {
    // Normalize path
    const normalized = path.normalize(rawPath).replace(/^(\.\/|\/)/, "");

    // Path traversal check
    if (normalized.includes("..") || path.isAbsolute(rawPath)) {
      continue;
    }

    // Exclude unwanted and sensitive files
    const segments = normalized.split("/");
    if (
      segments.includes("node_modules") ||
      segments.includes(".next") ||
      segments.includes(".git") ||
      segments.includes(".cache") ||
      normalized.startsWith(".env") ||
      normalized.endsWith(".pem") ||
      normalized.endsWith(".key")
    ) {
      continue;
    }

    sanitized[normalized] = content;
  }

  return sanitized;
}

export function generateManifest(files: Record<string, string>): FileTreeManifest {
  const paths = Object.keys(files).sort();
  let totalSizeBytes = 0;

  for (const content of Object.values(files)) {
    totalSizeBytes += Buffer.byteLength(content, "utf8");
  }

  return {
    fileCount: paths.length,
    totalSizeBytes,
    paths,
  };
}

/**
 * Persists an immutable project revision.
 * Assigns monotonically increasing revisionNumber per project.
 */
export async function createProjectRevision(params: CreateRevisionParams) {
  const { projectId, generationRunId, parentRevisionId, title, summary } = params;

  const sanitizedFiles = sanitizeProjectFiles(params.files);
  const manifest = generateManifest(sanitizedFiles);

  return prisma.$transaction(async (tx) => {
    // Get highest revision number
    const lastRev = await tx.projectRevision.findFirst({
      where: { projectId },
      orderBy: { revisionNumber: "desc" },
      select: { revisionNumber: true, id: true },
    });

    const nextRevisionNumber = (lastRev?.revisionNumber ?? 0) + 1;
    const resolvedParentId = parentRevisionId ?? lastRev?.id ?? null;

    const revision = await tx.projectRevision.create({
      data: {
        projectId,
        generationRunId,
        parentRevisionId: resolvedParentId,
        revisionNumber: nextRevisionNumber,
        title: title || `Revision ${nextRevisionNumber}`,
        summary: summary || null,
        files: sanitizedFiles,
        manifest: manifest as unknown as Prisma.InputJsonObject,
      },
    });

    // Update project pointer to current revision
    await tx.project.update({
      where: { id: projectId },
      data: { currentRevisionId: revision.id },
    });

    return revision;
  });
}

/**
 * Retrieves the base revision to start a new generation from.
 */
export async function resolveBaseRevision(projectId: string, specificRevisionId?: string | null) {
  if (specificRevisionId) {
    return prisma.projectRevision.findUnique({
      where: { id: specificRevisionId },
    });
  }

  // Check project's currentRevision
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { currentRevisionId: true },
  });

  if (project?.currentRevisionId) {
    return prisma.projectRevision.findUnique({
      where: { id: project.currentRevisionId },
    });
  }

  // Fallback to highest revisionNumber
  return prisma.projectRevision.findFirst({
    where: { projectId },
    orderBy: { revisionNumber: "desc" },
  });
}

/**
 * Restores a historical revision by cloning its files into a brand new revision,
 * preserving full audit history without destructive overwriting.
 */
export async function restoreHistoricalRevision(
  projectId: string,
  targetRevisionId: string,
  userId: string
) {
  // Verify project ownership
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
  });

  if (!project) {
    throw new Error("Project not found or unauthorized");
  }

  const targetRevision = await prisma.projectRevision.findUnique({
    where: { id: targetRevisionId, projectId },
  });

  if (!targetRevision) {
    throw new Error("Target revision not found");
  }

  const files = (targetRevision.files as Record<string, string>) || {};

  return createProjectRevision({
    projectId,
    parentRevisionId: targetRevision.id,
    title: `Restored from V${targetRevision.revisionNumber}`,
    summary: `Restored application files from Revision ${targetRevision.revisionNumber}`,
    files,
  });
}
