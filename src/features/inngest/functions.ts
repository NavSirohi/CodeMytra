import { prisma } from "@/lib/db";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { MessageRole, MessageType, GenerationRunStatus, Prisma } from "@/generated/prisma/client";
import { createAgent, createNetwork, createState, createTool } from "@inngest/agent-kit";
import { getGeminiModel } from "@/server/providers/gemini";
import { FRAGMENT_TITLE_PROMPT, RESPONSE_PROMPT } from "@/lib/prompt";
import z from "zod";
import { agentOutputText, connectSandbox, lastAssistantTextMessageContent } from "./utils";
import { transitionRun } from "@/server/orchestration/state-machine";
import { createProjectRevision, resolveBaseRevision } from "@/server/orchestration/revisions";
import { runPlannerAgent, saveProjectPRD } from "@/server/agents/planner";
import { runDesignAgent, saveDesignSpec } from "@/server/agents/designer";
import { runArchitectureAgent, saveArchitectureSpec } from "@/server/agents/architect";
import { runQAInspector } from "@/server/agents/qa";

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
}

function getE2BTemplateId(): string {
  const id = process.env.E2B_TEMPLATE_ID;
  if (!id) {
    throw new Error(
      "E2B_TEMPLATE_ID is not set. Add it to your .env file. " +
      "Create your own E2B account at https://e2b.dev"
    );
  }
  return id;
}

/**
 * Records an immutable event in the run timeline for real-time UI streaming.
 */
