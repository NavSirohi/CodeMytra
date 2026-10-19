/**
 * CodeMytra Model Registry and Selection Contracts.
 *
 * Defines the shared model catalog, validation routines, and runtime metadata
 * for multi-agent generation workflows.
 */

export type ModelPreference = "auto" | "gemini-2.5-pro" | "gemini-2.5-flash";

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
    description: "Adaptive multi-agent routing (Flash for fast specs & code, Pro for complex architecture)",
    recommendedFor: "Optimal speed, cost, and architecture capability balance",
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    badge: "Reasoning",
    iconName: "Cpu",
    description: "Deep reasoning for complex fullstack apps, relational models, and business logic",
    recommendedFor: "Complex relational schemas, state machines, and rigorous fullstack logic",
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    badge: "Ultra-Fast",
    iconName: "Zap",
    description: "Low-latency generation for rapid prototypes, components, and quick iterations",
    recommendedFor: "Rapid interactive prototypes, landing pages, and component iteration",
  },
};

export const AVAILABLE_MODEL_IDS: readonly ModelPreference[] = [
  "auto",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
] as const;

export function isValidModelPreference(value: unknown): value is ModelPreference {
  return typeof value === "string" && (AVAILABLE_MODEL_IDS as readonly string[]).includes(value);
}

export function normalizeModelPreference(value: unknown): ModelPreference {
  if (isValidModelPreference(value)) {
    return value;
  }
  return "auto";
}
