import { PRD, DesignSpec, ArchitectureSpec } from "@/server/agent-contracts/schemas";
import { OpenAIModelTier } from "@/server/providers/openai";
import { ModelPreference } from "@/lib/models";

/**
 * Configurable generation limits to prevent runaway loops and runaway costs.
 */
export interface GenerationLimits {
  maxRepairAttempts: number;
  maxGenerationDurationMs: number;
  maxConcurrentRunsPerUser: number;
  maxInputFilesForContext: number;
  maxCodingIterations?: number;
  maxRepairIterations?: number;
  maxRunTokenBudget?: number;
}

export const GENERATION_LIMITS: GenerationLimits = {
  maxRepairAttempts: Math.max(1, parseInt(process.env.MAX_REPAIR_ATTEMPTS || "2", 10)),
  maxGenerationDurationMs: Math.max(30000, parseInt(process.env.MAX_GENERATION_DURATION_MS || "300000", 10)), // 5 mins
  maxConcurrentRunsPerUser: Math.max(1, parseInt(process.env.MAX_CONCURRENT_RUNS_PER_USER || "3", 10)),
  maxInputFilesForContext: Math.max(5, parseInt(process.env.MAX_INPUT_FILES_FOR_CONTEXT || "30", 10)),
  maxCodingIterations: Math.max(1, parseInt(process.env.MAX_CODING_ITERATIONS || "4", 10)),
  maxRepairIterations: Math.max(1, parseInt(process.env.MAX_REPAIR_ITERATIONS || "2", 10)),
  maxRunTokenBudget: Math.max(10000, parseInt(process.env.MAX_RUN_TOKEN_BUDGET || "150000", 10)),
};

export class RunAbortedError extends Error {
  constructor(message: string, public readonly status?: string) {
    super(message);
    this.name = "RunAbortedError";
  }
}

export class TokenBudgetExceededError extends Error {
  constructor(message: string, public readonly tokensUsed?: number, public readonly tokenBudget?: number) {
    super(message);
    this.name = "TokenBudgetExceededError";
  }
}

export class NoProgressError extends Error {
  constructor(message: string, public readonly consecutiveTurns?: number) {
    super(message);
    this.name = "NoProgressError";
  }
}

export class IterationLimitExceededError extends Error {
  constructor(message: string, public readonly iterations?: number, public readonly maxIterations?: number) {
    super(message);
    this.name = "IterationLimitExceededError";
  }
}

export interface SelectModelOptions {
  isComplexFullstack?: boolean;
  isRepairAttempt?: boolean;
  modelPreference?: ModelPreference | string;
}

/**
 * Strategy for selecting economical vs capable OpenAI models based on stage, complexity,
 * and user-selected model preference.
 */
export function selectModelForStage(
  stage: "planning" | "design" | "architecture" | "coding" | "repair",
  options?: SelectModelOptions
): OpenAIModelTier {
  // Explicit user preference overrides adaptive routing
  if (options?.modelPreference === "gpt-4o") {
    return "gpt-4o";
  }
  if (options?.modelPreference === "gpt-4o-mini") {
    return "gpt-4o-mini";
  }

  // Default / "auto" adaptive model routing:
  // Economical model by default for fast, lightweight stages
  if (stage === "design") {
    return "gpt-4o-mini";
  }
  if (stage === "planning") {
    return options?.isComplexFullstack ? "gpt-4o" : "gpt-4o-mini";
  }
  // Escalate to GPT-4o for complex architecture decisions or after a verification failure in repair
  if (stage === "architecture" || (stage === "repair" && options?.isRepairAttempt)) {
    return "gpt-4o";
  }
  if (stage === "coding") {
    return options?.isComplexFullstack ? "gpt-4o" : "gpt-4o-mini";
  }
  return "gpt-4o-mini";
}

export class GenerationTimeoutError extends Error {
  constructor(
    message: string,
    public readonly durationMs: number,
    public readonly limitMs: number
  ) {
    super(message);
    this.name = "GenerationTimeoutError";
  }
}

