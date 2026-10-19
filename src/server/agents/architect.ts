import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, DesignSpec, ArchitectureSpec, ArchitectureSpecSchema } from "@/server/agent-contracts/schemas";
import { prisma } from "@/lib/db";
import { SpecStatus, Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { agentOutputText } from "@/features/inngest/utils";

export const ARCHITECT_PROMPT = `
You are a Principal Software Architect & Systems Designer for CodeMytra.
Your role is to inspect the Product Requirements Document (PRD) and Design Specification to establish the full-stack architecture, route endpoints, data models, business rules, and strict file ownership boundaries.

Architecture Rules:
1. Target Next.js 16 (App router, Server Components, Route Handlers, Server Actions).
2. Capability & Database Strategy:
   - Inspect PRD capabilities and data entities.
   - If PRD requires "data-persistence" or "crud-operations" or has persistent data entities:
     * Set "requiresDatabase": true.
     * Define "databaseModels" with fields compatible with SQLite (String, Int, Float, Boolean, DateTime).
     * Define "backendOperations" with concrete validation rules and HTTP status codes (200, 201, 400 for bad input, 404 for missing, 409 for conflicts).
     * File ownership includes: "database": ["prisma/schema.prisma", "lib/db.ts"].
   - If the application is static (e.g., developer portfolio, marketing landing page, documentation) without data persistence:
     * Set "requiresDatabase": false.
     * Set "databaseModels": [].
     * Set "database" file ownership to []. Do NOT generate unnecessary database infrastructure for static apps.
3. Establish clear file ownership boundaries:
   - Frontend files: app/page.tsx, components/**
   - Backend files: app/api/**, server/**
   - Database files: prisma/schema.prisma, lib/db.ts (only when requiresDatabase is true)
4. Define concrete UI components, API contracts, and domain business constraints (e.g. no overlapping bookings, stock cannot drop below zero, etc.).
5. List any needed npm/bun packages.

Respond with valid JSON matching this schema:
{
  "appType": "nextjs-fullstack",
  "capabilities": ["pages-navigation" | "data-persistence" | "crud-operations" | "authentication" | "authorization" | "forms-validation" | "file-handling" | "search-filtering" | "business-rules" | "external-integrations"],
  "requiresDatabase": boolean,
  "routeEndpoints": [
    { "path": "string", "type": "page" | "api" | "action", "purpose": "string", "methods": ["string"] }
  ],
  "uiComponents": [
    { "name": "string", "purpose": "string", "route": "string" }
  ],
  "databaseModels": [
    { "modelName": "string", "fields": ["string"], "relations": ["string"] }
  ],
  "backendOperations": [
    { "name": "string", "description": "string", "validationRules": ["string"], "authRequired": boolean }
  ],
  "businessConstraints": ["string"],
  "authRequirements": {
    "enabled": boolean,
    "strategy": "none" | "session" | "jwt"
  },
  "fileOwnership": {
    "frontend": ["app/**/*.tsx", "components/**/*.tsx"],
    "backend": ["app/api/**/*.ts", "server/**/*.ts"],
    "database": ["prisma/schema.prisma", "lib/db.ts"]
  },
  "dependencies": ["string"]
}
Do NOT wrap in markdown backticks or include any conversational filler. Only return raw JSON.
`;

export class ArchitectureError extends Error {
  constructor(message: string, public readonly rawOutput?: string) {
    super(message);
    this.name = "ArchitectureError";
  }
}

export interface ArchitectOptions {
  model?: string;
  temperature?: number;
}

export async function runArchitectureAgent(
  prd: PRD,
  designSpec: DesignSpec,
  maxRetries = 1,
  options?: ArchitectOptions
): Promise<ArchitectureSpec> {
  const selectedModel = options?.model || "gemini-2.5-pro";
  const model = getGeminiModel({
    model: selectedModel,
    temperature: options?.temperature ?? 0.2,
  });

  const agent = createAgent({
    name: "architect-agent",
    description: "Establishes full-stack route endpoints, models, and boundaries",
    system: ARCHITECT_PROMPT,
    model,
  });

  let currentPrompt = `PRD:\n${JSON.stringify(prd, null, 2)}\n\nDesignSpec:\n${JSON.stringify(designSpec, null, 2)}`;
  let lastError: unknown = null;
  let lastText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await agent.run(currentPrompt);
    const text = agentOutputText(result.output, "").trim();
    lastText = text;
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

    try {
      const rawJson = JSON.parse(cleaned);
      return ArchitectureSpecSchema.parse(rawJson);
    } catch (error) {
      lastError = error;
      console.warn(`[Architect] Attempt ${attempt + 1}/${maxRetries + 1} failed schema validation:`, error);
      if (attempt < maxRetries) {
        currentPrompt = `Your previous response had schema validation errors:\n${error instanceof Error ? error.message : String(error)}\n\nEnsure your response strictly matches the required ArchitectureSpec JSON schema without markdown wrappers or conversational filler. Re-evaluate the PRD and generate valid architecture:\n\nPRD:\n${JSON.stringify(prd, null, 2)}`;
      }
    }
  }

  // Bounded retries exhausted: throw structured ArchitectureError instead of silently degrading
  throw new ArchitectureError(
    `Architect agent failed to generate a valid Architecture Specification after ${maxRetries + 1} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastText
  );
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
