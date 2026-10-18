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
  `;

  const res = await sandbox.commands.run(initScript, { timeoutMs: 15000 });
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to initialize sandbox workspace at ${PROJECT_WORKSPACE_DIR}: ${res.stderr || res.stdout}`
    );
  }
}
