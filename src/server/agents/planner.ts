import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, PRDSchema, DesignSpec, ArchitectureSpec } from "@/server/agent-contracts/schemas";
import { prisma } from "@/lib/db";
import { SpecStatus, Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { agentOutputText } from "@/features/inngest/utils";
import { extractUsageMetadata } from "@/server/observability/metrics";
import { runWithoutStepContext } from "@/server/orchestration/async-context";

export const PLANNER_PROMPT = `
You are a Principal Software Planner & Product Requirements Engineer for CodeMytra.
Your role is to analyze any web application requirement across diverse categories (e.g., developer portfolios, e-commerce platforms, booking/appointment systems, inventory managers, SaaS dashboards, multi-step workflows, creative tools) and generate a complete, structured, unambiguous Product Requirements Document (PRD).

Analyze:
1. Target users, domain context, and core problem solved.
2. Application capabilities required. Select all applicable from:
   - "pages-navigation": multi-page or single-page layout & navigation.
   - "data-persistence": relational models requiring database storage.
   - "crud-operations": create, read, update, delete functionality.
   - "authentication": user sign-in/registration (if explicitly required).
   - "authorization": role-based access control (admin, customer, etc.).
   - "forms-validation": input collection with validation rules.
   - "file-handling": uploads or asset management.
   - "search-filtering": query, filter, sort, or pagination.
   - "business-rules": domain-specific constraints (e.g., booking conflict prevention, stock decrement, pricing rules).
   - "external-integrations": third-party APIs (note limitations if credentials are absent).
3. Identify any unsupported requirements (e.g., physical payment gateways without credentials, native hardware access).
4. Core features categorized by priority ("MUST", "SHOULD", "COULD").
5. Complete page and route hierarchy (routes, titles, purpose, and key components).
6. Data entities with field definitions, relationships, and whether each entity requires persistent database storage (isPersistent: true/false).
7. Primary user flows step-by-step.

You MUST respond with valid JSON matching this schema:
{
  "projectName": "string",
  "summary": "string",
  "targetAudience": "string",
  "capabilities": ["pages-navigation" | "data-persistence" | "crud-operations" | "authentication" | "authorization" | "forms-validation" | "file-handling" | "search-filtering" | "business-rules" | "external-integrations"],
  "unsupportedRequirements": ["string"],
  "coreFeatures": [{ "name": "string", "description": "string", "priority": "MUST" | "SHOULD" | "COULD" }],
  "pages": [{ "route": "string", "title": "string", "purpose": "string", "keyComponents": ["string"] }],
  "dataEntities": [{ "name": "string", "fields": ["string"], "relationships": ["string"], "isPersistent": boolean }],
  "userFlows": [{ "name": "string", "steps": ["string"] }]
}
Do NOT wrap in markdown backticks or include any conversational filler. Only return raw JSON.
`;

export interface PlannerContext {
  existingPRD?: PRD | null;
  existingDesignSpec?: DesignSpec | null;
  existingArchitectureSpec?: ArchitectureSpec | null;
  existingFiles?: Record<string, string> | null;
}

export class PlannerError extends Error {
  constructor(message: string, public readonly rawOutput?: string) {
    super(message);
    this.name = "PlannerError";
  }
}

export interface PlannerOptions {
  model?: string;
  temperature?: number;
}

export async function runPlannerAgent(
  prompt: string,
  context?: PlannerContext,
  options?: PlannerOptions
): Promise<PRD> {
  const selectedModel = options?.model || "gemini-2.5-pro";
  const model = getGeminiModel({
    model: selectedModel,
    temperature: options?.temperature ?? 0.2,
  });

  const isFollowUp = Boolean(context?.existingPRD || (context?.existingFiles && Object.keys(context.existingFiles).length > 0));

  let systemPrompt = PLANNER_PROMPT;
  let userPrompt = `User Application Request:\n"${prompt}"`;

  if (isFollowUp) {
    const fileList = context?.existingFiles
      ? Object.keys(context.existingFiles).slice(0, 30).join(", ")
      : "None";

    systemPrompt += `
\n=== FOLLOW-UP / INCREMENTAL MODIFICATION RULES ===
You are modifying an existing, previously generated application.
1. PRESERVE EXISTING FEATURES: Keep existing pages, data entities, and core capabilities intact unless explicitly instructed to remove or replace them.
2. INTEGRATE DELTA: Incorporate the user's new request as an additive or targeted modification to the PRD.
3. PRESERVE IDENTITY: Keep the existing project name and core audience aligned with the previous baseline.
4. RETURN COMPLETE PRD: Return the unified, comprehensive PRD reflecting both existing and new requirements.
`;

    userPrompt = `User Modification Request:\n"${prompt}"\n\n=== EXISTING BASELINE PRD ===\n${JSON.stringify(context?.existingPRD || {}, null, 2)}\n\n=== EXISTING PROJECT FILES ===\n${fileList}`;
  }

  const agent = createAgent({
    name: "planner-agent",
    description: "Generates structured application PRDs",
    system: systemPrompt,
    model,
  });

  const result = await runWithoutStepContext(() => agent.run(userPrompt));
  const text = agentOutputText(result.output, "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const rawJson = JSON.parse(cleaned);
    const parsedPrd = PRDSchema.parse(rawJson) as PRD & {
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      modelId?: string;
    };
    const usage = extractUsageMetadata(result);
    if (usage) {
      parsedPrd.usage = usage;
    }
    parsedPrd.modelId = selectedModel;
    return parsedPrd;
  } catch (error) {
    console.error("[Planner] Failed to parse PRD output:", error, "Raw response:", text);
    throw new PlannerError(
      `Planner agent failed to generate a valid Product Requirements Document (PRD): ${error instanceof Error ? error.message : String(error)}`,
      text
    );
  }
}

/**
 * Persists or updates the project PRD in the database.
 */
export async function saveProjectPRD(projectId: string, prd: PRD, status: SpecStatus = SpecStatus.DRAFT) {
  const prdJson = prd as unknown as Prisma.InputJsonObject;

  return prisma.projectSpecification.upsert({
    where: { projectId },
    create: {
      projectId,
      prd: prdJson,
      status,
    },
    update: {
      prd: prdJson,
      status,
    },
  });
}