async function recordRunEvent(
  runId: string | undefined,
  stage: string,
  agentRole: string,
  message: string,
  payload?: Record<string, unknown>
) {
  if (!runId) return;
  try {
    await prisma.runEvent.create({
      data: {
        runId,
        stage,
        agentRole,
        message,
        payload: payload ? (payload as unknown as Prisma.InputJsonObject) : undefined,
      },
    });
  } catch (err) {
    console.error("[RunEvent] Failed to log event:", err);
  }
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", triggers: { event: "code-agent/run" } },
  async ({ event, step }) => {
    const projectId = event.data.projectId as string;
    const runId = (event.data.runId as string) || undefined;
    const promptValue = event.data.value as string;
    const baseRevisionId = (event.data.baseRevisionId as string) || undefined;

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: REQUIREMENTS & PLANNING (Planner Agent with Gemini 2.5 Pro)
    // ─────────────────────────────────────────────────────────────────────────
    const prd = await step.run("planner-agent", async () => {
      if (runId) {
        await transitionRun(runId, GenerationRunStatus.PLANNING);
        await recordRunEvent(runId, "PLANNING", "Planner Agent", "Analyzing requirements and drafting product specification");
      }

      const generatedPRD = await runPlannerAgent(promptValue);
      await saveProjectPRD(projectId, generatedPRD);

      if (runId) {
        await recordRunEvent(
          runId,
          "PLANNING",
          "Planner Agent",
          `Generated PRD for ${generatedPRD.projectName} with ${generatedPRD.pages.length} pages`
        );
      }

      return generatedPRD;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: DESIGN SPECIFICATION (Design Agent with Gemini 2.5 Flash)
    // ─────────────────────────────────────────────────────────────────────────
    const designSpec = await step.run("designer-agent", async () => {
      if (runId) {
        await transitionRun(runId, GenerationRunStatus.DESIGNING);
        await recordRunEvent(runId, "DESIGNING", "Design Agent", "Creating accessible color palette, typography, and component styling");
      }

      const spec = await runDesignAgent(prd);
      await saveDesignSpec(projectId, spec);

      if (runId) {
        await recordRunEvent(
          runId,
          "DESIGNING",
          "Design Agent",
          `Selected ${spec.aestheticTheme} theme with primary color ${spec.colorPalette.primary}`
        );
      }

      return spec;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: ARCHITECTURE & CONTRACTS (Architecture Agent with Gemini 2.5 Pro)
    // ─────────────────────────────────────────────────────────────────────────
    const archSpec = await step.run("architect-agent", async () => {
      if (runId) {
        await transitionRun(runId, GenerationRunStatus.ARCHITECTING);
        await recordRunEvent(runId, "ARCHITECTING", "Architecture Agent", "Establishing route contracts and file ownership boundaries");
      }

      const spec = await runArchitectureAgent(prd, designSpec);
      await saveArchitectureSpec(projectId, spec);

      if (runId) {
        await recordRunEvent(
          runId,
          "ARCHITECTING",
          "Architecture Agent",
          `Configured ${spec.routeEndpoints.length} route endpoints with Next.js full-stack architecture`
        );
      }

      return spec;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: FILESYSTEM RESTORATION & SANDBOX INITIALIZATION
    // ─────────────────────────────────────────────────────────────────────────
    if (runId) {
      await step.run("mark-run-running", async () => {
        await transitionRun(runId, GenerationRunStatus.RUNNING);
        await recordRunEvent(runId, "RUNNING", "Integration Agent", "Restoring previous project filesystem and spinning up execution sandbox");
      });
    }

    const baseFiles = await step.run("resolve-base-files", async () => {
      const baseRev = await resolveBaseRevision(projectId, baseRevisionId);
      return (baseRev?.files as Record<string, string>) || {};
    });

    const sandboxId = await step.run("get-sandbox-id-and-restore", async () => {
      const sandbox = await Sandbox.create({
        template: getE2BTemplateId(),
      });

      // Restore files from base revision
      const fileEntries = Object.entries(baseFiles);
      if (fileEntries.length > 0) {
        for (const [filePath, content] of fileEntries) {
          try {
            await sandbox.files.write(filePath, content);
          } catch (writeError) {
            console.error(`Failed to restore ${filePath}:`, writeError);
          }
        }
      }

      return sandbox.sandboxId;
    });

    const previousMessages = await step.run("get-previous-messages", async () => {
      const messages = await prisma.message.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      });

      return messages.map((message) => ({
        type: "text" as const,
        role:
          message.role === MessageRole.ASSISTANT
            ? ("assistant" as const)
            : ("user" as const),
        content: message.content,
      }));
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: IMPLEMENTATION (Coding Agent with Injected Specifications)
    // ─────────────────────────────────────────────────────────────────────────
    const state = createState<CodeAgentState>(
      { sandboxId, summary: "", files: { ...baseFiles } },
      { messages: previousMessages }
    );

    const geminiModel = getGeminiModel({
      model: "gemini-2.5-flash",
    });

    // Comprehensive contextual prompt incorporating PRD, Design, and Architecture
    const contextEnhancedPrompt = `
You are the Lead Full-Stack Code Implementation Agent for CodeMytra.
Build a complete, working, interactive Next.js application adhering strictly to the approved specifications.

=== APPROVED PRODUCT REQUIREMENTS ===
Project: ${prd.projectName}
Summary: ${prd.summary}
Pages to implement:
${prd.pages.map((p) => `- ${p.route} (${p.title}): ${p.purpose}`).join("\n")}

=== DESIGN SPECIFICATION ===
Theme: ${designSpec.aestheticTheme}
Primary: ${designSpec.colorPalette.primary} | Secondary: ${designSpec.colorPalette.secondary} | Surface: ${designSpec.colorPalette.surface}
Font: ${designSpec.typography.headingFont}

=== ARCHITECTURE SPECIFICATION ===
Routes:
${archSpec.routeEndpoints.map((r) => `- [${r.type}] ${r.path}: ${r.purpose}`).join("\n")}

=== RULES ===
1. Use the "createOrUpdateFiles" tool to write clean, complete, working React/Next.js components.
2. Put primary landing content in app/page.tsx.
3. Use Tailwind CSS with clean classes.
4. Do NOT import non-existent external packages.
5. End your final assistant response with a comprehensive summary enclosed in <task_summary>...</task_summary>.
`;

    const codeAgent = createAgent({
      name: "code-agent",
      description: "Expert full-stack implementation agent",
      system: contextEnhancedPrompt,
      model: geminiModel,
      tools: [
        // 1. Terminal
        createTool({
          name: "terminal",
          description: "Use the terminal to run allowed commands",
          parameters: z.object({
            command: z.string(),
          }),
          handler: async ({ command }, { step }) => {
            return await step?.run("terminal", async () => {
              const buffers = { stdout: "", stderr: "" };

              try {
                const sandbox = await Sandbox.connect(sandboxId);
                const result = await sandbox.commands.run(command, {
                  onStdout: (data) => {
                    buffers.stdout += data;
                  },
                  onStderr: (data) => {
                    buffers.stderr += data;
                  },
                });

                return result.stdout;
              } catch (error) {
                return `Command failed: ${error} \n stdout: ${buffers.stdout}\n stderr: ${buffers.stderr}`;
              }
            });
          },
        }),

        // 2. createOrUpdateFiles
        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sandbox",
          parameters: z.object({
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
              })
            ),
          }),
          handler: async ({ files }, { step, network }) => {
            const newFiles = await step?.run("createOrUpdateFiles", async () => {
              try {
                const updatedFiles = network?.state?.data.files || {};
                const sandbox = await Sandbox.connect(sandboxId);

                for (const file of files) {
                  await sandbox.files.write(file.path, file.content);
                  updatedFiles[file.path] = file.content;
                }

                return updatedFiles;
              } catch (error) {
                return "Error: " + error;
              }
            });

            if (typeof newFiles === "object" && newFiles !== null && network?.state?.data) {
              network.state.data.files = newFiles as Record<string, string>;
            }
          },
        }),

        // 3. readFiles
        createTool({
          name: "readFiles",
          description: "Read files from the sandbox",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step }) => {
            return await step?.run("readFiles", async () => {
              try {
                const sandbox = await Sandbox.connect(sandboxId);
                const contents: Array<{ path: string; content: string }> = [];

                for (const file of files) {
                  const content = await sandbox.files.read(file);
                  contents.push({ path: file, content });
                }
                return JSON.stringify(contents);
              } catch (error) {
                return "Error: " + error;
              }
            });
          },
        }),
      ],

      lifecycle: {
        onResponse: async ({ result, network }) => {
          const lastAssistantMessageText =
            lastAssistantTextMessageContent(result);

          if (lastAssistantMessageText && network) {
            if (lastAssistantMessageText.includes("<task_summary>")) {
              network.state.data.summary = lastAssistantMessageText;
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

    const result = await network.run(promptValue, { state });
    const { summary, files } = result.state.data;

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 6: TITLE & RESPONSE TEXT HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    const makeTextAgent = (name: string, system: string) =>
      createAgent({ name, system, model: geminiModel });

    const fragmentTitleGenerator = makeTextAgent(
      "fragment-title-generator",
      FRAGMENT_TITLE_PROMPT
    );
    const responseGenerator = makeTextAgent(
      "response-generator",
      RESPONSE_PROMPT
    );

    const [{ output: fragmentTitleOutput }, { output: responseOutput }] =
      await Promise.all([
        fragmentTitleGenerator.run(summary, { step }),
        responseGenerator.run(summary, { step }),
      ]);

    const fragmentTitle = agentOutputText(fragmentTitleOutput, prd.projectName || "Application Update");
    const responseText = agentOutputText(responseOutput, "Here is your built application.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 7: QUALITY ASSURANCE & VERIFICATION (QA Agent)
    // ─────────────────────────────────────────────────────────────────────────
    const qaReport = await step.run("qa-agent", async () => {
      if (runId) {
        await transitionRun(runId, GenerationRunStatus.VALIDATING);
        await recordRunEvent(runId, "VALIDATING", "QA Agent", "Running multi-point verification checks on generated code");
      }

      const report = await runQAInspector({ files: files || {}, summary });

      if (runId) {
        await recordRunEvent(
          runId,
          "VALIDATING",
          "QA Agent",
          `Verification complete with quality score ${report.score}% (${report.passed ? "PASSED" : "FAILED"})`
        );
      }

      return report;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 8: PERSISTENCE & PREVIEW
    // ─────────────────────────────────────────────────────────────────────────
    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await connectSandbox(sandboxId);
      return `http://${sandbox.getHost(3000)}`;
    });

    await step.run("save-result", async () => {
      if (!qaReport.passed) {
        if (runId) {
          await transitionRun(runId, GenerationRunStatus.FAILED, {
            errorCode: "QA_VERIFICATION_FAILED",
            errorMessage: qaReport.repairInstructions || "Validation checks failed",
          });
          await recordRunEvent(runId, "FAILED", "System", "Run marked failed. Prior revision preserved.");
        }

        return prisma.message.create({
          data: {
            projectId,
            content: `Quality Assurance failed: ${qaReport.repairInstructions || "The generated code did not satisfy verification criteria."} Your prior working revision is preserved.`,
            role: MessageRole.ASSISTANT,
            type: MessageType.ERROR,
          },
        });
      }

      // Create durable immutable revision
      const revision = await createProjectRevision({
        projectId,
        generationRunId: runId,
        parentRevisionId: baseRevisionId,
        title: fragmentTitle,
        summary: responseText,
        files: files || {},
      });

      // Mark GenerationRun completed
      if (runId) {
        await transitionRun(runId, GenerationRunStatus.COMPLETED, {
          resultRevisionId: revision.id,
        });
        await recordRunEvent(runId, "COMPLETED", "System", `Revision V${revision.revisionNumber} permanently persisted`);
      }

      return prisma.message.create({
        data: {
          projectId,
          content: responseText,
          role: MessageRole.ASSISTANT,
          type: MessageType.RESULT,
          fragments: {
            create: {
              sandboxUrl,
              title: fragmentTitle,
              files: files || {},
            },
          },
        },
      });
    });

    return {
      url: sandboxUrl,
      title: fragmentTitle,
      files,
      summary,
    };
  }
);