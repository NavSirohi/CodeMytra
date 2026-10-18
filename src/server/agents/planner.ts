import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, PRDSchema } from "@/server/agent-contracts/schemas";
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

export async function runPlannerAgent(prompt: string): Promise<PRD> {
  const model = getGeminiModel({
    model: "gemini-2.5-pro",
    temperature: 0.2,
  });

  const agent = createAgent({
    name: "planner-agent",
    description: "Generates structured application PRDs",
    system: PLANNER_PROMPT,
    model,
  });

  const result = await agent.run(`User Application Request:\n"${prompt}"`);
  const text = agentOutputText(result.output, "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const rawJson = JSON.parse(cleaned);
    return PRDSchema.parse(rawJson);
  } catch (error) {
    console.error("[Planner] Failed to parse PRD output:", error, "Raw response:", text);
    // Fallback safe PRD to avoid blocking generation
    return {
      projectName: "Generated Application",
      summary: prompt,
      targetAudience: "General Users",
      coreFeatures: [
        {
          name: "Main Feature Set",
          description: prompt,
          priority: "MUST",
        },
      ],
      pages: [
        {
          route: "/",
          title: "Home",
          purpose: "Primary application dashboard and entry point",
          keyComponents: ["Header", "MainSection", "Footer"],
        },
      ],
      dataEntities: [],
      userFlows: [
        {
          name: "Primary Journey",
          steps: ["Open application", "Interact with core features"],
        },
      ],
    };
  }
}

/**
 * Persists or updates the project PRD in the database.
 */
export async function saveProjectPRD(projectId: string, prd: PRD) {
  const prdJson = prd as unknown as Prisma.InputJsonObject;

  return prisma.projectSpecification.upsert({
    where: { projectId },
    create: {
      projectId,
      prd: prdJson,
      status: SpecStatus.AWAITING_APPROVAL,
    },
    update: {
      prd: prdJson,
      status: SpecStatus.AWAITING_APPROVAL,
    },
  });
}
