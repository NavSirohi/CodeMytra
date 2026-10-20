import path from "path";
import { Sandbox } from "@e2b/code-interpreter";
import {
  createAgent,
  createTool,
  createNetwork,
  createState,
} from "@inngest/agent-kit";
import { z } from "zod";
import { getOpenAIModel } from "@/server/providers/openai";
import {
  PRD,
  DesignSpec,
  ArchitectureSpec,
} from "@/server/agent-contracts/schemas";
import {
  PROJECT_WORKSPACE_DIR,
  resolveWorkspacePath,
} from "@/server/orchestration/workspace";
import {
  lastAssistantTextMessageContent,
} from "@/features/inngest/utils";
import { extractUsageMetadata } from "@/server/observability/metrics";
import {
  GENERATION_LIMITS,
  GenerationTimeoutError,
  RunAbortedError,
  TokenBudgetExceededError,
  NoProgressError,
  IterationLimitExceededError,
  getRemainingTimeMs,
  boundOperationTimeout,
} from "@/server/orchestration/stage-optimizer";
import { isRunActiveInDb } from "@/server/orchestration/finalization";
import { runWithoutStepContext } from "@/server/orchestration/async-context";

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
  promptTokens?: number;
  completionTokens?: number;
  hasUsage?: boolean;
  iterationCount?: number;
  filesWrittenCount?: number;
  wroteFilesInLastTurn?: boolean;
  consecutiveNoWriteTurns?: number;
  lastToolUsed?: string;
}

export interface CodingAgentResult {
  files: Record<string, string>;
  summary: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  modelId?: string;
}

export interface InngestStepLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: <T>(name: string, fn: () => Promise<T>) => Promise<any>;
}

export interface RunCodingAgentOptions {
  sandboxId: string;
  prompt: string;
  prd: PRD;
  designSpec: DesignSpec;
  architectureSpec: ArchitectureSpec;
  baseFiles?: Record<string, string> | null;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  step?: InngestStepLike;
  stepPrefix?: string;
  model?: string;
  generationRunId?: string;
  deadlineMs?: number;
  maxIterations?: number;
  tokenBudget?: number;
}

export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024; // 256 KB
export const MAX_COMMAND_TIMEOUT_MS = 30000; // 30s

export const FORBIDDEN_COMMAND_PATTERNS = [
  /\.env(\b|\.|$)/i,
  /\b(id_rsa|id_ecdsa|id_ed25519)\b/i,
  /\.pem\b/i,
  /\.key\b/i,
  /\/etc\/(shadow|gshadow|sudoers)/i,
  /\/proc\/(\d+|self)\/environ/i,
  /\bcd\s+(\.\.|\/|~)/i,
  /\.\.\//,
  /\b(curl|wget)\b.*(@|--upload-file|--post-file)/i,
];

/**
 * Application-level command guardrail.
 *
 * Security Architecture Note:
 * In accordance with defense-in-depth principles, pattern-based command filtering serves as
 * an application-level guardrail to intercept accidental environment/secret access or workspace
 * escaping. The isolated E2B microVM hypervisor container boundary provides the primary,
 * authoritative security barrier against malicious execution.
 */
