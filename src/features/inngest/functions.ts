import { prisma } from "@/lib/db";
import { inngest } from "./client";
import { Sandbox } from "@e2b/code-interpreter";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";
import { createAgent, createNetwork, createState, createTool } from "@inngest/agent-kit";
import { getGeminiModel } from "@/server/providers/gemini";
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/lib/prompt";
import z from "zod";
import { agentOutputText, connectSandbox, lastAssistantTextMessageContent } from "./utils";
import { transitionRun } from "@/server/orchestration/state-machine";
import { createProjectRevision, resolveBaseRevision } from "@/server/orchestration/revisions";

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
}

/**
 * The E2B sandbox template to use for code execution.
 * Set E2B_TEMPLATE_ID in your environment to override.
 * NEVER hardcode a template ID or API key in this file.
 */
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

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent", triggers: { event: "code-agent/run" } },
  async ({ event, step }) => {
    const projectId = event.data.projectId as string;
    const runId = (event.data.runId as string) || undefined;
    const baseRevisionId = (event.data.baseRevisionId as string) || undefined;

    // 1. Mark generation run as RUNNING
    if (runId) {
      await step.run("mark-run-running", async () => {
        try {
          await transitionRun(runId, GenerationRunStatus.RUNNING);
        } catch (err) {
          console.error(`[Lifecycle] Could not transition run ${runId} to RUNNING:`, err);
        }
      });
    }

    // 2. Resolve base revision files to restore into sandbox
    const baseFiles = await step.run("resolve-base-files", async () => {
      const baseRev = await resolveBaseRevision(projectId, baseRevisionId);
      return (baseRev?.files as Record<string, string>) || {};
    });

    // 3. Create fresh E2B sandbox and restore previous project files
    const sandboxId = await step.run("get-sandbox-id-and-restore", async () => {
      const sandbox = await Sandbox.create({
        template: getE2BTemplateId(),
      });

      // Restore files from base revision so the agent continues from where it left off
      const fileEntries = Object.entries(baseFiles);
      if (fileEntries.length > 0) {
        for (const [filePath, content] of fileEntries) {
          try {
            await sandbox.files.write(filePath, content);
          } catch (writeError) {
            console.error(`Failed to restore file ${filePath} into sandbox:`, writeError);
          }
        }
      }

      return sandbox.sandboxId;
    });

    // 4. Retrieve conversation history
    const previousMessages = await step.run("get-previous-messages", async () => {
      const messages = await prisma.message.findMany({
        where: {
          projectId,
        },
        orderBy: {
          createdAt: "asc",
        },
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

    // 5. Initialize agent state with restored base files
    const state = createState<CodeAgentState>(
      { sandboxId, summary: "", files: { ...baseFiles } },
      { messages: previousMessages }
    );

    const geminiModel = getGeminiModel({
      model: "gemini-2.5-flash",
    });

    const codeAgent = createAgent({
      name: "code-agent",
      description: "An expert coding agent powered by Google Gemini",
      system: PROMPT,
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
            const newFiles = await step?.run(
              "createOrUpdateFiles",
              async () => {
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
              }
            );

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

    // 6. Run the agent network
    const result = await network.run(event.data.value, { state });
    const { summary, files } = result.state.data;

    // 7. Text generators for fragment title and friendly user message
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

    const fragmentTitle = agentOutputText(fragmentTitleOutput, "Project Update");
    const responseText = agentOutputText(responseOutput, "Here is your updated application.");

    // 8. Validation Gate: Validate generated output before marking success
    const validationResult = await step.run("validate-output", async () => {
      if (runId) {
        try {
          await transitionRun(runId, GenerationRunStatus.VALIDATING);
        } catch (err) {
          console.error(`[Lifecycle] Could not transition run ${runId} to VALIDATING:`, err);
        }
      }

      const filesCount = Object.keys(files || {}).length;
      const hasSummary = Boolean(summary);
      const passed = filesCount > 0 && hasSummary;

      return {
        passed,
        filesCount,
        hasSummary,
      };
    });

    // 9. Resolve preview URL
    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await connectSandbox(sandboxId);
      return `http://${sandbox.getHost(3000)}`;
    });

    // 10. Persist results, create immutable ProjectRevision, and transition GenerationRun
    await step.run("save-result", async () => {
      if (!validationResult.passed) {
        if (runId) {
          try {
            await transitionRun(runId, GenerationRunStatus.FAILED, {
              errorCode: "VALIDATION_FAILED",
              errorMessage: "Generation completed without producing valid files or summary.",
            });
          } catch (err) {
            console.error(`[Lifecycle] Could not transition run ${runId} to FAILED:`, err);
          }
        }

        return prisma.message.create({
          data: {
            projectId,
            content: "Generation failed to pass validation checks. Your previous working revision remains preserved.",
            role: MessageRole.ASSISTANT,
            type: MessageType.ERROR,
          },
        });
      }

      // Create durable, immutable ProjectRevision
      const revision = await createProjectRevision({
        projectId,
        generationRunId: runId,
        parentRevisionId: baseRevisionId,
        title: fragmentTitle,
        summary: responseText,
        files: files || {},
      });

      // Mark GenerationRun as COMPLETED
      if (runId) {
        try {
          await transitionRun(runId, GenerationRunStatus.COMPLETED, {
            resultRevisionId: revision.id,
          });
        } catch (err) {
          console.error(`[Lifecycle] Could not transition run ${runId} to COMPLETED:`, err);
        }
      }

      // Backward compatible message & fragment creation
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