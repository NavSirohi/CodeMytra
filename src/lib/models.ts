/**
 * CodeMytra Model Registry and Selection Contracts (OpenAI).
 *
 * Defines the shared model catalog, validation routines, and runtime metadata
 * for multi-agent generation workflows powered by OpenAI.
 */

export type ModelPreference = "auto" | "gpt-4o" | "gpt-4o-mini";

export interface ModelDefinition {
  id: ModelPreference;
  name: string;
  badge: string;
  iconName: "Sparkles" | "Cpu" | "Zap";
  description: string;
  recommendedFor: string;
}

export const MODEL_REGISTRY: Record<ModelPreference, ModelDefinition> = {
  auto: {
    id: "auto",
    name: "CodeMytra Auto",
    badge: "Recommended",
    iconName: "Sparkles",
    description: "Adaptive multi-agent routing (GPT-4o mini for fast specs & code, GPT-4o for complex architecture & repair)",
    recommendedFor: "Optimal speed, cost, and architecture capability balance",
  },
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    badge: "Reasoning",
    iconName: "Cpu",
    description: "High-reasoning flagship model for complex fullstack apps, relational data models, and QA repair",
    recommendedFor: "Complex relational schemas, state machines, and rigorous fullstack logic",
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    badge: "Ultra-Fast",
    iconName: "Zap",
    description: "Low-latency generation for rapid prototypes, components, and quick iterations",
    recommendedFor: "Rapid interactive prototypes, landing pages, and component iteration",
  },
};

export const AVAILABLE_MODEL_IDS: readonly ModelPreference[] = [
  "auto",
  "gpt-4o",
  "gpt-4o-mini",
] as const;

export function isValidModelPreference(value: unknown): value is ModelPreference {
  return typeof value === "string" && (AVAILABLE_MODEL_IDS as readonly string[]).includes(value);
}

export function normalizeModelPreference(value: unknown): ModelPreference {
  if (isValidModelPreference(value)) {
    return value;
  }
  // Historical preferences (e.g. legacy gemini-2.5-pro/flash) normalize cleanly to "auto"
  return "auto";
}