/**
 * Persisted Run Deadline & Timeout Context.
 *
 * NOTE ON EXTERNAL PROVIDER NON-PREEMPTIVE CANCELLATION:
 * External AI providers (e.g. OpenAI API via HTTP/SDK) and sandbox subprocesses
 * (e.g. npm install, next build inside E2B container) execute out-of-process.
 * Standard cloud SDKs and child-process wrappers cannot be preemptively interrupted mid-flight
 * without aborting underlying TCP sockets or killing entire containers.
 *
 * Timeout semantics in CodeMytra are therefore cooperative:
 * 1. Deadlines are established from persisted run start timestamps (startedAt/createdAt) so retries
 *    do not reset the allowed budget.
 * 2. Stage boundaries and loop iterations check remaining time via `checkGenerationDeadline`.
 * 3. Out-of-process calls are passed bounded timeouts via `boundOperationTimeout`.
 * 4. Once an external call completes or fails, if the overall run deadline has passed,
 *    subsequent work/repairs are aborted immediately, the run is finalized with
 *    errorCode "GENERATION_TIMEOUT", and existing project revisions are strictly preserved.
 */
export interface RunDeadlineContext {
  startedAtMs: number;
  deadlineMs: number;
  maxDurationMs: number;
}

/**
 * Establishes a deterministic deadline from a persisted database timestamp (startedAt or createdAt).
 * Preserves the overall deadline across Inngest step retries and prevents retries from resetting the clock.
 */
export function establishRunDeadline(
  startedAtOrCreatedAt: Date | number,
  maxDurationMs: number = GENERATION_LIMITS.maxGenerationDurationMs
): RunDeadlineContext {
  const startedAtMs =
    startedAtOrCreatedAt instanceof Date
      ? startedAtOrCreatedAt.getTime()
      : typeof startedAtOrCreatedAt === "number"
      ? startedAtOrCreatedAt
      : Date.now();

  return {
    startedAtMs,
    deadlineMs: startedAtMs + maxDurationMs,
    maxDurationMs,
  };
}

/**
 * Returns remaining milliseconds before the deadline expires, floored at 0.
 */
export function getRemainingTimeMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

/**
 * Returns true if the deadline has passed.
 */
export function isPastDeadline(deadlineMs: number): boolean {
  return Date.now() >= deadlineMs;
}

/**
 * Validates that the generation has not exceeded its persisted deadline.
 * Throws GenerationTimeoutError if expired.
 */
export function checkGenerationDeadline(
  deadlineMs: number,
  stageName: string,
  maxDurationMs: number = GENERATION_LIMITS.maxGenerationDurationMs
): void {
  const remaining = getRemainingTimeMs(deadlineMs);
  if (remaining <= 0) {
    const elapsedMs = maxDurationMs + (Date.now() - deadlineMs);
    throw new GenerationTimeoutError(
      `Generation timed out before stage "${stageName}": elapsed ${elapsedMs}ms exceeds limit of ${maxDurationMs}ms`,
      elapsedMs,
      maxDurationMs
    );
  }
}

/**
 * Bounds an individual operation timeout (e.g. sandbox command or SDK call)
 * so it never requests more time than remaining before the run deadline.
 * Throws GenerationTimeoutError if insufficient budget (< minFloorMs) remains.
 */
export function boundOperationTimeout(
  deadlineMs: number,
  maxOperationTimeoutMs: number,
  minFloorMs = 5000,
  stageName = "operation"
): number {
  const remainingMs = getRemainingTimeMs(deadlineMs);
  if (remainingMs < minFloorMs) {
    throw new GenerationTimeoutError(
      `Generation timed out: insufficient budget (${remainingMs}ms < ${minFloorMs}ms) for ${stageName}`,
      GENERATION_LIMITS.maxGenerationDurationMs - remainingMs,
      GENERATION_LIMITS.maxGenerationDurationMs
    );
  }
  return Math.min(maxOperationTimeoutMs, remainingMs);
}

/**
 * Checks whether the current generation run has exceeded its maximum configured duration.
 * Kept for backward compatibility.
 */
export function checkGenerationTimeout(
  startedAtMs: number,
  stageName: string,
  limits: GenerationLimits = GENERATION_LIMITS
): void {
  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs > limits.maxGenerationDurationMs) {
    throw new GenerationTimeoutError(
      `Generation timed out before stage "${stageName}": elapsed ${elapsedMs}ms exceeds limit of ${limits.maxGenerationDurationMs}ms`,
      elapsedMs,
      limits.maxGenerationDurationMs
    );
  }
}

