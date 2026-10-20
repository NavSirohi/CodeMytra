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

export type SnapshotFailurePhase =
  | "connect"
  | "workspace-check"
  | "file-discovery"
  | "file-read"
  | "integrity-check"
  | "sandbox-expiry";

export interface SnapshotErrorDetails {
  failedPath?: string;
  durationMs?: number;
  fileCount?: number;
  exitCode?: number | null;
  cause?: string;
}

export class SnapshotError extends Error {
  public readonly phase: SnapshotFailurePhase;
  public readonly details?: SnapshotErrorDetails;

  constructor(
    message: string,
    phase: SnapshotFailurePhase = "file-read",
    details?: SnapshotErrorDetails
  ) {
    super(message);
    this.name = "SnapshotError";
    this.phase = phase;
    this.details = details;
  }
}

export interface CaptureSnapshotOptions {
  expectedFiles?: string[];
  customSandbox?: Sandbox | {
    commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode?: number; stdout?: string; stderr?: string }> };
    files: { read(path: string): Promise<string> };
  };
}

export interface CaptureSnapshotResult {
  files: Record<string, string>;
  manifest: FileTreeManifest;
  diagnostics?: {
    fileCount: number;
    totalBytes: number;
    durationMs: number;
    provenance: string;
  };
}

export function isSandboxExpiredError(err: unknown): boolean {
  const text = String(err || "").toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("has been closed") ||
    text.includes("expired") ||
    text.includes("not running") ||
    text.includes("terminated") ||
    text.includes("unauthorized")
  );
}

