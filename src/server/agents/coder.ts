import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, DesignSpec, ArchitectureSpec } from "@/server/agent-contracts/schemas";
import { Sandbox } from "@e2b/code-interpreter";
import { createAgent } from "@inngest/agent-kit";
import { agentOutputText } from "@/features/inngest/utils";
import { z } from "zod";

export const IMPLEMENTATION_PROMPT = `
You are the Principal Full-Stack Engineer for CodeMytra.
Your role is to write clean, production-grade Next.js (App Router), TypeScript, and Tailwind CSS applications.

CRITICAL ARCHITECTURE RULES:
1. Generate complete, working source code for the application.
2. The main page MUST be located at "app/page.tsx" (using "use client"; for interactivity).
3. Use Tailwind CSS with clean, modern utility classes matching the design palette.
4. Include realistic state or seed data so the app is instantly usable upon preview.
5. Every imported component, style, or helper must be defined in the files array.
6. NEVER include hardcoded credentials, API keys, or secret tokens.
7. You MUST respond with a single valid JSON object matching this schema:
{
  "files": [
    {
      "path": "string",
      "content": "string"
    }
  ],
  "summary": "string"
}
Do NOT wrap your JSON in markdown code blocks (\`\`\`json). Return ONLY the raw valid JSON.
`;

export const ImplementationOutputSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(),
    })
  ).min(1),
  summary: z.string().min(1),
});

export interface ImplementationAgentInput {
  prompt: string;
  prd: PRD;
  designSpec: DesignSpec;
  architectureSpec: ArchitectureSpec;
  existingFiles?: Record<string, string> | null;
  sandboxId?: string;
}

export interface ImplementationResult {
  files: Record<string, string>;
  summary: string;
}

export class ImplementationError extends Error {
  constructor(message: string, public readonly rawOutput?: string) {
    super(message);
    this.name = "ImplementationError";
  }
}

/**
 * Runs the CodeMytra Implementation Agent to generate or modify full-stack application code.
 * Integrates PRD, DesignSpec, ArchitectureSpec, and existing files into the prompt.
 * Optionally writes generated files into a connected E2B sandbox.
 */
export async function runImplementationAgent(
  input: ImplementationAgentInput
): Promise<ImplementationResult> {
  const { prompt, prd, designSpec, architectureSpec, existingFiles, sandboxId } = input;

  const model = getGeminiModel({
    model: "gemini-2.5-pro",
    temperature: 0.1,
  });

  const isFollowUp = Boolean(existingFiles && Object.keys(existingFiles).length > 0);

  let userPrompt = `Application Name: ${prd.projectName}\nSummary: ${prd.summary}\n`;
  userPrompt += `Target Audience: ${prd.targetAudience}\n`;
  userPrompt += `Design Theme: ${designSpec.aestheticTheme} (Primary: ${designSpec.colorPalette.primary}, Accent: ${designSpec.colorPalette.accent})\n`;
  userPrompt += `Typography: ${designSpec.typography.headingFont} / ${designSpec.typography.bodyFont}\n\n`;

  if (isFollowUp) {
    userPrompt += `FOLLOW-UP MODIFICATION REQUEST:\n"${prompt}"\n\n`;
    userPrompt += `PRESERVATION REQUIREMENT: You are modifying an existing application. Retain all existing features, catalogs, and functionality while seamlessly adding the requested updates. Do NOT remove prior features.\n\n`;
    userPrompt += `CURRENT FILES IN PROJECT:\n`;
    for (const [filePath, content] of Object.entries(existingFiles || {})) {
      userPrompt += `--- START FILE: ${filePath} ---\n${content}\n--- END FILE: ${filePath} ---\n\n`;
    }
  } else {
    userPrompt += `INITIAL BUILD REQUEST:\n"${prompt}"\n\n`;
    userPrompt += `Required Core Features:\n${prd.coreFeatures.map((f) => `- ${f.name} (${f.priority}): ${f.description}`).join("\n")}\n\n`;
    userPrompt += `Planned Routes:\n${prd.pages.map((p) => `- ${p.route}: ${p.title} (${p.purpose})`).join("\n")}\n\n`;
    userPrompt += `Data Models:\n${architectureSpec.databaseModels.map((m) => `- ${m.modelName}: ${m.fields.join(", ")}`).join("\n")}\n\n`;
    userPrompt += `Route Endpoints:\n${architectureSpec.routeEndpoints.map((r) => `- ${r.path} (${r.type}): ${r.purpose}`).join("\n")}\n`;
  }

  const agent = createAgent({
    name: "implementation-agent",
    description: "Generates full-stack Next.js application code",
    system: IMPLEMENTATION_PROMPT,
    model,
  });

  const agentResult = await agent.run(userPrompt);
  const rawText = agentOutputText(agentResult.output, "").trim();
  let cleanedText = rawText.trim();
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.slice(7);
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.slice(3);
  }
  if (cleanedText.endsWith("```")) {
    cleanedText = cleanedText.slice(0, -3);
  }
  cleanedText = cleanedText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedText);
  } catch (parseErr) {
    throw new ImplementationError(
      `Implementation Agent output was not valid JSON: ${String(parseErr)}`,
      rawText
    );
  }

  const validation = ImplementationOutputSchema.safeParse(parsed);
  if (!validation.success) {
    throw new ImplementationError(
      `Implementation Agent output failed schema validation: ${validation.error.message}`,
      rawText
    );
  }

  const fileMap: Record<string, string> = {};
  // If follow-up, copy existing files as base
  if (isFollowUp && existingFiles) {
    Object.assign(fileMap, existingFiles);
  }
  for (const f of validation.data.files) {
    fileMap[f.path] = f.content;
  }

  // If connected sandbox provided, write generated files to sandbox
  if (sandboxId) {
    try {
      const sandbox = await Sandbox.connect(sandboxId);
      for (const f of validation.data.files) {
        await sandbox.files.write(f.path, f.content);
      }
    } catch (writeErr) {
      throw new ImplementationError(`Failed to write generated files to sandbox ${sandboxId}: ${String(writeErr)}`);
    }
  }

  return {
    files: fileMap,
    summary: validation.data.summary,
  };
}
