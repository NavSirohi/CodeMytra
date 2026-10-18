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

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
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
  return `
You are the Lead Full-Stack Code Implementation Agent for CodeMytra.
Build a complete, working, interactive Next.js application adhering strictly to the approved specifications.
All source files must reside in the project workspace (${PROJECT_WORKSPACE_DIR}).

=== APPROVED PRODUCT REQUIREMENTS ===
Project: ${prd.projectName}
Summary: ${prd.summary}
Target Audience: ${prd.targetAudience}

Pages to implement:
${prd.pages.map((p) => `- ${p.route} (${p.title}): ${p.purpose} [Components: ${p.keyComponents?.join(", ") || "Main"}]`).join("\n")}

Data Entities:
${prd.dataEntities?.length ? prd.dataEntities.map((e) => `- ${e.name}: fields=[${e.fields.join(", ")}], relationships=[${e.relationships?.join(", ") || "none"}]`).join("\n") : "None specified"}

User Flows:
${prd.userFlows?.length ? prd.userFlows.map((f) => `- ${f.name}: ${f.steps.join(" -> ")}`).join("\n") : "Standard user journey"}

=== DESIGN SPECIFICATION ===
Theme: ${designSpec.aestheticTheme}
Primary: ${designSpec.colorPalette.primary} | Secondary: ${designSpec.colorPalette.secondary} | Surface: ${designSpec.colorPalette.surface} | Text: ${designSpec.colorPalette.text}
Font: ${designSpec.typography.headingFont} / ${designSpec.typography.bodyFont}
Layout: ${designSpec.layoutStyle}

=== ARCHITECTURE SPECIFICATION ===
Routes & Endpoints:
${archSpec.routeEndpoints.map((r) => `- [${r.type.toUpperCase()}] ${r.path}: ${r.purpose}`).join("\n")}

Database Models:
${archSpec.databaseModels?.length ? archSpec.databaseModels.map((m) => `- ${m.modelName} (${m.fields.join(", ")})`).join("\n") : "In-memory / client state"}

File Boundaries:
- Frontend: ${archSpec.fileOwnership.frontend.join(", ")}
- Backend: ${archSpec.fileOwnership.backend.join(", ")}
- Database: ${archSpec.fileOwnership.database.join(", ")}

=== FULL-STACK IMPLEMENTATION RULES ===
1. Use the "createOrUpdateFiles" tool to write clean, complete, working React/Next.js components.
2. Put the primary landing content and user interface in app/page.tsx (use "use client"; for interactive state).
3. For applications requiring backend data operations:
   - Provide route handlers in app/api/**/route.ts (or server actions).
   - If managing data entities, provide a robust data layer with initial realistic seed data so the app is instantly usable upon preview.
4. Use Tailwind CSS with clean, accessible classes matching the design token colors.
5. Do NOT import non-existent external npm packages.
6. When performing follow-up modifications, PRESERVE all existing working features while integrating requested additions.
7. End your final assistant response with a comprehensive summary enclosed in <task_summary>...</task_summary>.
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
  } = options;

  const runStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (step && typeof step.run === "function") {
      return await step.run(name, fn);
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

  const geminiModel = getGeminiModel({
    model: "gemini-2.5-flash",
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
      // 1. Terminal Tool (operates inside project workspace)
      createTool({
        name: "terminal",
        description: `Run allowed terminal commands inside the project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          command: z.string(),
        }),
        handler: async ({ command }) => {
          return await runStep("terminal", async () => {
            const buffers = { stdout: "", stderr: "" };
            try {
              const sandbox = await Sandbox.connect(sandboxId);
              // Ensure commands execute inside the project workspace
              const wrappedCommand = `cd "${PROJECT_WORKSPACE_DIR}" && ${command}`;
              const result = await sandbox.commands.run(wrappedCommand, {
                onStdout: (data) => {
                  buffers.stdout += data;
                },
                onStderr: (data) => {
                  buffers.stderr += data;
                },
                timeoutMs: 30000,
              });
              return result.stdout || buffers.stdout || "Command completed with zero output.";
            } catch (error) {
              return `Command failed: ${error} \n stdout: ${buffers.stdout}\n stderr: ${buffers.stderr}`;
            }
          });
        },
      }),

      // 2. createOrUpdateFiles Tool (enforces project workspace boundary and resource limits)
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
          const updatedFiles = await runStep("createOrUpdateFiles", async () => {
            try {
              const currentFiles = network?.state?.data?.files || initialFiles;
              const sandbox = await Sandbox.connect(sandboxId);

              for (const file of files) {
                // Strict path validation: all files must remain inside project workspace
                const fullWorkspacePath = resolveWorkspacePath(file.path);

                // Resource limit check per file (1 MB)
                const fileBytes = Buffer.byteLength(file.content, "utf8");
                if (fileBytes > 1024 * 1024) {
                  throw new Error(`File "${file.path}" exceeds maximum size limit of 1 MB`);
                }

                await sandbox.files.write(fullWorkspacePath, file.content);
                currentFiles[file.path] = file.content;
              }

              return currentFiles;
            } catch (error) {
              return `Error writing files: ${error instanceof Error ? error.message : String(error)}`;
            }
          });

          if (
            typeof updatedFiles === "object" &&
            updatedFiles !== null &&
            network?.state?.data
          ) {
            network.state.data.files = updatedFiles as Record<string, string>;
          }
        },
      }),

      // 3. readFiles Tool (reads from project workspace)
      createTool({
        name: "readFiles",
        description: `Read files from the sandbox project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          files: z.array(z.string()).min(1).max(20),
        }),
        handler: async ({ files }) => {
          return await runStep("readFiles", async () => {
            try {
              const sandbox = await Sandbox.connect(sandboxId);
              const contents: Array<{ path: string; content: string }> = [];

              for (const filePath of files) {
                const fullWorkspacePath = resolveWorkspacePath(filePath);
                const content = await sandbox.files.read(fullWorkspacePath);
                contents.push({ path: filePath, content: typeof content === "string" ? content : "" });
              }

              return JSON.stringify(contents);
            } catch (error) {
              return `Error reading files: ${error instanceof Error ? error.message : String(error)}`;
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

  return {
    files: finalFiles,
    summary: cleanedSummary,
  };
}
