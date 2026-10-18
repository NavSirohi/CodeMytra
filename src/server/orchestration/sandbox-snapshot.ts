import crypto from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import {
  sanitizeProjectFiles,
  generateManifest,
  FileTreeManifest,
} from "./revisions";
import {
  PROJECT_WORKSPACE_DIR,
  toRelativeWorkspacePath,
} from "./workspace";

export const CANONICAL_WORKSPACE_DIR = PROJECT_WORKSPACE_DIR;

export const MAX_SINGLE_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB
export const MAX_SNAPSHOT_FILES = 2000;
export const MAX_TOTAL_SNAPSHOT_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export class SnapshotError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface CaptureSnapshotOptions {
  expectedFiles?: string[];
}

export interface CaptureSnapshotResult {
  files: Record<string, string>;
  manifest: FileTreeManifest;
}

/**
 * Captures the exact, complete filesystem snapshot from the authoritative project workspace in the E2B sandbox.
 * Operates strictly within PROJECT_WORKSPACE_DIR (/home/user/workspace).
 * Rejects unsupported/corrupted content and fails fast on malformed or escaping paths.
 * Excludes secrets, build caches, and non-workspace artifacts.
 * Throws SnapshotError on any failure or incomplete snapshot (never silently falls back).
 */
export async function captureSandboxSnapshot(
  sandboxId: string,
  options: CaptureSnapshotOptions = {}
): Promise<CaptureSnapshotResult> {
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.connect(sandboxId);
  } catch (err) {
    throw new SnapshotError(`Failed to connect to sandbox for snapshot: ${String(err)}`);
  }

  // Verify that the authoritative project workspace exists
  try {
    const dirCheck = await sandbox.commands.run(`test -d "${PROJECT_WORKSPACE_DIR}" && echo "EXISTS"`, { timeoutMs: 5000 });
    if (!dirCheck.stdout.includes("EXISTS")) {
      throw new SnapshotError(`Authoritative workspace "${PROJECT_WORKSPACE_DIR}" not found in sandbox ${sandboxId}`);
    }
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    throw new SnapshotError(`Failed checking workspace directory in sandbox: ${String(err)}`);
  }

  // Strictly scan inside the authoritative project workspace directory
  const findCmd = `find "${PROJECT_WORKSPACE_DIR}" -type f ` +
    `! -path "*/node_modules/*" ` +
    `! -path "*/.next/*" ` +
    `! -path "*/.cache/*" ` +
    `! -path "*/.git/*" ` +
    `! -path "*/dist/*" ` +
    `! -path "*/.turbo/*" ` +
    `! -path "*/.npm/*" ` +
    `! -path "*/.bun/*" ` +
    `! -name ".env*" ` +
    `! -name "*.pem" ` +
    `! -name "*.key" ` +
    `! -name "*.secret" ` +
    `! -name "*.token" ` +
    `! -name "*id_rsa*" ` +
    `! -name "*.log" ` +
    `! -name "nohup.out" ` +
    `! -name ".DS_Store"`;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await sandbox.commands.run(findCmd, { timeoutMs: 25000 });
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = res.exitCode;
  } catch (cmdErr) {
    throw new SnapshotError(`Sandbox command failed during snapshot discovery: ${String(cmdErr)}`);
  }

  if (exitCode !== 0) {
    throw new SnapshotError(`Filesystem discovery failed in sandbox: ${stderr || stdout}`);
  }

  const filePaths = stdout.trim().split("\n").filter((p) => p.trim().length > 0);
  if (filePaths.length === 0) {
    throw new SnapshotError(`Sandbox project workspace (${PROJECT_WORKSPACE_DIR}) contains zero discovered project files`);
  }

  if (filePaths.length > MAX_SNAPSHOT_FILES) {
    throw new SnapshotError(`Snapshot file count (${filePaths.length}) exceeds maximum limit of ${MAX_SNAPSHOT_FILES} files`);
  }

  const rawFiles: Record<string, string> = {};
  let totalSnapshotBytes = 0;

  for (const fullPath of filePaths) {
    const normalizedFullPath = fullPath.trim();

    // Enforce that path is strictly within the project workspace
    let relativePath: string;
    try {
      relativePath = toRelativeWorkspacePath(normalizedFullPath);
    } catch (pathErr) {
      throw new SnapshotError(`Invalid discovered path in workspace: ${String(pathErr)}`);
    }

    try {
      const content = await sandbox.files.read(normalizedFullPath);

      // Reject unsupported non-string or binary content (never silently convert to empty string)
      if (typeof content !== "string") {
        throw new SnapshotError(`Unsupported file content in ${relativePath}: Expected text string, received ${typeof content}`);
      }

      const fileSizeBytes = Buffer.byteLength(content, "utf8");
      if (fileSizeBytes > MAX_SINGLE_FILE_SIZE_BYTES) {
        throw new SnapshotError(`File ${relativePath} (${fileSizeBytes} bytes) exceeds maximum single file size limit of ${MAX_SINGLE_FILE_SIZE_BYTES} bytes`);
      }

      totalSnapshotBytes += fileSizeBytes;
      if (totalSnapshotBytes > MAX_TOTAL_SNAPSHOT_SIZE_BYTES) {
        throw new SnapshotError(`Total snapshot size (${totalSnapshotBytes} bytes) exceeds maximum limit of ${MAX_TOTAL_SNAPSHOT_SIZE_BYTES} bytes`);
      }

      // Legitimate empty files (e.g. .gitkeep, empty init files) are strictly preserved as empty strings
      rawFiles[relativePath] = content;
    } catch (readErr) {
      if (readErr instanceof SnapshotError) {
        throw readErr;
      }
      throw new SnapshotError(`Failed reading sandbox file ${relativePath}: ${String(readErr)}`);
    }
  }

  // Verify all expected project files are present
  if (options.expectedFiles && options.expectedFiles.length > 0) {
    for (const expected of options.expectedFiles) {
      if (rawFiles[expected] === undefined) {
        throw new SnapshotError(`Snapshot verification failed: expected project file "${expected}" was not captured`);
      }
    }
  }

  // Validate required entrypoint exists
  const hasEntrypoint = Boolean(
    rawFiles["app/page.tsx"] ||
    rawFiles["src/app/page.tsx"] ||
    rawFiles["pages/index.tsx"] ||
    rawFiles["page.tsx"]
  );

  if (!hasEntrypoint) {
    throw new SnapshotError("Incomplete snapshot: missing required Next.js entrypoint file (app/page.tsx)");
  }

  // Sanitize paths and generate manifest with cryptographic SHA-256 hashes
  const files = sanitizeProjectFiles(rawFiles);
  const manifest = generateManifest(files);

  // Verify cryptographic content hashes against computed snapshot files
  for (const [filePath, expectedHash] of Object.entries(manifest.hashes || {})) {
    const content = files[filePath];
    if (content === undefined) {
      throw new SnapshotError(`Manifest integrity verification failed: file "${filePath}" missing from files`);
    }
    const computedHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    if (computedHash !== expectedHash) {
      throw new SnapshotError(`Snapshot content hash verification failed for "${filePath}": expected ${expectedHash}, computed ${computedHash}`);
    }
  }

  return { files, manifest };
}