export function validateSandboxCommand(command: string): { allowed: boolean; reason?: string } {
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Command blocked by security policy: contains restricted pattern "${pattern.source}". Direct access to platform secrets, environment files, or escaping project workspace is prohibited.`,
      };
    }
  }
  return { allowed: true };
}

export const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.(pem|key|secret|token)$/i,
  /id_rsa/i,
  /credentials\.json$/i,
];

export function isSensitiveFilePath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(base));
}

export interface BatchFileWriteTarget {
  path: string;
  content: string;
}

export interface SandboxFilesClient {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<unknown>;
  remove: (path: string) => Promise<unknown>;
}

export interface BatchFileWriteResult {
  success: boolean;
  filesWritten?: string[];
  count?: number;
  error?: string;
  failedFile?: string;
  rolledBack?: boolean;
  unrecoveredFilesystem?: boolean;
  updatedMap?: Record<string, string>;
}

/**
 * Executes a batch file write against sandbox files with pre-validation,
 * pre-write state snapshotting, sequential writes, and automated rollback upon write failure.
 */
export async function executeBatchFileWrites(
  filesClient: SandboxFilesClient,
  files: BatchFileWriteTarget[]
): Promise<BatchFileWriteResult> {
  // STEP 1: Pre-validation of incoming paths, duplicates, and file sizes
  const seenNormalizedPaths = new Set<string>();
  const validatedFiles: Array<{
    relativePath: string;
    fullWorkspacePath: string;
    content: string;
  }> = [];

  for (const file of files) {
    const normalizedRel = path.normalize(file.path).replace(/^(\.\/|\/)/, "");
    if (seenNormalizedPaths.has(normalizedRel)) {
      return {
        success: false,
        error: `Duplicate file path "${file.path}" in batch is forbidden. Each path must be unique.`,
        failedFile: file.path,
      };
    }
    seenNormalizedPaths.add(normalizedRel);

    // Path boundary validation
    let fullWorkspacePath: string;
    try {
      fullWorkspacePath = resolveWorkspacePath(file.path);
    } catch {
      return {
        success: false,
        error: `Path traversal forbidden: file "${file.path}" resolves outside project workspace.`,
        failedFile: file.path,
      };
    }

    // Sensitive file policy check
    if (isSensitiveFilePath(file.path)) {
      return {
        success: false,
        error: `Writing to sensitive file "${file.path}" is forbidden by security policy.`,
        failedFile: file.path,
      };
    }

    // Resource limit check per file (1 MB)
    const fileBytes = Buffer.byteLength(file.content || "", "utf8");
    if (fileBytes > 1024 * 1024) {
      return {
        success: false,
        error: `File "${file.path}" exceeds maximum size limit of 1 MB (${fileBytes} bytes).`,
        failedFile: file.path,
      };
    }

    validatedFiles.push({
      relativePath: file.path,
      fullWorkspacePath,
      content: file.content,
    });
  }

  // STEP 2: Capture pre-write state of every target file before any writes
  const preWriteStates: Array<{
    relativePath: string;
    fullWorkspacePath: string;
    content: string;
    existed: boolean;
    originalContent: string | null;
  }> = [];

  for (const vFile of validatedFiles) {
    let existed = false;
    let originalContent: string | null = null;
    try {
      existed = await filesClient.exists(vFile.fullWorkspacePath);
    } catch (existsErr) {
      return {
        success: false,
        error: `Pre-write existence check failed for "${vFile.relativePath}": ${existsErr instanceof Error ? existsErr.message : String(existsErr)}. Write batch aborted.`,
        failedFile: vFile.relativePath,
        unrecoveredFilesystem: false,
      };
    }

    if (existed) {
      try {
        originalContent = await filesClient.read(vFile.fullWorkspacePath);
      } catch (readErr) {
        // Do NOT interpret a failed pre-write read as a missing file.
        // Abort immediately before any writes occur to guarantee zero filesystem mutation.
        return {
          success: false,
          error: `Pre-write read failed for existing file "${vFile.relativePath}": ${readErr instanceof Error ? readErr.message : String(readErr)}. Write batch aborted to protect existing file.`,
          failedFile: vFile.relativePath,
          unrecoveredFilesystem: false,
        };
      }
    }

    preWriteStates.push({
      relativePath: vFile.relativePath,
      fullWorkspacePath: vFile.fullWorkspacePath,
      content: vFile.content,
      existed,
      originalContent,
    });
  }

  // STEP 3: Sequentially write files and track successful writes
  const successfullyWritten: Array<{
    relativePath: string;
    fullWorkspacePath: string;
    existed: boolean;
    originalContent: string | null;
  }> = [];

  for (const item of preWriteStates) {
    try {
      await filesClient.write(item.fullWorkspacePath, item.content);
      successfullyWritten.push(item);
    } catch (writeErr) {
      // A write failed!
      // Must include the failing write target `item` in rollback because the write may have partially changed its contents
      const rollbackTargets = [item, ...[...successfullyWritten].reverse()];
      const rollbackErrors: string[] = [];

      for (const target of rollbackTargets) {
        try {
          if (target.existed && target.originalContent !== null) {
            await filesClient.write(target.fullWorkspacePath, target.originalContent);
            // Verify rollback completed: file must exist and content must match originalContent
            const existsAfter = await filesClient.exists(target.fullWorkspacePath);
            if (!existsAfter) {
              rollbackErrors.push(
                `Rollback verification failed for "${target.relativePath}": file missing after restoration write.`
              );
              continue;
            }
            const contentAfter = await filesClient.read(target.fullWorkspacePath);
            if (contentAfter !== target.originalContent) {
              rollbackErrors.push(
                `Rollback verification failed for "${target.relativePath}": restored content does not match original.`
              );
            }
          } else {
            // Target was not pre-existing: remove any partial/created file
            await filesClient.remove(target.fullWorkspacePath);
            // Verify rollback completed: file must no longer exist
            const existsAfter = await filesClient.exists(target.fullWorkspacePath);
            if (existsAfter) {
              rollbackErrors.push(
                `Rollback verification failed for "${target.relativePath}": file still exists after removal.`
              );
            }
          }
        } catch (rbErr) {
          rollbackErrors.push(
            `Failed restoring "${target.relativePath}": ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`
          );
        }
      }

      if (rollbackErrors.length > 0) {
        return {
          success: false,
          error: `UNRECOVERED_FILESYSTEM_ERROR: Write failed on "${item.relativePath}" and rollback could not be verified:\n${rollbackErrors.join("\n")}`,
          failedFile: item.relativePath,
          unrecoveredFilesystem: true,
          rolledBack: false,
        };
      }

      return {
        success: false,
        error: `Write failed on "${item.relativePath}": ${writeErr instanceof Error ? writeErr.message : String(writeErr)}. All ${rollbackTargets.length} affected files were verified and restored to their original pre-write state.`,
        failedFile: item.relativePath,
        rolledBack: true,
        unrecoveredFilesystem: false,
      };
    }
  }

  // STEP 4: All writes succeeded without error
  const updatedMap = validatedFiles.reduce((acc, f) => {
    acc[f.relativePath] = f.content;
    return acc;
  }, {} as Record<string, string>);

  return {
    success: true,
    filesWritten: validatedFiles.map((f) => f.relativePath),
    count: validatedFiles.length,
    updatedMap,
  };
}

export interface CodingAgentResult {
  files: Record<string, string>;
  summary: string;
}

export class CodingAgentError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "CodingAgentError";
  }
}

/**
 * Builds the authoritative context prompt for the Implementation Agent,
 * embedding PRD, DesignSpec, ArchitectureSpec, and project rules.
 */
export function buildContextEnhancedPrompt(
  prd: PRD,
  designSpec: DesignSpec,
  archSpec: ArchitectureSpec
): string {
  const requiresDb = archSpec.requiresDatabase;

  return `
You are the Lead Full-Stack Code Implementation Agent for CodeMytra.
Build a complete, working, interactive Next.js application adhering strictly to the approved specifications.
All source files must reside in the project workspace (${PROJECT_WORKSPACE_DIR}).

=== APPROVED PRODUCT REQUIREMENTS ===
Project: ${prd.projectName || "CodeMytra Project"}
Summary: ${prd.summary || "Full-stack web application"}
Target Audience: ${prd.targetAudience || "General users"}
Capabilities: ${archSpec.capabilities?.join(", ") || prd.capabilities?.join(", ") || "pages-navigation"}
Requires Persistence: ${requiresDb ? "YES (isolated SQLite database)" : "NO (static / client state)"}

Pages to implement:
${(prd.pages || []).map((p) => `- ${p.route} (${p.title}): ${p.purpose} [Components: ${p.keyComponents?.join(", ") || "Main"}]`).join("\n") || "- / (Home): Main application page"}

Data Entities:
${prd.dataEntities?.length ? prd.dataEntities.map((e) => `- ${e.name} (persistent: ${e.isPersistent ? "YES" : "NO"}): fields=[${e.fields.join(", ")}], relationships=[${e.relationships?.join(", ") || "none"}]`).join("\n") : "None specified"}

User Flows:
${prd.userFlows?.length ? prd.userFlows.map((f) => `- ${f.name}: ${f.steps.join(" -> ")}`).join("\n") : "Standard user journey"}

=== DESIGN SPECIFICATION ===
Theme: ${designSpec.aestheticTheme || "Modern Clean"}
Primary: ${designSpec.colorPalette?.primary || "#2563eb"} | Secondary: ${designSpec.colorPalette?.secondary || "#475569"} | Surface: ${designSpec.colorPalette?.surface || "#ffffff"} | Text: ${designSpec.colorPalette?.text || "#0f172a"}
Font: ${designSpec.typography?.headingFont || "Inter"} / ${designSpec.typography?.bodyFont || "Inter"}
Layout: ${designSpec.layoutStyle || "Responsive single-page"}

=== ARCHITECTURE SPECIFICATION ===
Routes & Endpoints:
${(archSpec.routeEndpoints || []).map((r) => `- [${r.type.toUpperCase()}] ${r.path}: ${r.purpose}${r.methods ? ` (Methods: ${r.methods.join(", ")})` : ""}`).join("\n") || "- [PAGE] /: Main application entry point"}

${requiresDb ? `Database Models:
${archSpec.databaseModels?.length ? archSpec.databaseModels.map((m) => `- ${m.modelName} (${m.fields.join(", ")})${m.relations?.length ? ` [Relations: ${m.relations.join(", ")}]` : ""}`).join("\n") : "- Default entities"}
` : "Database Models: None required (static application)"}

Backend Operations & Validation:
${archSpec.backendOperations?.length ? archSpec.backendOperations.map((o) => `- ${o.name}: ${o.description} [Validation: ${o.validationRules.join("; ") || "Input required"}]`).join("\n") : "Standard Next.js route handlers"}

Business Constraints:
${archSpec.businessConstraints?.length ? archSpec.businessConstraints.map((c) => `- ${c}`).join("\n") : "Enforce data integrity and standard validation rules"}

File Boundaries:
- Frontend: ${archSpec.fileOwnership?.frontend?.join(", ") || "app/page.tsx, components/**"}
- Backend: ${archSpec.fileOwnership?.backend?.length ? archSpec.fileOwnership.backend.join(", ") : "None required for static app"}
- Database: ${requiresDb && archSpec.fileOwnership?.database ? archSpec.fileOwnership.database.join(", ") : "None required for static app"}

=== CRITICAL EXECUTION DIRECTIVES: DIRECT, FAST DELIVERY ===
1. IMMEDIATE BATCH WRITE: On your VERY FIRST action, call the "createOrUpdateFiles" tool to write ALL required components and pages (including "app/page.tsx", any sub-components, and styling updates) in a SINGLE complete batch.
2. NO EXPLORATORY ACTIONS: Do NOT call "readFiles" or "terminal" for preliminary reconnaissance. The foundation files (package.json, layout.tsx, Tailwind CSS, Lucide icons) are already established in the workspace (${PROJECT_WORKSPACE_DIR}).
3. NO MANUAL BUILD/TEST LOOPS: Do NOT execute "bun build", "next build", or "npm test" in the terminal. An isolated, automated QA pipeline verifies the build after you conclude.
4. IMMEDIATE COMPLETION: As soon as you write your files, conclude your response with a concise summary enclosed in <task_summary>...</task_summary> and finish.
5. If requiresDb is TRUE:
   - Provide "prisma/schema.prisma" with provider = "sqlite" and url = "file:./dev.db".
   - Provide "lib/db.ts" exporting an isolated SQLite PrismaClient instance.
   - Implement route handlers in app/api/**/route.ts with server-side validation.
   - Return appropriate HTTP status codes: 200/201 on success, 400 on validation errors, 404 on missing records, 409 on business conflicts.
   - Provide initial realistic seed data so preview works immediately.
6. If requiresDb is FALSE (static application / landing page):
   - Keep the app lean and fast. Do NOT generate unnecessary prisma schema, broken sqlite config, or backend database files.
   - Implement all rich interactive features (e.g. menus, product carts, interactive filters, contact forms) using React client state in "app/page.tsx" or modular components.
7. Put the primary landing content and user interface in app/page.tsx (use "use client"; for interactive state).
8. Use Tailwind CSS with clean, accessible classes matching the design token colors.
9. Do NOT import non-existent external npm packages. Use only standard React, Next.js, and Lucide icons.
10. When performing follow-up modifications, PRESERVE all existing working features while integrating requested additions.
`;
}

/**
 * Authoritative Implementation Engine for CodeMytra.
 * Shared by both the customer-facing Inngest workflow and standalone E2E runners.
 * Executes multi-turn tool calling (terminal, createOrUpdateFiles, readFiles) against the sandbox workspace.
 */
export async function runCodingAgent(
  options: RunCodingAgentOptions
): Promise<CodingAgentResult> {
  const {
    sandboxId,
    prompt,
    prd,
    designSpec,
    architectureSpec,
    baseFiles = {},
    previousMessages = [],
    step,
    stepPrefix = "code-agent",
    model,
    generationRunId,
    deadlineMs,
    maxIterations,
    tokenBudget,
  } = options;

  let toolCallCounter = 0;

  const runStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const stepId = `${stepPrefix}-${name}-${++toolCallCounter}`;
    if (step && typeof step.run === "function") {
      return (await step.run(stepId, fn)) as T;
    }
    return await fn();
  };

  const initialFiles: Record<string, string> = { ...(baseFiles || {}) };

  const state = createState<CodeAgentState>(
    {
      sandboxId,
      summary: "",
      files: initialFiles,
      iterationCount: 0,
      filesWrittenCount: 0,
      wroteFilesInLastTurn: false,
      consecutiveNoWriteTurns: 0,
    },
    {
      messages: previousMessages.map((m) => ({
        type: "text" as const,
        role: m.role,
        content: m.content,
      })),
    }
  );

  const selectedModel = model || (
    stepPrefix?.includes("repair")
      ? "gpt-4o"
      : "gpt-4o-mini"
  );

  const openAIModel = getOpenAIModel({
    model: selectedModel,
  });

  const systemPrompt = buildContextEnhancedPrompt(
    prd,
    designSpec,
    architectureSpec
  );

  const effectiveMaxIterations: number =
    maxIterations ||
    (stepPrefix?.includes("repair")
      ? (GENERATION_LIMITS.maxRepairIterations ?? 2)
      : (GENERATION_LIMITS.maxCodingIterations ?? 4));

  const effectiveTokenBudget: number =
    tokenBudget || (GENERATION_LIMITS.maxRunTokenBudget ?? 150000);

  const codeAgent = createAgent({
    name: "code-agent",
    description: "Authoritative full-stack implementation agent",
    system: systemPrompt,
    model: openAIModel,
    tools: [
      // 1. Terminal Tool (operates inside project workspace with strict security and output limits)
      createTool({
        name: "terminal",
        description: `Run allowed terminal commands inside the project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          command: z.string(),
        }),
        handler: async ({ command }, { network }) => {
          // Pre-execution deadline check
          if (deadlineMs && getRemainingTimeMs(deadlineMs) < 5000) {
            throw new GenerationTimeoutError(
              `Generation deadline exceeded before terminal execution.`,
              Date.now() - (deadlineMs - GENERATION_LIMITS.maxGenerationDurationMs),
              GENERATION_LIMITS.maxGenerationDurationMs
            );
          }
          // Pre-execution DB terminal status check
          if (generationRunId && !(await isRunActiveInDb(generationRunId))) {
            throw new RunAbortedError(
              `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
            );
          }
          // Token budget check
          if (effectiveTokenBudget && network?.state?.data) {
            const currentTokens = (network.state.data.promptTokens || 0) + (network.state.data.completionTokens || 0);
            if (currentTokens >= effectiveTokenBudget) {
              throw new TokenBudgetExceededError(
                `Token budget (${effectiveTokenBudget} tokens) exceeded. Halting command execution.`,
                currentTokens,
                effectiveTokenBudget
              );
            }
          }
          if (network?.state?.data) {
            network.state.data.lastToolUsed = "terminal";
            network.state.data.wroteFilesInLastTurn = false;
          }

          // Pre-execution security check (defense-in-depth)
          const secCheck = validateSandboxCommand(command);
          if (!secCheck.allowed) {
            return JSON.stringify({
              success: false,
              exitCode: 126,
              stdout: "",
              stderr: secCheck.reason || "Command blocked by security policy.",
              error: "COMMAND_SECURITY_BLOCKED",
            });
          }

          const commandTimeout = deadlineMs
            ? boundOperationTimeout(deadlineMs, MAX_COMMAND_TIMEOUT_MS, 5000, "terminal command")
            : MAX_COMMAND_TIMEOUT_MS;

          return await runStep("terminal", async () => {
            let stdout = "";
            let stderr = "";
            try {
              const sandbox = await Sandbox.connect(sandboxId);
              // Ensure commands execute inside the project workspace
              const wrappedCommand = `cd "${PROJECT_WORKSPACE_DIR}" && ${command}`;
              const result = await sandbox.commands.run(wrappedCommand, {
                onStdout: (data) => {
                  if (stdout.length < MAX_COMMAND_OUTPUT_BYTES) {
                    stdout += data;
                  }
                },
                onStderr: (data) => {
                  if (stderr.length < MAX_COMMAND_OUTPUT_BYTES) {
                    stderr += data;
                  }
                },
                timeoutMs: commandTimeout,
              });

              const exitCode = result.exitCode ?? 0;
              const cleanStdout = (result.stdout || stdout || "").slice(0, MAX_COMMAND_OUTPUT_BYTES);
              const cleanStderr = (result.stderr || stderr || "").slice(0, MAX_COMMAND_OUTPUT_BYTES);

              return JSON.stringify({
                success: exitCode === 0,
                exitCode,
                stdout: cleanStdout,
                stderr: cleanStderr,
              });
            } catch (error) {
              return JSON.stringify({
                success: false,
                exitCode: 1,
                stdout: stdout.slice(0, MAX_COMMAND_OUTPUT_BYTES),
                stderr: stderr.slice(0, MAX_COMMAND_OUTPUT_BYTES),
                error: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          });
        },
      }),

      // 2. createOrUpdateFiles Tool (pre-validates entire batch before writing to avoid partial corruptions)
      createTool({
        name: "createOrUpdateFiles",
        description: `Create or update files in the sandbox project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          files: z.array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          ).min(1).max(50),
        }),
        handler: async ({ files }, { network }) => {
          // Pre-execution deadline check
          if (deadlineMs && getRemainingTimeMs(deadlineMs) < 5000) {
            throw new GenerationTimeoutError(
              `Generation deadline exceeded before file creation.`,
              Date.now() - (deadlineMs - GENERATION_LIMITS.maxGenerationDurationMs),
              GENERATION_LIMITS.maxGenerationDurationMs
            );
          }
          // Pre-execution DB terminal status check
          if (generationRunId && !(await isRunActiveInDb(generationRunId))) {
            throw new RunAbortedError(
              `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
            );
          }
          // Token budget check
          if (effectiveTokenBudget && network?.state?.data) {
            const currentTokens = (network.state.data.promptTokens || 0) + (network.state.data.completionTokens || 0);
            if (currentTokens >= effectiveTokenBudget) {
              throw new TokenBudgetExceededError(
                `Token budget (${effectiveTokenBudget} tokens) exceeded. Halting file write execution.`,
                currentTokens,
                effectiveTokenBudget
              );
            }
          }
          if (network?.state?.data) {
            network.state.data.lastToolUsed = "createOrUpdateFiles";
          }

          let sandbox: Sandbox;
          try {
            sandbox = await Sandbox.connect(sandboxId);
          } catch (connErr) {
            return JSON.stringify({
              success: false,
              error: `Sandbox connection failed: ${connErr instanceof Error ? connErr.message : String(connErr)}`,
            });
          }

          const stepResult = await runStep("createOrUpdateFiles", async () => {
            return await executeBatchFileWrites(sandbox.files, files);
          });

          // Stop generation when rollback cannot be guaranteed
          if (stepResult.unrecoveredFilesystem) {
            throw new CodingAgentError(
              `UNRECOVERED_FILESYSTEM_ERROR: File rollback could not be guaranteed after failure on "${stepResult.failedFile}". Generation stopped to prevent corruption. Details: ${stepResult.error}`
            );
          }

          // Only mutate network state if the entire batch write succeeded
          if (stepResult.success && stepResult.updatedMap && network?.state?.data) {
            network.state.data.files = {
              ...(network.state.data.files || initialFiles),
              ...stepResult.updatedMap,
            };
            network.state.data.filesWrittenCount =
              (network.state.data.filesWrittenCount || 0) + (stepResult.count || 0);
            network.state.data.wroteFilesInLastTurn = true;
            network.state.data.consecutiveNoWriteTurns = 0;
          }

          return JSON.stringify({
            success: stepResult.success,
            filesWritten: stepResult.filesWritten,
            count: stepResult.count,
            error: stepResult.error,
            failedFile: stepResult.failedFile,
            rolledBack: stepResult.rolledBack,
            unrecoveredFilesystem: stepResult.unrecoveredFilesystem,
          });
        },
      }),

      // 3. readFiles Tool (reads from project workspace with secrets protection and structured results)
      createTool({
        name: "readFiles",
        description: `Read files from the sandbox project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          files: z.array(z.string()).min(1).max(20),
        }),
        handler: async ({ files }, { network }) => {
          // Pre-execution deadline check
          if (deadlineMs && getRemainingTimeMs(deadlineMs) < 5000) {
            throw new GenerationTimeoutError(
              `Generation deadline exceeded before reading files.`,
              Date.now() - (deadlineMs - GENERATION_LIMITS.maxGenerationDurationMs),
              GENERATION_LIMITS.maxGenerationDurationMs
            );
          }
          // Pre-execution DB terminal status check
          if (generationRunId && !(await isRunActiveInDb(generationRunId))) {
            throw new RunAbortedError(
              `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
            );
          }
          if (network?.state?.data) {
            network.state.data.lastToolUsed = "readFiles";
            network.state.data.wroteFilesInLastTurn = false;
          }

          return await runStep("readFiles", async () => {
            // Pre-validate all requested paths
            for (const filePath of files) {
              if (isSensitiveFilePath(filePath)) {
                return JSON.stringify({
                  success: false,
                  error: `Reading sensitive file "${filePath}" is forbidden by security policy.`,
                  failedFile: filePath,
                });
              }
              try {
                resolveWorkspacePath(filePath);
              } catch {
                return JSON.stringify({
                  success: false,
                  error: `Path traversal forbidden: file "${filePath}" resolves outside project workspace.`,
                  failedFile: filePath,
                });
              }
            }

            try {
              const sandbox = await Sandbox.connect(sandboxId);
              const contents: Array<{ path: string; content: string }> = [];

              for (const filePath of files) {
                const fullWorkspacePath = resolveWorkspacePath(filePath);
                let content = await sandbox.files.read(fullWorkspacePath);
                if (typeof content === "string" && content.length > 1024 * 1024) {
                  content =
                    content.slice(0, 1024 * 1024) + "\n... [Content truncated at 1 MB]";
                }
                contents.push({
                  path: filePath,
                  content: typeof content === "string" ? content : "",
                });
              }

              return JSON.stringify({
                success: true,
                files: contents,
                count: contents.length,
              });
            } catch (error) {
              return JSON.stringify({
                success: false,
                error: `Error reading files: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          });
        },
      }),
    ],

    lifecycle: {
      onResponse: async ({ result, network }) => {
        const lastText = lastAssistantTextMessageContent(result);
        if (lastText && network?.state?.data) {
          if (lastText.includes("<task_summary>")) {
            network.state.data.summary = lastText;
          } else if ((network.state.data.filesWrittenCount || 0) > 0) {
            // Fast path: if files have already been written and assistant emitted text,
            // capture it as the task summary even if the tag was omitted.
            network.state.data.summary = `<task_summary>${lastText.trim()}</task_summary>`;
          }
        }
        const stepUsage = extractUsageMetadata(result);
        if (stepUsage && network?.state?.data) {
          network.state.data.promptTokens = (network.state.data.promptTokens || 0) + (stepUsage.promptTokens || 0);
          network.state.data.completionTokens = (network.state.data.completionTokens || 0) + (stepUsage.completionTokens || 0);
          network.state.data.hasUsage = true;
        }

        // Track non-writing turns
        if (network?.state?.data) {
          if (!network.state.data.wroteFilesInLastTurn) {
            network.state.data.consecutiveNoWriteTurns =
              (network.state.data.consecutiveNoWriteTurns || 0) + 1;
          }
          // Reset wroteFilesInLastTurn flag for the next cycle
          network.state.data.wroteFilesInLastTurn = false;
        }
        return result;
      },
    },
  });

  const network = createNetwork({
    name: "code-agent-network",
    agents: [codeAgent],
    maxIter: effectiveMaxIterations,
    router: async ({ network }) => {
      // 1. If summary is set, we are finished!
      if (network.state.data.summary) {
        return undefined;
      }

      // 2. Mid-flight DB terminal check: stop immediately if run was failed/cancelled in DB
      if (generationRunId) {
        const active = await isRunActiveInDb(generationRunId);
        if (!active) {
          throw new RunAbortedError(
            `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
          );
        }
      }

      // 3. Mid-flight deadline check
      if (deadlineMs) {
        const remaining = getRemainingTimeMs(deadlineMs);
        if (remaining < 5000) {
          throw new GenerationTimeoutError(
            `Generation deadline exceeded during coding (${remaining}ms remaining). Halting further turns.`,
            GENERATION_LIMITS.maxGenerationDurationMs - remaining,
            GENERATION_LIMITS.maxGenerationDurationMs
          );
        }
      }

      // 4. Token budget check
      const currentTokens =
        (network.state.data.promptTokens || 0) +
        (network.state.data.completionTokens || 0);
      if (effectiveTokenBudget && currentTokens >= effectiveTokenBudget) {
        throw new TokenBudgetExceededError(
          `Token budget (${effectiveTokenBudget} tokens) exceeded during coding. Current usage: ${currentTokens} tokens.`,
          currentTokens,
          effectiveTokenBudget
        );
      }

      // 5. Track iteration count and enforce hard bound
      const iter = (network.state.data.iterationCount || 0) + 1;
      network.state.data.iterationCount = iter;
      if (iter >= effectiveMaxIterations) {
        if ((network.state.data.filesWrittenCount || 0) > 0) {
          return undefined;
        }
        throw new IterationLimitExceededError(
          `Coding agent reached maximum iteration limit (${effectiveMaxIterations}) without producing valid files.`,
          iter,
          effectiveMaxIterations
        );
      }

      // 6. Fast Path Completion:
      // If the agent already wrote files on a previous turn and did not write files on the latest turn:
      // it has concluded its work! Stop immediately!
      if (
        (network.state.data.filesWrittenCount || 0) > 0 &&
        !network.state.data.wroteFilesInLastTurn
      ) {
        return undefined;
      }

      // 7. No-Progress Rule:
      // If the agent has run 2 consecutive non-writing turns without producing any files:
      if (
        (network.state.data.consecutiveNoWriteTurns || 0) >= 2 &&
        (network.state.data.filesWrittenCount || 0) === 0
      ) {
        throw new NoProgressError(
          `Coding agent halted: 2 consecutive turns without creating or updating files.`,
          network.state.data.consecutiveNoWriteTurns
        );
      }

      return codeAgent;
    },
  });

  const result = await runWithoutStepContext(() =>
    network.run(prompt, { state })
  );
  const finalSummaryRaw = result.state.data.summary || "";
  const finalFiles = result.state.data.files || initialFiles;

  let cleanedSummary = finalSummaryRaw;
  const match = finalSummaryRaw.match(/<task_summary>([\s\S]*?)<\/task_summary>/);
  if (match) {
    cleanedSummary = match[1].trim();
  } else if (!cleanedSummary) {
    cleanedSummary = `Built ${prd.projectName} with ${Object.keys(finalFiles).length} files adhering to approved PRD and design guidelines.`;
  }

  const networkUsage = extractUsageMetadata(result);
  let finalUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

  if (result.state.data.hasUsage) {
    const pt = result.state.data.promptTokens || 0;
    const ct = result.state.data.completionTokens || 0;
    finalUsage = {
      promptTokens: pt,
      completionTokens: ct,
      totalTokens: pt + ct,
    };
  } else if (networkUsage) {
    finalUsage = networkUsage;
  }

  return {
    files: finalFiles,
    summary: cleanedSummary,
    usage: finalUsage,
    modelId: selectedModel,
  };
}
