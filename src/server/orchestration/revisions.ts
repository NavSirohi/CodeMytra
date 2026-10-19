import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import path from "path";
import crypto from "crypto";

export interface FileTreeManifest {
  fileCount: number;
  totalSizeBytes: number;
  paths: string[];
  hashes?: Record<string, string>; // path -> sha256
}

export type CreatedProjectRevision = Prisma.ProjectRevisionGetPayload<object> & {
  promoted: boolean;
};

export interface CreateRevisionParams {
  projectId: string;
  generationRunId?: string;
  parentRevisionId?: string | null;
  expectedCurrentRevisionId?: string | null;
  title?: string;
  summary?: string;
  files: Record<string, string>;
}

export const MAX_FILES_PER_REVISION = 100;
export const MAX_SINGLE_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB
export const MAX_TOTAL_REVISION_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Filter and validate file paths and sizes to prevent directory traversal,
 * oversized payloads, or storing sensitive files.
 */
export function sanitizeProjectFiles(files: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  let totalBytes = 0;

  const entries = Object.entries(files);
  if (entries.length > MAX_FILES_PER_REVISION) {
    throw new Error(`Revision exceeds maximum file limit of ${MAX_FILES_PER_REVISION} files (received ${entries.length})`);
  }

  for (const [rawPath, content] of entries) {
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
      (normalized.startsWith(".env") && normalized !== ".env.example") ||
      normalized.endsWith(".pem") ||
      normalized.endsWith(".key")
    ) {
      continue;
    }

    const fileSizeBytes = Buffer.byteLength(content, "utf8");
    if (fileSizeBytes > MAX_SINGLE_FILE_SIZE_BYTES) {
      throw new Error(`File ${normalized} exceeds single file size limit of 1MB (${fileSizeBytes} bytes)`);
    }

    totalBytes += fileSizeBytes;
    if (totalBytes > MAX_TOTAL_REVISION_SIZE_BYTES) {
      throw new Error(`Total revision size exceeds maximum limit of 20MB`);
    }

    sanitized[normalized] = content;
  }

  return sanitized;
}

export function generateManifest(files: Record<string, string>): FileTreeManifest {
  const paths = Object.keys(files).sort();
  let totalSizeBytes = 0;
  const hashes: Record<string, string> = {};

  for (const [p, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content, "utf8");
    totalSizeBytes += bytes;
    hashes[p] = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }

  return {
    fileCount: paths.length,
    totalSizeBytes,
    paths,
    hashes,
  };
}

export interface ValidateManifestOptions {
  requireHashes?: boolean;
}

/**
 * Validates that an in-memory file tree matches its recorded manifest,
 * including path completeness, file counts, and cryptographic content hashes.
 * Supports an explicit documented compatibility path for legacy revisions without hashes.
 */
export function validateRevisionManifest(
  files: Record<string, string>,
  manifest?: FileTreeManifest | null,
  options?: ValidateManifestOptions
): { valid: boolean; error?: string; isLegacyWithoutHashes?: boolean } {
  if (!manifest) {
    return { valid: true };
  }

  const fileKeys = Object.keys(files);
  if (manifest.fileCount !== undefined && fileKeys.length !== manifest.fileCount) {
    return {
      valid: false,
      error: `Manifest fileCount mismatch: expected ${manifest.fileCount}, found ${fileKeys.length}`,
    };
  }

  if (manifest.paths && Array.isArray(manifest.paths)) {
    for (const expectedPath of manifest.paths) {
      if (files[expectedPath] === undefined) {
        return {
          valid: false,
          error: `Missing required file from manifest: ${expectedPath}`,
        };
      }
    }
  }

  // Handle cryptographic content hashes
  if (manifest.hashes && typeof manifest.hashes === "object" && Object.keys(manifest.hashes).length > 0) {
    for (const [expectedPath, expectedHash] of Object.entries(manifest.hashes)) {
      if (files[expectedPath] !== undefined) {
        const computedHash = crypto
          .createHash("sha256")
          .update(files[expectedPath], "utf8")
          .digest("hex");
        if (computedHash !== expectedHash) {
          return {
            valid: false,
            error: `Content hash mismatch for ${expectedPath}: expected ${expectedHash}, computed ${computedHash}`,
          };
        }
      }
    }
  } else {
    // Explicit documented compatibility path for legacy revisions created before M1.5
    if (options?.requireHashes) {
      return {
        valid: false,
        error: "Revision manifest missing cryptographic SHA-256 hashes (required for M1.5+ revisions)",
      };
    }
    return { valid: true, isLegacyWithoutHashes: true };
  }

  return { valid: true };
}