/**
 * Task 3: Conservative fast-path check.
 * Only allow obvious cosmetic modifications to reuse existing planning and architecture specifications.
 * Backend, database, authentication, authorization, payment, API, business-rule and ambiguous changes
 * MUST take the full planning path.
 *
 * Never bypasses QA or revision persistence.
 */
export function canBypassPlanningAndArchitecture(
  prompt: string,
  existingSpecs: {
    prd?: PRD | null;
    designSpec?: DesignSpec | null;
    architectureSpec?: ArchitectureSpec | null;
  }
): { canBypass: boolean; reason: string } {
  if (!existingSpecs.prd || !existingSpecs.architectureSpec) {
    return { canBypass: false, reason: "Missing existing approved specifications" };
  }

  const p = prompt.toLowerCase().trim();

  // 1. Strict Non-Cosmetic Rejection Triggers:
  // If prompt matches ANY backend, database, auth, permission, payment, API, business rule, notification,
  // storage, submission, data retrieval, or filtering operation:
  const nonCosmeticPatterns = [
    // Database & data operations
    /\b(database|db|prisma|sqlite|sql|postgres|table|schema|migration|seed)\b/,
    /\b(model|models|entity|entities|record|records)\b/,
    /\b(delete|deletes|deleted|deleting|remove|destroy|insert|create\s+record|update\s+record)\b/,
    /\b(customer|customers|user\s+account|user\s+records)\b/,
    // Data storage, persistence & form submissions
    /\b(store|stores|stored|storing|storage|submit|submits|submitted|submitting|submission|submissions)\b/,
    /\b(retrieve|retrieves|retrieving|retrieval|query|queries|fetch|fetching)\b/,
    /\b(form|forms|contact-form|lead|leads|collect|collection)\b/,
    // Dynamic filtering, search & pagination
    /\b(filter|filters|filtering|search|searching|sort|sorting|paginate|pagination)\b/,
    // Notifications & messaging
    /\b(email|emails|notification|notifications|notify|notifying|message|messages|messaging|sms|alert|alerts)\b/,
    // Authentication & authorization
    /\b(auth|authentication|authenticate|login|logout|signin|signup|sign\s+in|sign\s+up|register)\b/,
    /\b(admin|permission|permissions|role|roles|rbac|privilege|credential|session|jwt|token|access\s+control)\b/,
    // Payment & billing
    /\b(payment|payments|pay|stripe|billing|invoice|checkout|subscription|charge|credit)\b/,
    // API & backend endpoints
    /\b(api|apis|endpoint|endpoints|backend|server\s+action|server-side|route\s+handler|webhook|graphql|rest)\b/,
    // Business rules & workflow logic
    /\b(order|orders|order-processing|processing|behaviour|behavior|business\s*rule|workflow|algorithm)\b/,
    /\b(cart|inventory|stock|booking\s+conflict|pricing\s+rule|discount|status\s+transition)\b/,
    // Structural routing changes
    /\b(new\s+page|add\s+page|delete\s+page|remove\s+page|new\s+route|subdomain)\b/,
  ];

  for (const pattern of nonCosmeticPatterns) {
    if (pattern.test(p)) {
      return {
        canBypass: false,
        reason: "Prompt involves structural, database, security, backend, or business-logic modifications requiring full planning",
      };
    }
  }

  // 2. Strict Cosmetic Acceptance Criteria:
  // Must match purely surface styling, typography, copy/text, or visual theme alterations
  const cosmeticPatterns = [
    /\b(colour|color|colors|colours|palette|theme|dark\s+mode|light\s+mode)\b/,
    /\b(heading|subtitle|title|text|copy|caption|placeholder|label)\b/,
    /\b(font|fonts|typography|size|line-height|letter-spacing)\b/,
    /\b(padding|margin|gap|spacing|alignment|center|justify)\b/,
    /\b(hero\s+heading|hero\s+section\s+color|hero\s+colour|hero\s+color|background|surface\s+color|border|shadow|rounded|radius)\b/,
  ];

  const isExplicitlyCosmetic = cosmeticPatterns.some((pattern) => pattern.test(p));

  if (!isExplicitlyCosmetic) {
    return {
      canBypass: false,
      reason: "Prompt does not qualify as an unambiguous cosmetic modification; taking full planning path",
    };
  }

  return {
    canBypass: true,
    reason: "Unambiguous cosmetic UI/styling modification safely reuses approved specifications",
  };
}

