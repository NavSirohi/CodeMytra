import { openai } from "@inngest/agent-kit";

/**
 * Supported OpenAI models for CodeMytra multi-agent orchestration.
 *
 * - gpt-4o-mini: Fast, economical, high-throughput model ideal for requirements planning,
 *   design specifications, routine component generation, and metadata tasks.
 * - gpt-4o: High-reasoning flagship model ideal for complex fullstack architecture,
 *   data modeling, intricate business logic, and automated QA repair.
 */
export type OpenAIModelTier = "gpt-4o" | "gpt-4o-mini";

export interface CreateOpenAIModelOptions {
  model?: OpenAIModelTier | string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  seed?: number;
}

/**
 * Factory for creating configured Inngest AgentKit OpenAI model instances.
 * Guarantees OPENAI_API_KEY is present and supplies standard parameters.
 */
export function getOpenAIModel(options: CreateOpenAIModelOptions = {}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured. Add your OpenAI API key to .env. " +
      "Get an API key at https://platform.openai.com/api-keys"
    );
  }

  const {
    model = "gpt-4o-mini",
    temperature = 0,
    maxTokens = 8192,
    responseFormat,
    seed,
  } = options;

  const defaultParameters: Record<string, unknown> = {
    temperature,
    max_tokens: maxTokens,
  };

  if (responseFormat) {
    defaultParameters.response_format = responseFormat;
  }
  if (seed !== undefined) {
    defaultParameters.seed = seed;
  }

  const adapter = openai({
    model,
    apiKey,
    defaultParameters,
  });

  // Attach modelId property for explicit observability & verification
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).modelId = model;

  return adapter;
}

/**
 * Classifies whether an OpenAI API error represents a permanent configuration or authorization
 * failure that should not be retried by Inngest durable workflows.
 */
export function isOpenAIPermanentError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  return (
    lower.includes("incorrect api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid api key") ||
    lower.includes("insufficient_quota") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("model_not_found") ||
    (lower.includes("the model") && lower.includes("does not exist")) ||
    lower.includes("unsupported_country_region_territory") ||
    lower.includes("openai_api_key is not configured") ||
    lower.includes("context_length_exceeded")
  );
}