export class RestorationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "RestorationError";
  }
}

/**
 * Persists an immutable project revision.
 * Idempotent: returns existing revision if generationRunId has already produced one.
 * Concurrency-safe: atomically assigns monotonically increasing revisionNumber.
 */
export async function createProjectRevision(params: CreateRevisionParams): Promise<CreatedProjectRevision> {
  const { projectId, generationRunId, parentRevisionId, title, summary } = params;

  // Idempotency check: if this generation run already generated a revision, return it
  if (generationRunId) {
    const existing = await prisma.projectRevision.findFirst({
      where: {
        projectId,
        generationRunId,
      },
    });
    if (existing) {
      return Object.assign(existing, { promoted: false });
    }
  }

  const sanitizedFiles = sanitizeProjectFiles(params.files);
  const manifest = generateManifest(sanitizedFiles);

  // Retries for concurrency on unique [projectId, revisionNumber]
  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Double check idempotency inside transaction
        if (generationRunId) {
          const existingInside = await tx.projectRevision.findFirst({
            where: { projectId, generationRunId },
          });
          if (existingInside) return Object.assign(existingInside, { promoted: false });
        }

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

        // Safe finalization: atomic conditional CAS update
        let promoted = true;
        if (params.expectedCurrentRevisionId !== undefined) {
          if (typeof tx.project.updateMany === "function") {
            const updateResult = await tx.project.updateMany({
              where: {
                id: projectId,
                currentRevisionId: params.expectedCurrentRevisionId,
              },
              data: { currentRevisionId: revision.id },
            });

            if (updateResult.count === 0) {
              // Another generation already promoted a newer active revision.
              // Revision is preserved for audit trail, but pointer is not overwritten.
              promoted = false;
            }
          } else {
            const currentProject = await tx.project.findUnique({
              where: { id: projectId },
              select: { currentRevisionId: true },
            });
            if (currentProject?.currentRevisionId === params.expectedCurrentRevisionId) {
              await tx.project.update({
                where: { id: projectId },
                data: { currentRevisionId: revision.id },
              });
            } else {
              promoted = false;
            }
          }
        } else {
          await tx.project.update({
            where: { id: projectId },
            data: { currentRevisionId: revision.id },
          });
        }

        return Object.assign(revision, { promoted });
      });
    } catch (err: unknown) {
      lastError = err;
      // If error is unique constraint violation, retry loop
      const isUniqueError = err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002";
      if (!isUniqueError) {
        throw err;
      }
    }
  }

  throw lastError;
}

/**
 * Retrieves the base revision to start a new generation from.
 * Strict project boundary enforcement: verifies requested revision belongs to projectId.
 */
export async function resolveBaseRevision(projectId: string, specificRevisionId?: string | null) {
  if (specificRevisionId) {
    const revision = await prisma.projectRevision.findFirst({
      where: { id: specificRevisionId, projectId },
    });
    if (!revision) {
      throw new Error(`Base revision ${specificRevisionId} does not belong to project ${projectId} or was not found`);
    }
    return revision;
  }

  // Check project's currentRevision
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { currentRevisionId: true },
  });

  if (project?.currentRevisionId) {
    const current = await prisma.projectRevision.findFirst({
      where: { id: project.currentRevisionId, projectId },
    });
    if (current) return current;
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

  const targetRevision = await prisma.projectRevision.findFirst({
    where: { id: targetRevisionId, projectId },
  });

  if (!targetRevision) {
    throw new Error("Target revision not found or does not belong to this project");
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
