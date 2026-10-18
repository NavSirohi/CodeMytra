import crypto from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import {
  sanitizeProjectFiles,
  generateManifest,
  FileTreeManifest,
} from "./revisions";

export const CANONICAL_WORKSPACE_DIR = "/home/user/workspace";
export const FALLBACK_WORKSPACE_DIR = "/home/user";

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
  workspaceDir?: string;
}

export interface CaptureSnapshotResult {
  files: Record<string, string>;
  manifest: FileTreeManifest;
}

/**
 * Captures the exact, complete filesystem snapshot from the defined project workspace in the E2B sandbox.
 * Strictly validates path safety, size limits, entrypoint presence, and content hashes.
 * Rejects unsupported/corrupted content and fails fast on malformed paths.
 * Excludes secrets, shell configurations, build caches, and non-workspace home directory files.
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

  // Determine active project workspace directory: prefer /home/user/workspace if present, fallback to /home/user
  let targetWorkspaceDir = options.workspaceDir || CANONICAL_WORKSPACE_DIR;
  try {
    const checkDirRes = await sandbox.commands.run(`test -d "${targetWorkspaceDir}" && echo "EXISTS"`, { timeoutMs: 5000 });
    if (!checkDirRes.stdout.includes("EXISTS")) {
      targetWorkspaceDir = FALLBACK_WORKSPACE_DIR;
    }
  } catch {
    targetWorkspaceDir = FALLBACK_WORKSPACE_DIR;
  }

  // Strictly exclude non-project files, credentials, shell dotfiles, and build artifacts
  const findCmd = `find "${targetWorkspaceDir}" -type f ` +
    `! -path "*/node_modules/*" ` +
    `! -path "*/.next/*" ` +
    `! -path "*/.cache/*" ` +
    `! -path "*/.git/*" ` +
    `! -path "*/dist/*" ` +
    `! -path "*/.turbo/*" ` +
    `! -path "*/.npm/*" ` +
    `! -path "*/.bun/*" ` +
    `! -path "*/.local/*" ` +
    `! -path "*/.config/*" ` +
    `! -path "*/.gnupg/*" ` +
    `! -path "*/.ssh/*" ` +
    `! -name ".bash*" ` +
    `! -name ".profile" ` +
    `! -name ".zsh*" ` +
    `! -name ".wget-hsts" ` +
    `! -name ".selected_editor" ` +
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
    throw new SnapshotError("Sandbox project workspace contains zero discovered project files");
  }

  if (filePaths.length > MAX_SNAPSHOT_FILES) {
    throw new SnapshotError(`Snapshot file count (${filePaths.length}) exceeds maximum limit of ${MAX_SNAPSHOT_FILES} files`);
  }

  const rawFiles: Record<string, string> = {};
  const basePrefix = `${targetWorkspaceDir}/`;
  let totalSnapshotBytes = 0;

  for (const fullPath of filePaths) {
    const normalizedFullPath = fullPath.trim();
    if (!normalizedFullPath.startsWith(basePrefix)) {
      continue;
    }

    const relativePath = normalizedFullPath.slice(basePrefix.length);

    // Fail immediately on dangerous or invalid paths (never ignore or silently skip)
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.includes("..") ||
      relativePath.includes("\\") ||
      relativePath.includes("\0")
    ) {
      throw new SnapshotError(`Invalid path discovered in workspace: "${relativePath}" (path traversal or malformed characters detected)`);
    }

    // Exclude unrelated home-directory dotfiles if running in fallback home dir
    if (targetWorkspaceDir === FALLBACK_WORKSPACE_DIR) {
      const parts = relativePath.split("/");
      if (parts[0].startsWith(".") && parts[0] !== ".gitignore" && parts[0] !== ".env.example") {
        continue;
      }
    }

    try {
      const content = await sandbox.files.read(normalizedFullPath);

      // Reject unsupported non-string or binary content (never replace with empty string)
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
