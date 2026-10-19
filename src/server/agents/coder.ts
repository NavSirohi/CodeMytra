import path from "path";
import { Sandbox } from "@e2b/code-interpreter";
import {
  createAgent,
  createTool,
  createNetwork,
  createState,
} from "@inngest/agent-kit";
import { z } from "zod";
import { getGeminiModel } from "@/server/providers/gemini";
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

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
  promptTokens?: number;
  completionTokens?: number;
  hasUsage?: boolean;
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
Project: ${prd.projectName}
Summary: ${prd.summary}
Target Audience: ${prd.targetAudience}
Capabilities: ${archSpec.capabilities?.join(", ") || prd.capabilities?.join(", ") || "pages-navigation"}
Requires Persistence: ${requiresDb ? "YES (isolated SQLite database)" : "NO (static / client state)"}

Pages to implement:
${prd.pages.map((p) => `- ${p.route} (${p.title}): ${p.purpose} [Components: ${p.keyComponents?.join(", ") || "Main"}]`).join("\n")}

Data Entities:
${prd.dataEntities?.length ? prd.dataEntities.map((e) => `- ${e.name} (persistent: ${e.isPersistent ? "YES" : "NO"}): fields=[${e.fields.join(", ")}], relationships=[${e.relationships?.join(", ") || "none"}]`).join("\n") : "None specified"}

User Flows:
${prd.userFlows?.length ? prd.userFlows.map((f) => `- ${f.name}: ${f.steps.join(" -> ")}`).join("\n") : "Standard user journey"}

=== DESIGN SPECIFICATION ===
Theme: ${designSpec.aestheticTheme}
Primary: ${designSpec.colorPalette.primary} | Secondary: ${designSpec.colorPalette.secondary} | Surface: ${designSpec.colorPalette.surface} | Text: ${designSpec.colorPalette.text}
Font: ${designSpec.typography.headingFont} / ${designSpec.typography.bodyFont}
Layout: ${designSpec.layoutStyle}

=== ARCHITECTURE SPECIFICATION ===
Routes & Endpoints:
${archSpec.routeEndpoints.map((r) => `- [${r.type.toUpperCase()}] ${r.path}: ${r.purpose}${r.methods ? ` (Methods: ${r.methods.join(", ")})` : ""}`).join("\n")}

${requiresDb ? `Database Models:
${archSpec.databaseModels?.length ? archSpec.databaseModels.map((m) => `- ${m.modelName} (${m.fields.join(", ")})${m.relations?.length ? ` [Relations: ${m.relations.join(", ")}]` : ""}`).join("\n") : "- Default entities"}
` : "Database Models: None required (static application)"}

Backend Operations & Validation:
${archSpec.backendOperations?.length ? archSpec.backendOperations.map((o) => `- ${o.name}: ${o.description} [Validation: ${o.validationRules.join("; ") || "Input required"}]`).join("\n") : "Standard Next.js route handlers"}

Business Constraints:
${archSpec.businessConstraints?.length ? archSpec.businessConstraints.map((c) => `- ${c}`).join("\n") : "Enforce data integrity and standard validation rules"}

File Boundaries:
- Frontend: ${archSpec.fileOwnership.frontend.join(", ")}
- Backend: ${archSpec.fileOwnership.backend.length > 0 ? archSpec.fileOwnership.backend.join(", ") : "None required for static app"}
- Database: ${requiresDb ? archSpec.fileOwnership.database.join(", ") : "None required for static app"}

=== FULL-STACK IMPLEMENTATION RULES ===
1. Use the "createOrUpdateFiles" tool to write clean, complete, working React/Next.js components.
2. Put the primary landing content and user interface in app/page.tsx (use "use client"; for interactive state).
3. If requiresDb is TRUE:
   - Provide "prisma/schema.prisma" with provider = "sqlite" and url = "file:./dev.db".
   - Provide "lib/db.ts" exporting an isolated SQLite PrismaClient instance.
   - Implement route handlers in app/api/**/route.ts with server-side validation.
   - Return appropriate HTTP status codes: 200/201 on success, 400 on validation errors, 404 on missing records, 409 on business conflicts (e.g., overlapping bookings or insufficient inventory).
   - Provide initial realistic seed data so preview works immediately.
4. If requiresDb is FALSE (static application):
   - Keep the app lean and clean. Do NOT generate unnecessary prisma schema, broken sqlite config, or backend database files.
   - Use client-side React state for interactive features (e.g. contact forms, interactive calculators, search filtering over static data).
5. Use Tailwind CSS with clean, accessible classes matching the design token colors.
6. Do NOT import non-existent external npm packages.
7. When performing follow-up modifications, PRESERVE all existing working features while integrating requested additions.
8. End your final assistant response with a comprehensive summary enclosed in <task_summary>...</task_summary>.
9. The initial file context provided is a focused subset. The full repository is restored in ${PROJECT_WORKSPACE_DIR}. If you need to view any other project files, shared types, utility functions, or configs not in initial context, use the "readFiles" tool at any time.
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
    { sandboxId, summary: "", files: initialFiles },
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
      ? "gemini-2.5-pro"
      : "gemini-2.5-flash"
  );

  const geminiModel = getGeminiModel({
    model: selectedModel,
  });

  const systemPrompt = buildContextEnhancedPrompt(
    prd,
    designSpec,
    architectureSpec
  );

  const codeAgent = createAgent({
    name: "code-agent",
    description: "Authoritative full-stack implementation agent",
    system: systemPrompt,
    model: geminiModel,
    tools: [
      // 1. Terminal Tool (operates inside project workspace with strict security and output limits)
      createTool({
        name: "terminal",
        description: `Run allowed terminal commands inside the project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          command: z.string(),
        }),
        handler: async ({ command }) => {
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
                timeoutMs: MAX_COMMAND_TIMEOUT_MS,
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
        handler: async ({ files }) => {
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
        if (lastText && network) {
          if (lastText.includes("<task_summary>")) {
            network.state.data.summary = lastText;
          }
        }
        const stepUsage = extractUsageMetadata(result);
        if (stepUsage && network?.state?.data) {
          network.state.data.promptTokens = (network.state.data.promptTokens || 0) + (stepUsage.promptTokens || 0);
          network.state.data.completionTokens = (network.state.data.completionTokens || 0) + (stepUsage.completionTokens || 0);
          network.state.data.hasUsage = true;
        }
        return result;
      },
    },
  });

  const network = createNetwork({
    name: "code-agent-network",
    agents: [codeAgent],
    maxIter: 15,
    router: async ({ network }) => {
      const summary = network.state.data.summary;
      if (summary) {
        return;
      }
      return codeAgent;
    },
  });

  const result = await network.run(prompt, { state });
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