/**
 * Resolves imported dependencies from source file contents.
 * Looks for `import ... from '...'` statements and matches relative (`./`, `../`)
 * or alias (`@/`) imports to file keys in the project.
 */
function extractImportedPaths(sourceContent: string, currentFilePath: string, allFileKeys: string[]): string[] {
  const matches: string[] = [];
  const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceContent)) !== null) {
    const importPath = match[1];
    // Skip third-party packages (node_modules like react, next, zod, lucide-react, etc.)
    if (!importPath.startsWith(".") && !importPath.startsWith("@/")) {
      continue;
    }

    const normalized = importPath;
    if (normalized.startsWith("@/")) {
      // Alias `@/` -> search for matching `src/...` or root `...`
      const relativePart = normalized.slice(2);
      for (const key of allFileKeys) {
        const withoutExt = key.replace(/\.(tsx?|jsx?|json|css)$/, "");
        if (
          withoutExt === relativePart ||
          withoutExt === `src/${relativePart}` ||
          key === relativePart ||
          key === `src/${relativePart}`
        ) {
          matches.push(key);
        }
      }
    } else if (normalized.startsWith(".")) {
      // Relative import: resolve relative to currentFilePath directory
      const currentDir = currentFilePath.split("/").slice(0, -1).join("/");
      const parts = `${currentDir}/${normalized}`.split("/");
      const resolvedStack: string[] = [];
      for (const part of parts) {
        if (!part || part === ".") continue;
        if (part === "..") {
          resolvedStack.pop();
        } else {
          resolvedStack.push(part);
        }
      }
      const resolvedBase = resolvedStack.join("/");
      for (const key of allFileKeys) {
        const withoutExt = key.replace(/\.(tsx?|jsx?|json|css)$/, "");
        if (withoutExt === resolvedBase || key === resolvedBase) {
          matches.push(key);
        }
      }
    }
  }

  return matches;
}

/**
 * Task 4: Context window optimization:
 * - Keeps the complete project filesystem intact in E2B (handled by caller).
 * - Only reduces the initial source context passed to the model.
 * - Includes relevant imported dependencies where practical.
 * - Respects the configured context budget (limits.maxInputFilesForContext).
 */
export function filterRelevantFiles(
  files: Record<string, string>,
  prompt: string,
  limits = GENERATION_LIMITS
): Record<string, string> {
  const fileKeys = Object.keys(files);
  const budget = limits.maxInputFilesForContext;

  if (fileKeys.length <= budget) {
    return files;
  }

  const p = prompt.toLowerCase();
  const filtered: Record<string, string> = {};

  const addFile = (key: string): boolean => {
    if (filtered[key]) return true; // already included, continue processing
    if (Object.keys(filtered).length >= budget) return false; // budget exhausted
    if (files[key] !== undefined) {
      filtered[key] = files[key];
      return true;
    }
    return true;
  };

  // 1. Core essential files always included
  const essentialSuffixes = [
    "package.json",
    "app/page.tsx",
    "src/app/page.tsx",
    "app/layout.tsx",
    "src/app/layout.tsx",
    "app/globals.css",
    "src/app/globals.css",
  ];

  for (const key of fileKeys) {
    if (essentialSuffixes.some((suffix) => key.endsWith(suffix) || key === suffix)) {
      addFile(key);
    }
  }

  // 2. Identify target files mentioned directly in prompt (component name, route, etc.)
  for (const key of fileKeys) {
    const baseName = key.split("/").pop()?.replace(/\.[^/.]+$/, "").toLowerCase();
    if (baseName && baseName.length > 2 && p.includes(baseName)) {
      addFile(key);
    }
  }

  // 3. Dependency resolution: include imported dependencies of included files where practical
  const keysToInspect = Object.keys(filtered);
  for (const currentKey of keysToInspect) {
    const content = files[currentKey];
    if (!content) continue;
    const importedKeys = extractImportedPaths(content, currentKey, fileKeys);
    for (const importedKey of importedKeys) {
      if (!addFile(importedKey)) break;
    }
  }

  // 4. Fill remaining budget with top-level app files if budget allows
  if (Object.keys(filtered).length < 5) {
    for (const key of fileKeys) {
      if (!filtered[key] && !key.includes(".next") && !key.includes("node_modules")) {
        if (!addFile(key)) break;
      }
    }
  }

  return filtered;
}
