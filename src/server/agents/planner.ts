import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, PRDSchema, DesignSpec, ArchitectureSpec } from "@/server/agent-contracts/schemas";
import { prisma } from "@/lib/db";
import { SpecStatus, Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { agentOutputText } from "@/features/inngest/utils";

export const PLANNER_PROMPT = `
You are a Principal Software Planner & Product Requirements Engineer for CodeMytra.
Your role is to analyze the user's application idea and generate a complete, structured, unambiguous Product Requirements Document (PRD).

Analyze:
1. Target users and problem solved.
2. Core features categorized by priority (MUST, SHOULD, COULD).
3. Complete page and route hierarchy (including routes, titles, and key component lists).
4. Data entities with field definitions.
5. Primary user flows step-by-step.

You MUST respond with valid JSON matching this schema:
{
  "projectName": "string",
  "summary": "string",
  "targetAudience": "string",
  "coreFeatures": [{ "name": "string", "description": "string", "priority": "MUST" | "SHOULD" | "COULD" }],
  "pages": [{ "route": "string", "title": "string", "purpose": "string", "keyComponents": ["string"] }],
  "dataEntities": [{ "name": "string", "fields": ["string"], "relationships": ["string"] }],
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

export async function runPlannerAgent(prompt: string, context?: PlannerContext): Promise<PRD> {
  const model = getGeminiModel({
    model: "gemini-2.5-pro",
    temperature: 0.2,
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

  const result = await agent.run(userPrompt);
  const text = agentOutputText(result.output, "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const rawJson = JSON.parse(cleaned);
    return PRDSchema.parse(rawJson);
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
