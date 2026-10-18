import { Sandbox } from "@e2b/code-interpreter";
import {
  sanitizeProjectFiles,
  generateManifest,
  FileTreeManifest,
} from "./revisions";

export const CANONICAL_WORKSPACE_DIR = "/home/user";

export class SnapshotError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface CaptureSnapshotResult {
  files: Record<string, string>;
  manifest: FileTreeManifest;
}

/**
 * Captures the exact, complete filesystem snapshot from the canonical workspace directory in the E2B sandbox.
 * Strictly validates path safety, size limits, entrypoint presence, and content hashes.
 * Throws SnapshotError on any failure or incomplete snapshot (never silently falls back).
 */
export async function captureSandboxSnapshot(sandboxId: string): Promise<CaptureSnapshotResult> {
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.connect(sandboxId);
  } catch (err) {
    throw new SnapshotError(`Failed to connect to sandbox for snapshot: ${String(err)}`);
  }

  // Locate all project files inside canonical workspace directory
  // Exclude node_modules, .next, .cache, .git, dist, .turbo, .npm, .bun, and credentials
  const findCmd = `find ${CANONICAL_WORKSPACE_DIR} -type f ` +
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
    `! -name "*.log" ` +
    `! -name ".DS_Store"`;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const res = await sandbox.commands.run(findCmd, { timeoutMs: 20000 });
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
    throw new SnapshotError("Sandbox workspace contains zero discovered project files");
  }

  const rawFiles: Record<string, string> = {};
  const basePrefix = `${CANONICAL_WORKSPACE_DIR}/`;

  for (const fullPath of filePaths) {
    const normalizedFullPath = fullPath.trim();
    if (!normalizedFullPath.startsWith(basePrefix)) {
      continue;
    }

    const relativePath = normalizedFullPath.slice(basePrefix.length);
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("..")) {
      continue;
    }

    try {
      // Preserve legitimate empty files as well
      const content = await sandbox.files.read(normalizedFullPath);
      rawFiles[relativePath] = typeof content === "string" ? content : "";
    } catch (readErr) {
      throw new SnapshotError(`Failed reading sandbox file ${relativePath}: ${String(readErr)}`);
    }
  }

  // Validate required entrypoint
  const hasEntrypoint = Boolean(
    rawFiles["app/page.tsx"] ||
    rawFiles["src/app/page.tsx"] ||
    rawFiles["pages/index.tsx"] ||
    rawFiles["page.tsx"]
  );

  if (!hasEntrypoint) {
    throw new SnapshotError("Incomplete snapshot: missing required Next.js entrypoint file (app/page.tsx)");
  }

  // Sanitize paths/sizes and generate manifest with SHA-256 hashes
  const files = sanitizeProjectFiles(rawFiles);
  const manifest = generateManifest(files);

  return { files, manifest };
}
