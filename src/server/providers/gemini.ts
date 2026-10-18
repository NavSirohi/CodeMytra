import { gemini } from "@inngest/agent-kit";

/**
 * Supported Google Gemini models for CodeMytra multi-agent orchestration.
 *
 * - gemini-2.5-flash: Fast, low latency, ideal for implementation, test runs, and parsing.
 * - gemini-2.5-pro: Deep reasoning, ideal for PRD generation, complex architecture planning, and QA diagnostics.
 */
export type GeminiModelTier = "gemini-2.5-flash" | "gemini-2.5-pro";

export interface CreateGeminiModelOptions {
  step?: Parameters<typeof gemini>[0]["step"];
  model?: GeminiModelTier;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number;
}

/**
 * Factory for creating configured Inngest AgentKit Gemini model instances.
 * Guarantees GEMINI_API_KEY is present and supplies standard parameters.
 */
export function getGeminiModel(options: CreateGeminiModelOptions = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add your Google Gemini API key to .env. " +
      "Get a free API key at https://aistudio.google.com/app/apikey"
    );
  }

  const {
    step,
    model = "gemini-2.5-flash",
    temperature = 0,
    maxOutputTokens = 8192,
    thinkingBudget = 0,
  } = options;

  return gemini({
    model,
    step,
    apiKey,
    defaultParameters: {
      generationConfig: {
        temperature,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget },
      },
    },
  } as Parameters<typeof gemini>[0]);
}
