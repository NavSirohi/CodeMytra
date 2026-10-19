import { PRD, DesignSpec, ArchitectureSpec } from "@/server/agent-contracts/schemas";

/**
 * Configurable generation limits to prevent runaway loops and runaway costs.
 */
export interface GenerationLimits {
  maxRepairAttempts: number;
  maxGenerationDurationMs: number;
  maxConcurrentRunsPerUser: number;
  maxInputFilesForContext: number;
}

export const GENERATION_LIMITS: GenerationLimits = {
  maxRepairAttempts: Math.max(1, parseInt(process.env.MAX_REPAIR_ATTEMPTS || "2", 10)),
  maxGenerationDurationMs: Math.max(30000, parseInt(process.env.MAX_GENERATION_DURATION_MS || "300000", 10)), // 5 mins
  maxConcurrentRunsPerUser: Math.max(1, parseInt(process.env.MAX_CONCURRENT_RUNS_PER_USER || "3", 10)),
  maxInputFilesForContext: Math.max(5, parseInt(process.env.MAX_INPUT_FILES_FOR_CONTEXT || "30", 10)),
};

/**
 * Strategy for selecting economical vs capable models based on stage and complexity.
 */
export function selectModelForStage(
  stage: "planning" | "design" | "architecture" | "coding" | "repair",
  options?: { isComplexFullstack?: boolean; isRepairAttempt?: boolean }
): string {
  // Economical model by default for fast, lightweight stages
  if (stage === "design") {
    return "gemini-2.5-flash";
  }
  if (stage === "planning" && !options?.isComplexFullstack) {
    return "gemini-2.5-flash";
  }
  // Escalate to Pro for complex architecture decisions or after a verification failure in repair
  if (stage === "architecture" || (stage === "repair" && options?.isRepairAttempt)) {
    return "gemini-2.5-pro";
  }
  if (stage === "coding" && options?.isComplexFullstack) {
    return "gemini-2.5-pro";
  }
  return "gemini-2.5-flash";
}

/**
 * Identifies whether a follow-up modification is simple enough to safely bypass
 * unnecessary re-planning and re-architecture stages, reusing approved specifications.
 */
export function canBypassPlanningAndArchitecture(
  prompt: string,
  existingSpecs: {
    prd?: PRD | null;
    designSpec?: DesignSpec | null;
    architectureSpec?: ArchitectureSpec | null;
  }
): { canBypass: boolean; reason: string } {
  if (!existingSpecs.prd || !existingSpecs.architectureSpec) {
    return { canBypass: false, reason: "Missing existing approved specifications" };
  }

  const p = prompt.toLowerCase();

  // Prompts that introduce new entities, routes, or backend systems require full planning
  const requiresArchitecturalRethink =
    p.includes("new model") ||
    p.includes("new table") ||
    p.includes("database schema") ||
    p.includes("new route") ||
    p.includes("new api") ||
    p.includes("authentication") ||
    p.includes("auth system") ||
    p.includes("stripe") ||
    p.includes("payment");

  if (requiresArchitecturalRethink) {
    return {
      canBypass: false,
      reason: "Prompt introduces structural changes requiring updated architecture specification",
    };
  }

  // Simple modifications: styling, text updates, filter tags, small UI tweaks
  const isSimpleModification =
    p.includes("color") ||
    p.includes("theme") ||
    p.includes("dark mode") ||
    p.includes("light mode") ||
    p.includes("toggle") ||
    p.includes("padding") ||
    p.includes("margin") ||
    p.includes("font") ||
    p.includes("filter") ||
    p.includes("tag") ||
    p.includes("button") ||
    p.includes("badge") ||
    p.includes("text") ||
    p.includes("heading") ||
    p.includes("banner");

  if (isSimpleModification) {
    return {
      canBypass: true,
      reason: "Incremental UI/component modification can safely reuse approved specifications",
    };
  }

  return { canBypass: false, reason: "Prompt may require requirements adjustment" };
}

/**
 * Context window optimization: filters source files to send only the relevant subset
 * to the model instead of flooding the prompt with unnecessary boilerplate.
 */
export function filterRelevantFiles(
  files: Record<string, string>,
  prompt: string,
  limits = GENERATION_LIMITS
): Record<string, string> {
  const fileKeys = Object.keys(files);
  if (fileKeys.length <= limits.maxInputFilesForContext) {
    return files;
  }

  const p = prompt.toLowerCase();
  const isDbRelated = p.includes("database") || p.includes("prisma") || p.includes("model") || p.includes("api");
  const isStyleRelated = p.includes("style") || p.includes("theme") || p.includes("color") || p.includes("css");

  const filtered: Record<string, string> = {};

  // Core essential files always included
  const essentialPatterns = [
    "app/page.tsx",
    "src/app/page.tsx",
    "package.json",
  ];

  for (const key of fileKeys) {
    // 1. Always keep entrypoint and package manifest
    if (essentialPatterns.some((pattern) => key.endsWith(pattern) || key === pattern)) {
      filtered[key] = files[key];
      continue;
    }

    // 2. Database files
    if (isDbRelated && (key.includes("prisma") || key.includes("lib/db") || key.includes("app/api"))) {
      filtered[key] = files[key];
      continue;
    }

    // 3. Style files
    if (isStyleRelated && (key.includes("globals.css") || key.includes("theme") || key.includes("components/"))) {
      filtered[key] = files[key];
      continue;
    }

    // 4. Relevant components mentioned in prompt
    const baseName = key.split("/").pop()?.replace(/\.[^/.]+$/, "").toLowerCase();
    if (baseName && baseName.length > 3 && p.includes(baseName)) {
      filtered[key] = files[key];
      continue;
    }
  }

  // If filtered set is too small, include key app files up to limit
  if (Object.keys(filtered).length < 5) {
    for (const key of fileKeys) {
      if (!filtered[key] && !key.includes(".next") && !key.includes("node_modules")) {
        filtered[key] = files[key];
        if (Object.keys(filtered).length >= limits.maxInputFilesForContext) break;
      }
    }
  }

  return filtered;
}
