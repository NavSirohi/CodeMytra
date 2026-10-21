import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getOpenAIModel,
  isOpenAIPermanentError,
} from "../src/server/providers/openai";
import {
  AVAILABLE_MODEL_IDS,
  MODEL_REGISTRY,
  isValidModelPreference,
  normalizeModelPreference,
} from "../src/lib/models";
import { selectModelForStage } from "../src/server/orchestration/stage-optimizer";
import { calculateCost, extractUsageMetadata, DEFAULT_PRICING_CONFIG } from "../src/server/observability/metrics";
import { runPlannerAgent, PlannerError } from "../src/server/agents/planner";
import { runDesignAgent } from "../src/server/agents/designer";
import { runArchitectureAgent } from "../src/server/agents/architect";
import { createAgent, createTool } from "@inngest/agent-kit";
import { z } from "zod";

describe("OpenAI Provider Migration & Multi-Agent Pipeline Verification", () => {
  describe("Provider Factory & Adapter Configuration", () => {
    it("creates configured Inngest AgentKit OpenAI adapter with default parameters", () => {
      process.env.OPENAI_API_KEY = "sk-test-openai-synthetic-key";

      const adapter = getOpenAIModel({
        model: "gpt-4o-mini",
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: { type: "json_object" },
      });

      assert.ok(adapter, "Adapter must be created");
      assert.equal((adapter as any).format, "openai-chat");
      assert.equal((adapter as any).modelId, "gpt-4o-mini");
      assert.equal((adapter as any).authKey, "sk-test-openai-synthetic-key");
      assert.ok(String((adapter as any).url).includes("api.openai.com/v1/chat/completions"));

      // Verify onCall populates defaultParameters correctly
      const mockBody: Record<string, unknown> = {};
      (adapter as any).onCall({}, mockBody);
      assert.equal(mockBody.model, "gpt-4o-mini");
      assert.equal(mockBody.temperature, 0.2);
      assert.equal(mockBody.max_tokens, 4096);
      assert.deepEqual(mockBody.response_format, { type: "json_object" });
    });

    it("throws explicit configuration error when OPENAI_API_KEY is missing", () => {
      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        assert.throws(
          () => getOpenAIModel(),
          (err: Error) => {
            assert.match(err.message, /OPENAI_API_KEY is not configured/);
            assert.match(err.message, /platform\.openai\.com/);
            return true;
          }
        );
      } finally {
        process.env.OPENAI_API_KEY = savedKey;
      }
    });
  });

  describe("Model Allowlist, Validation & Normalization", () => {
    it("exposes only active OpenAI models in registry", () => {
      assert.deepEqual([...AVAILABLE_MODEL_IDS], ["auto", "gpt-4o", "gpt-4o-mini"]);
      assert.equal(MODEL_REGISTRY["auto"].name, "CodeMytra Auto");
      assert.equal(MODEL_REGISTRY["gpt-4o"].name, "GPT-4o");
      assert.equal(MODEL_REGISTRY["gpt-4o-mini"].name, "GPT-4o mini");
    });

    it("strictly rejects obsolete Gemini models from new customer selection", () => {
      assert.equal(isValidModelPreference("gemini-2.5-pro"), false);
      assert.equal(isValidModelPreference("gemini-2.5-flash"), false);
      assert.equal(isValidModelPreference("gpt-4o"), true);
      assert.equal(isValidModelPreference("gpt-4o-mini"), true);
      assert.equal(isValidModelPreference("auto"), true);
    });

    it("safely normalizes historical Gemini models to 'auto' for subsequent modifications", () => {
      // Historical runs stored with old identifiers normalize cleanly without crashing
      assert.equal(normalizeModelPreference("gemini-2.5-pro"), "auto");
      assert.equal(normalizeModelPreference("gemini-2.5-flash"), "auto");
      assert.equal(normalizeModelPreference("gpt-4o"), "gpt-4o");
      assert.equal(normalizeModelPreference("gpt-4o-mini"), "gpt-4o-mini");
    });
  });

  describe("Adaptive Stage Optimizer Routing", () => {
    it("routes stages economically with GPT-4o mini and escalates to GPT-4o for complex architecture and repair", () => {
      // Routine / default stages use economical gpt-4o-mini
      assert.equal(selectModelForStage("design"), "gpt-4o-mini");
      assert.equal(selectModelForStage("planning", { isComplexFullstack: false }), "gpt-4o-mini");
      assert.equal(selectModelForStage("coding", { isComplexFullstack: false }), "gpt-4o-mini");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: false }), "gpt-4o-mini");

      // Complex fullstack and repair escalate to flagship gpt-4o
      assert.equal(selectModelForStage("planning", { isComplexFullstack: true }), "gpt-4o");
      assert.equal(selectModelForStage("architecture"), "gpt-4o");
      assert.equal(selectModelForStage("coding", { isComplexFullstack: true }), "gpt-4o");
      assert.equal(selectModelForStage("repair", { isRepairAttempt: true }), "gpt-4o");
    });

    it("honors explicit user overrides across all stages", () => {
      assert.equal(selectModelForStage("design", { modelPreference: "gpt-4o" }), "gpt-4o");
      assert.equal(selectModelForStage("architecture", { modelPreference: "gpt-4o-mini" }), "gpt-4o-mini");
    });
  });

  describe("Structured JSON Agents with OpenAI Responses", () => {
    it("Planner Agent parses OpenAI JSON response, extracts token usage, and tags modelId", async () => {
      process.env.OPENAI_API_KEY = "sk-test-openai-key";
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-prd-1",
            object: "chat.completion",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    projectName: "OpenAI Task Flow",
                    summary: "A modern collaborative task manager",
                    targetAudience: "Engineering teams",
                    capabilities: ["pages-navigation", "data-persistence", "crud-operations"],
                    unsupportedRequirements: [],
                    coreFeatures: [{ name: "Task Board", description: "Kanban board", priority: "MUST" }],
                    pages: [{ route: "/dashboard", title: "Dashboard", purpose: "Overview", keyComponents: ["TaskGrid"] }],
                    dataEntities: [{ name: "Task", fields: ["id", "title", "status"], relationships: [], isPersistent: true }],
                    userFlows: [{ name: "Create Task", steps: ["Click Add", "Submit Form"] }],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 350,
              completion_tokens: 180,
              total_tokens: 530,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const prd = await runPlannerAgent("Build a task management application");
        assert.equal(prd.projectName, "OpenAI Task Flow");
        assert.equal(prd.pages[0].route, "/dashboard");
        assert.equal((prd as any).modelId, "gpt-4o-mini");
        assert.deepEqual((prd as any).usage, {
          promptTokens: 350,
          completionTokens: 180,
          totalTokens: 530,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("Planner Agent cleanly surfaces PlannerError if model output is malformed", async () => {
      process.env.OPENAI_API_KEY = "sk-test-openai-key";
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-bad",
            choices: [{ message: { role: "assistant", content: "Not valid JSON at all" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        await assert.rejects(
          async () => runPlannerAgent("Invalid test"),
          PlannerError
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("Designer Agent successfully generates DesignSpec with OpenAI", async () => {
      process.env.OPENAI_API_KEY = "sk-test-openai-key";
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-design-1",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    aestheticTheme: "minimalist-saas",
                    colorPalette: {
                      primary: "#2563eb",
                      secondary: "#64748b",
                      accent: "#f59e0b",
                      background: "#ffffff",
                      surface: "#f8fafc",
                      text: "#0f172a",
                    },
                    typography: {
                      headingFont: "Inter",
                      bodyFont: "Inter",
                    },
                    layoutStyle: "clean-grid",
                    componentGuidelines: [
                      { componentName: "Button", stylingRules: "rounded-md px-4 py-2" },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 220, completion_tokens: 110, total_tokens: 330 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const mockPrd = {
          projectName: "OpenAI App",
          summary: "Summary",
          targetAudience: "Audience",
          capabilities: ["pages-navigation"],
          unsupportedRequirements: [],
          coreFeatures: [],
          pages: [],
          dataEntities: [],
          userFlows: [],
        };
        const design = await runDesignAgent(mockPrd as any);
        assert.equal(design.aestheticTheme, "minimalist-saas");
        assert.equal(design.colorPalette.primary, "#2563eb");
        assert.equal((design as any).modelId, "gpt-4o-mini");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("Architecture Agent successfully generates ArchitectureSpec with OpenAI", async () => {
      process.env.OPENAI_API_KEY = "sk-test-openai-key";
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-arch-1",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    componentHierarchy: [{ componentName: "AppLayout", purpose: "Shell", props: [] }],
                    routeEndpoints: [{ path: "/api/items", method: "GET", purpose: "Fetch items", type: "api" }],
                    dataModels: [{ modelName: "Item", fields: ["id String @id", "title String"], relations: [] }],
                    requiresDatabase: true,
                    npmDependencies: [{ name: "date-fns", version: "^4.0.0", purpose: "Date math" }],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 410, completion_tokens: 190, total_tokens: 600 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const mockPrd = {
          projectName: "OpenAI App",
          summary: "Summary",
          targetAudience: "Audience",
          capabilities: ["data-persistence"],
          unsupportedRequirements: [],
          coreFeatures: [],
          pages: [],
          dataEntities: [],
          userFlows: [],
        };
        const mockDesign = {
          aestheticTheme: "clean",
          colorPalette: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", surface: "#eee", text: "#000" },
          typography: { headingFont: "Inter", bodyFont: "Inter" },
          layoutStyle: "grid",
          componentGuidelines: [],
        };
        const arch = await runArchitectureAgent(mockPrd as any, mockDesign as any);
        assert.equal(arch.requiresDatabase, true);
        assert.equal(arch.routeEndpoints[0].path, "/api/items");
        assert.equal((arch as any).modelId, "gpt-4o");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("AgentKit Tool Calling with OpenAI", () => {
    it("handles multi-turn tool calling seamlessly through OpenAI chat completion protocol", async () => {
      let turn = 0;
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async () => {
        turn++;
        if (turn === 1) {
          // Model decides to call the terminal tool
          return new Response(
            JSON.stringify({
              id: "chatcmpl-tool-1",
              choices: [
                {
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call_abc123",
                        type: "function",
                        function: {
                          name: "sample_tool",
                          arguments: JSON.stringify({ input: "hello-openai" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } else {
          // Model receives tool result and produces final answer
          return new Response(
            JSON.stringify({
              id: "chatcmpl-tool-2",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Tool execution verified.",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      };

      try {
        let toolExecuted = false;
        const testTool = createTool({
          name: "sample_tool",
          description: "A test tool",
          parameters: z.object({ input: z.string() }),
          handler: async ({ input }) => {
            toolExecuted = true;
            assert.equal(input, "hello-openai");
            return { result: "ok" };
          },
        });

        const adapter = getOpenAIModel({ model: "gpt-4o-mini" });
        const agent = createAgent({
          name: "tool-test-agent",
          system: "You are a test agent",
          model: adapter,
          tools: [testTool],
        });

        const res = await agent.run("Run the sample tool");
        assert.equal(toolExecuted, true);
        assert.equal(res.toolCalls?.length, 1);
        assert.equal(res.output[0].type, "tool_call");
        assert.equal(res.output[0].tools[0].name, "sample_tool");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Token Accounting & Verified Pricing", () => {
    it("calculates accurate cost using verified OpenAI rates for gpt-4o and gpt-4o-mini", () => {
      assert.equal(DEFAULT_PRICING_CONFIG.rates["gpt-4o"].inputPerMillionUsd, 2.50);
      assert.equal(DEFAULT_PRICING_CONFIG.rates["gpt-4o-mini"].inputPerMillionUsd, 0.15);

      // 1M input: $2.50, 1M output: $10.00 for gpt-4o
      const costGpt4o = calculateCost("gpt-4o", 100_000, 20_000);
      assert.equal(costGpt4o.usageMeasured, true);
      // (100000 / 1M * 2.5) + (20000 / 1M * 10) = 0.25 + 0.20 = 0.45 USD
      assert.equal(costGpt4o.costUsd, 0.45);
      assert.equal(costGpt4o.rateUsed?.inputPerMillionUsd, 2.50);
      assert.equal(costGpt4o.rateUsed?.outputPerMillionUsd, 10.00);

      // 1M input: $0.15, 1M output: $0.60 for gpt-4o-mini
      const costGpt4oMini = calculateCost("gpt-4o-mini", 200_000, 50_000);
      assert.equal(costGpt4oMini.usageMeasured, true);
      // (200000 / 1M * 0.15) + (50000 / 1M * 0.60) = 0.03 + 0.03 = 0.06 USD
      assert.equal(costGpt4oMini.costUsd, 0.06);
      assert.equal(costGpt4oMini.rateUsed?.inputPerMillionUsd, 0.15);
      assert.equal(costGpt4oMini.rateUsed?.outputPerMillionUsd, 0.60);
    });

    it("preserves exact historical rates for Gemini models without distorting historical audit records", () => {
      const historicalCost = calculateCost("gemini-2.5-pro", 100_000, 20_000);
      assert.equal(historicalCost.usageMeasured, true);
      // (100000 / 1M * 1.25) + (20000 / 1M * 5.00) = 0.125 + 0.100 = 0.225 USD
      assert.equal(historicalCost.costUsd, 0.225);
      assert.equal(historicalCost.rateUsed?.inputPerMillionUsd, 1.25);
      assert.equal(historicalCost.rateUsed?.outputPerMillionUsd, 5.00);
    });

    it("extracts usage from both OpenAI snake_case and AgentKit camelCase payloads", () => {
      // 1. OpenAI format
      const openAiUsage = extractUsageMetadata({
        raw: {
          usage: {
            prompt_tokens: 500,
            completion_tokens: 150,
            total_tokens: 650,
          },
        },
      });
      assert.deepEqual(openAiUsage, {
        promptTokens: 500,
        completionTokens: 150,
        totalTokens: 650,
      });

      // 2. AgentKit format
      const agentKitUsage = extractUsageMetadata({
        usage: {
          promptTokens: 800,
          completionTokens: 200,
          totalTokens: 1000,
        },
      });
      assert.deepEqual(agentKitUsage, {
        promptTokens: 800,
        completionTokens: 200,
        totalTokens: 1000,
      });
    });
  });

  describe("Failure Classification: Permanent vs Retryable", () => {
    it("classifies permanent configuration and authentication errors correctly", () => {
      assert.equal(isOpenAIPermanentError(new Error("Incorrect API key provided: sk-inv... You can find your API key at...")), true);
      assert.equal(isOpenAIPermanentError(new Error("Error: invalid_api_key")), true);
      assert.equal(isOpenAIPermanentError(new Error("You exceeded your current quota, please check your plan and billing details.")), true);
      assert.equal(isOpenAIPermanentError(new Error("The model 'gpt-unsupported' does not exist")), true);
      assert.equal(isOpenAIPermanentError(new Error("OPENAI_API_KEY is not configured.")), true);
    });

    it("classifies transient rate limits and network errors as retryable (not permanent)", () => {
      assert.equal(isOpenAIPermanentError(new Error("Rate limit reached for requests per min (RPM): 429")), false);
      assert.equal(isOpenAIPermanentError(new Error("Internal server error: 500")), false);
      assert.equal(isOpenAIPermanentError(new Error("Bad gateway: 502")), false);
      assert.equal(isOpenAIPermanentError(new Error("Service unavailable: 503")), false);
      assert.equal(isOpenAIPermanentError(new Error("Fetch failed: ECONNRESET")), false);
      assert.equal(isOpenAIPermanentError(new Error("Request timed out: ETIMEDOUT")), false);
    });
  });
});
