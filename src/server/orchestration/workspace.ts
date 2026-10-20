import path from "path";
import { Sandbox } from "@e2b/code-interpreter";

/**
 * Authoritative canonical project workspace directory in the E2B sandbox.
 * All project files, commands, builds, QA checks, and snapshots operate exclusively within this path.
 */
export const PROJECT_WORKSPACE_DIR = "/home/user/workspace";

/**
 * Validates and resolves a project-relative file path to an absolute path inside the project workspace.
 * Strict security boundary: rejects path traversal, absolute paths, null bytes, and non-canonical separators.
 */
export function resolveWorkspacePath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error(
      `Invalid workspace path: "${relativePath}". All paths must be relative and remain strictly inside ${PROJECT_WORKSPACE_DIR}`
    );
  }
  return path.posix.join(PROJECT_WORKSPACE_DIR, trimmed);
}

/**
 * Normalizes an absolute path from the sandbox filesystem back to a relative workspace path.
 * Throws if the path is outside the authoritative project workspace directory.
 */
export function toRelativeWorkspacePath(absolutePath: string): string {
  const normalized = absolutePath.trim();
  const prefix = `${PROJECT_WORKSPACE_DIR}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(
      `Path "${absolutePath}" is outside the authoritative project workspace "${PROJECT_WORKSPACE_DIR}"`
    );
  }
  const rel = normalized.slice(prefix.length);
  if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("\0")) {
    throw new Error(`Malformed relative path derived from "${absolutePath}"`);
  }
  return rel;
}

/**
 * Authoritatively initializes the project workspace inside an E2B sandbox container.
 * Prepares /home/user/workspace, links template node_modules, and copies base configs if needed.
 */
export async function initializeSandboxWorkspace(sandbox: Sandbox): Promise<void> {
  const initScript = `
    mkdir -p "${PROJECT_WORKSPACE_DIR}"
    if [ -d /home/user/node_modules ] && [ ! -e "${PROJECT_WORKSPACE_DIR}/node_modules" ]; then
      ln -s /home/user/node_modules "${PROJECT_WORKSPACE_DIR}/node_modules"
    fi
    for f in package.json tsconfig.json next.config.mjs next.config.ts next.config.js tailwind.config.ts tailwind.config.js postcss.config.mjs postcss.config.js bun.lockb bun.lock; do
      if [ -f "/home/user/$f" ] && [ ! -f "${PROJECT_WORKSPACE_DIR}/$f" ]; then
        cp "/home/user/$f" "${PROJECT_WORKSPACE_DIR}/$f"
      fi
    done
    if [ -f "${PROJECT_WORKSPACE_DIR}/next.config.mjs" ]; then
      rm -f "${PROJECT_WORKSPACE_DIR}/next.config.ts" "${PROJECT_WORKSPACE_DIR}/next.config.js"
    fi
    if [ -f "${PROJECT_WORKSPACE_DIR}/prisma/schema.prisma" ]; then
      cd "${PROJECT_WORKSPACE_DIR}" && (bunx --bun prisma generate || npx prisma generate) 2>/dev/null || true
    fi
  `;

  const res = await sandbox.commands.run(initScript, { timeoutMs: 15000 });
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to initialize sandbox workspace at ${PROJECT_WORKSPACE_DIR}: ${res.stderr || res.stdout}`
    );
  }
}

/**
 * Writes project files (such as base foundation files or restored revision files)
 * into the authoritative E2B sandbox project workspace.
 */
export async function writeWorkspaceFiles(
  sandbox: Sandbox,
  files: Record<string, string>
): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const targetPath = resolveWorkspacePath(filePath);
    await sandbox.files.write(targetPath, content);
  }
}

export interface PreviewServerOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

export class PreviewReadinessError extends Error {
  constructor(message: string, public readonly logSnippet?: string) {
    super(message);
    this.name = "PreviewReadinessError";
  }
}

export interface PreviewSandboxRunner {
  commands: {
    run(command: string, options?: { timeoutMs?: number }): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  };
}

/**
 * Ensures that the sandbox Next.js development server is active, listening on port 3000,
 * and responsive to HTTP requests before returning the public preview URL to the user.
 * 
 * 1. Proactively clears any stale or conflicting processes on port 3000.
 * 2. Prepares canonical workspace: links dependencies and cleans duplicate config.
 * 3. Starts the development server directly within PROJECT_WORKSPACE_DIR (/home/user/workspace).
 * 4. Uses bounded independent HTTP polling to verify responsiveness without SDK-level timeout hangs.
 * 5. Extracts server logs and throws PreviewReadinessError if the server fails to become ready.
 */
export async function ensureSandboxPreviewServer(
  sandbox: Sandbox | PreviewSandboxRunner,
  options?: PreviewServerOptions
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 15;
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;

  // 1. Check if port 3000 is already active and serving our application
  try {
    const probeRes = await sandbox.commands.run(
      'curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3000 || echo "000"',
      { timeoutMs: 3500 }
    );
    const probeStatus = (probeRes.stdout || "").trim();
    if (["200", "304", "302", "307", "308"].includes(probeStatus)) {
      return;
    }
  } catch {
    // Probe failed or timed out; continue to port clearance and fresh server start
  }

  // 2. Clear rogue processes holding port 3000
  try {
    await sandbox.commands.run(
      "fuser -k 3000/tcp 2>/dev/null || pkill -f 'next dev' || pkill -f 'bun.*dev' || true",
      { timeoutMs: 5000 }
    );
  } catch {
    // Non-fatal cleanup attempt
  }

  // 3. Start dev server in canonical workspace in the background
  const startCmd = `cd "${PROJECT_WORKSPACE_DIR}" && ` +
    `( [ -e node_modules ] || ( [ -d /home/user/node_modules ] && ln -s /home/user/node_modules node_modules ) || true ) && ` +
    `( [ -f next.config.mjs ] && rm -f next.config.ts next.config.js || true ) && ` +
    `(command -v bun >/dev/null 2>&1 && nohup bun run dev -- -H 0.0.0.0 -p 3000 > /tmp/preview.log 2>&1 & || nohup npm run dev -- -H 0.0.0.0 -p 3000 > /tmp/preview.log 2>&1 &)`;
  await sandbox.commands.run(startCmd, { timeoutMs: 6000 });

  // 4. Bounded independent polling
  let lastStatus = "000";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const pollRes = await sandbox.commands.run(
        'curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3000 || echo "000"',
        { timeoutMs: 3000 }
      );
      lastStatus = (pollRes.stdout || "").trim();
      if (["200", "304", "302", "307", "308"].includes(lastStatus)) {
        return;
      }
    } catch {
      // Individual poll timeout or network error; proceed to next attempt
    }
  }

  // 5. Readiness timeout: capture dev server log and report failure
  let logSnippet = "No preview log found";
  try {
    const logRes = await sandbox.commands.run("cat /tmp/preview.log 2>/dev/null | tail -n 40 || true", {
      timeoutMs: 4000,
    });
    logSnippet = logRes.stdout?.trim() || logSnippet;
  } catch {
    // Log read failure
  }

  throw new PreviewReadinessError(
    `Preview server failed to respond on port 3000 (status: ${lastStatus}) after ${maxAttempts} attempts. Dev log:\n${logSnippet}`,
    logSnippet
  );
}