function isTransientTransportError(errOrMsg: unknown): boolean {
  const text = String(errOrMsg || "").toLowerCase();
  return (
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("socket hang up") ||
    text.includes("deadline_exceeded") ||
    text.includes("fetch failed") ||
    text.includes("network error") ||
    text.includes("connection reset") ||
    text.includes("timed out")
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let activeWorkers = 0;

  return new Promise((resolve, reject) => {
    let hasError = false;

    function launchNext() {
      if (hasError) return;
      if (nextIndex >= items.length) {
        if (activeWorkers === 0) {
          resolve(results);
        }
        return;
      }

      while (activeWorkers < limit && nextIndex < items.length) {
        const index = nextIndex++;
        activeWorkers++;

        fn(items[index], index)
          .then((res) => {
            results[index] = res;
            activeWorkers--;
            launchNext();
          })
          .catch((err) => {
            if (!hasError) {
              hasError = true;
              reject(err);
            }
          });
      }
    }

    launchNext();
  });
}

async function readFileWithRetry(
  sandbox: Sandbox | { files: { read(path: string): Promise<string> } },
  fullPath: string,
  relativePath: string,
  timeoutMs = 10000,
  maxRetries = 2
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const content = await withTimeout(
        sandbox.files.read(fullPath),
        timeoutMs,
        `Reading ${relativePath}`
      );
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransientTransportError(err)) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      break;
    }
  }
  throw lastErr;
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
  const startTime = Date.now();
  let sandbox: Sandbox | {
    commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode?: number; stdout?: string; stderr?: string }> };
    files: { read(path: string): Promise<string> };
  };

  // Phase 1: Sandbox connection
  try {
    if (options.customSandbox) {
      sandbox = options.customSandbox;
    } else {
      sandbox = await withTimeout(
        Sandbox.connect(sandboxId),
        15000,
        "Sandbox connection"
      );
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const isExpiry = isSandboxExpiredError(errMsg);
    const phase: SnapshotFailurePhase = isExpiry ? "sandbox-expiry" : "connect";
    throw new SnapshotError(
      isExpiry
        ? `Sandbox ${sandboxId} has expired or terminated (${elapsed}ms)`
        : `Failed to connect to sandbox ${sandboxId} (${elapsed}ms): ${errMsg}`,
      phase,
      { durationMs: elapsed, cause: errMsg }
    );
  }

  // Phase 2: Authoritative workspace existence check
  try {
    const dirCheck = await sandbox.commands.run(
      `test -d "${PROJECT_WORKSPACE_DIR}" && echo "EXISTS"`,
      { timeoutMs: 8000 }
    );
    if (!dirCheck.stdout?.includes("EXISTS")) {
      const elapsed = Date.now() - startTime;
      throw new SnapshotError(
        `Authoritative workspace "${PROJECT_WORKSPACE_DIR}" not found in sandbox ${sandboxId} (${elapsed}ms)`,
        "workspace-check",
        { durationMs: elapsed }
      );
    }
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    const elapsed = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const isExpiry = isSandboxExpiredError(errMsg);
    const phase: SnapshotFailurePhase = isExpiry ? "sandbox-expiry" : "workspace-check";
    throw new SnapshotError(
      isExpiry
        ? `Sandbox ${sandboxId} expired during workspace verification (${elapsed}ms)`
        : `Failed checking workspace directory in sandbox (${elapsed}ms): ${errMsg}`,
      phase,
      { durationMs: elapsed, cause: errMsg }
    );
  }

  // Phase 3: Filesystem discovery
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
    const res = await sandbox.commands.run(findCmd, { timeoutMs: 20000 });
    stdout = res.stdout || "";
    stderr = res.stderr || "";
    exitCode = res.exitCode ?? 0;
  } catch (cmdErr) {
    const elapsed = Date.now() - startTime;
    const errMsg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
    const isExpiry = isSandboxExpiredError(errMsg);
    throw new SnapshotError(
      isExpiry
        ? `Sandbox ${sandboxId} expired during file discovery (${elapsed}ms)`
        : `Sandbox command failed during snapshot discovery (${elapsed}ms): ${errMsg}`,
      isExpiry ? "sandbox-expiry" : "file-discovery",
      { durationMs: elapsed, cause: errMsg }
    );
  }

  if (exitCode !== 0) {
    const elapsed = Date.now() - startTime;
    throw new SnapshotError(
      `Filesystem discovery failed in sandbox (${elapsed}ms, exit code ${exitCode}): ${stderr || stdout}`,
      "file-discovery",
      { durationMs: elapsed, exitCode, cause: stderr || stdout }
    );
  }

  const rawPaths = stdout.trim().split("\n").filter((p) => p.trim().length > 0);
  if (rawPaths.length === 0) {
    const elapsed = Date.now() - startTime;
    throw new SnapshotError(
      `Sandbox project workspace (${PROJECT_WORKSPACE_DIR}) contains zero discovered project files (${elapsed}ms)`,
      "file-discovery",
      { durationMs: elapsed, fileCount: 0 }
    );
  }

  if (rawPaths.length > MAX_SNAPSHOT_FILES) {
    const elapsed = Date.now() - startTime;
    throw new SnapshotError(
      `Snapshot file count (${rawPaths.length}) exceeds maximum limit of ${MAX_SNAPSHOT_FILES} files (${elapsed}ms)`,
      "integrity-check",
      { durationMs: elapsed, fileCount: rawPaths.length }
    );
  }

  // Disambiguate duplicate Next.js config files:
  // If next.config.mjs exists in workspace, ignore next.config.ts / next.config.js
  const hasMjsConfig = rawPaths.some((p) => p.endsWith("/next.config.mjs") || p === "next.config.mjs");
  const filePaths = rawPaths.filter((p) => {
    if (hasMjsConfig && (p.endsWith("/next.config.ts") || p.endsWith("/next.config.js"))) {
      return false;
    }
    return true;
  });

  // Phase 4: Bounded concurrent file reading with transient retry
  const rawFiles: Record<string, string> = {};
  let totalSnapshotBytes = 0;

  try {
    const fileEntries = await mapConcurrent(
      filePaths,
      6, // concurrency limit of 6 workers
      async (fullPath) => {
        const normalizedFullPath = fullPath.trim();
        let relativePath: string;
        try {
          relativePath = toRelativeWorkspacePath(normalizedFullPath);
        } catch (pathErr) {
          throw new SnapshotError(
            `Invalid discovered path in workspace: ${String(pathErr)}`,
            "integrity-check",
            { failedPath: fullPath, durationMs: Date.now() - startTime }
          );
        }

        try {
          const content = await readFileWithRetry(
            sandbox,
            normalizedFullPath,
            relativePath,
            10000, // 10s per file
            2      // max 2 retries
          );

          if (typeof content !== "string") {
            throw new SnapshotError(
              `Unsupported file content in ${relativePath}: Expected text string, received ${typeof content}`,
              "integrity-check",
              { failedPath: relativePath, durationMs: Date.now() - startTime }
            );
          }

          const fileSizeBytes = Buffer.byteLength(content, "utf8");
          if (fileSizeBytes > MAX_SINGLE_FILE_SIZE_BYTES) {
            throw new SnapshotError(
              `File ${relativePath} (${fileSizeBytes} bytes) exceeds maximum single file size limit of ${MAX_SINGLE_FILE_SIZE_BYTES} bytes`,
              "integrity-check",
              { failedPath: relativePath, durationMs: Date.now() - startTime }
            );
          }

          return { relativePath, content, size: fileSizeBytes };
        } catch (readErr) {
          if (readErr instanceof SnapshotError) throw readErr;
          const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
          const isExpiry = isSandboxExpiredError(errMsg);
          throw new SnapshotError(
            isExpiry
              ? `Sandbox expired while reading file ${relativePath}`
              : `Failed reading sandbox file ${relativePath}: ${errMsg}`,
            isExpiry ? "sandbox-expiry" : "file-read",
            { failedPath: relativePath, durationMs: Date.now() - startTime, fileCount: filePaths.length, cause: errMsg }
          );
        }
      }
    );

    for (const entry of fileEntries) {
      totalSnapshotBytes += entry.size;
      if (totalSnapshotBytes > MAX_TOTAL_SNAPSHOT_SIZE_BYTES) {
        throw new SnapshotError(
          `Total snapshot size (${totalSnapshotBytes} bytes) exceeds maximum limit of ${MAX_TOTAL_SNAPSHOT_SIZE_BYTES} bytes`,
          "integrity-check",
          { durationMs: Date.now() - startTime, fileCount: filePaths.length }
        );
      }
      rawFiles[entry.relativePath] = entry.content;
    }
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new SnapshotError(
      `File reading pipeline failed: ${errMsg}`,
      "file-read",
      { durationMs: Date.now() - startTime, fileCount: filePaths.length, cause: errMsg }
    );
  }

  // Phase 5: Integrity Verification
  // Verify expected files
  if (options.expectedFiles && options.expectedFiles.length > 0) {
    for (const expected of options.expectedFiles) {
      if (rawFiles[expected] === undefined) {
        throw new SnapshotError(
          `Snapshot verification failed: expected project file "${expected}" was not captured`,
          "integrity-check",
          { failedPath: expected, durationMs: Date.now() - startTime, fileCount: Object.keys(rawFiles).length }
        );
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
    throw new SnapshotError(
      "Incomplete snapshot: missing required Next.js entrypoint file (app/page.tsx)",
      "integrity-check",
      { durationMs: Date.now() - startTime, fileCount: Object.keys(rawFiles).length }
    );
  }

  // Sanitize paths and generate manifest with cryptographic SHA-256 hashes
  const files = sanitizeProjectFiles(rawFiles);
  const manifest = generateManifest(files);

  // Verify cryptographic content hashes against computed snapshot files
  for (const [filePath, expectedHash] of Object.entries(manifest.hashes || {})) {
    const content = files[filePath];
    if (content === undefined) {
      throw new SnapshotError(
        `Manifest integrity verification failed: file "${filePath}" missing from files`,
        "integrity-check",
        { failedPath: filePath, durationMs: Date.now() - startTime }
      );
    }
    const computedHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    if (computedHash !== expectedHash) {
      throw new SnapshotError(
        `Snapshot content hash verification failed for "${filePath}": expected ${expectedHash}, computed ${computedHash}`,
        "integrity-check",
        { failedPath: filePath, durationMs: Date.now() - startTime }
      );
    }
  }

  const durationMs = Date.now() - startTime;
  return {
    files,
    manifest,
    diagnostics: {
      fileCount: Object.keys(files).length,
      totalBytes: totalSnapshotBytes,
      durationMs,
      provenance: "canonical-sandbox-snapshot",
    },
  };
}
