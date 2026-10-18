import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, DesignSpec, ArchitectureSpec, ArchitectureSpecSchema } from "@/server/agent-contracts/schemas";
import { prisma } from "@/lib/db";
import { SpecStatus, Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { agentOutputText } from "@/features/inngest/utils";

export const ARCHITECT_PROMPT = `
You are a Principal Software Architect & Systems Designer for CodeMytra.
Your role is to inspect the Product Requirements Document (PRD) and Design Specification to establish the full-stack architecture, route endpoints, data models, and strict file ownership boundaries.

Architecture Rules:
1. Target Next.js 16 (App router, Server Components, Route Handlers, Server Actions).
2. Establish clear file ownership boundaries:
   - Frontend files: app/page.tsx, components/**
   - Backend files: app/api/**, server/**
   - Database files: prisma/schema.prisma, lib/db.ts
3. Define concrete API and Server Action contracts before code generation starts.
4. List any needed npm/bun packages.

Respond with valid JSON matching this schema:
{
  "appType": "nextjs-fullstack",
  "routeEndpoints": [
    { "path": "string", "type": "page" | "api" | "action", "purpose": "string" }
  ],
  "databaseModels": [
    { "modelName": "string", "fields": ["string"] }
  ],
  "fileOwnership": {
    "frontend": ["app/**/*.tsx", "components/**/*.tsx"],
    "backend": ["app/api/**/*.ts", "server/**/*.ts"],
    "database": ["prisma/schema.prisma", "lib/db.ts"]
  },
  "dependencies": ["string"]
}
Do NOT wrap in markdown backticks or include any conversational filler. Only return raw JSON.
`;

export async function runArchitectureAgent(prd: PRD, designSpec: DesignSpec): Promise<ArchitectureSpec> {
  const model = getGeminiModel({
    model: "gemini-2.5-pro",
    temperature: 0.2,
  });

  const agent = createAgent({
    name: "architect-agent",
    description: "Establishes full-stack route endpoints, models, and boundaries",
    system: ARCHITECT_PROMPT,
    model,
  });

  const result = await agent.run(
    `PRD:\n${JSON.stringify(prd, null, 2)}\n\nDesignSpec:\n${JSON.stringify(designSpec, null, 2)}`
  );
  const text = agentOutputText(result.output, "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const rawJson = JSON.parse(cleaned);
    return ArchitectureSpecSchema.parse(rawJson);
  } catch (error) {
    console.error("[Architect] Failed to parse ArchitectureSpec output:", error, "Raw response:", text);
    // Safe default architecture
    return {
      appType: "nextjs-fullstack",
      routeEndpoints: [
        {
          path: "/",
          type: "page",
          purpose: "Main page rendering UI components",
        },
      ],
      databaseModels: [],
      fileOwnership: {
        frontend: ["app/**/*.tsx", "components/**/*.tsx"],
        backend: ["app/api/**/*.ts", "server/**/*.ts"],
        database: ["prisma/schema.prisma", "lib/db.ts"],
      },
      dependencies: [],
    };
  }
}

export async function saveArchitectureSpec(projectId: string, archSpec: ArchitectureSpec) {
  const specJson = archSpec as unknown as Prisma.InputJsonObject;

  return prisma.projectSpecification.update({
    where: { projectId },
    data: {
      architectureSpec: specJson,
      status: SpecStatus.APPROVED,
    },
  });
}
