import { getGeminiModel } from "@/server/providers/gemini";
import { PRD, DesignSpec, DesignSpecSchema } from "@/server/agent-contracts/schemas";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { createAgent } from "@inngest/agent-kit";
import { agentOutputText } from "@/features/inngest/utils";
import { extractUsageMetadata } from "@/server/observability/metrics";
import { runWithoutStepContext } from "@/server/orchestration/async-context";

export const DESIGNER_PROMPT = `
You are a Principal UI/UX Designer & Design Systems Architect for CodeMytra.
Your role is to translate a Product Requirements Document (PRD) into an original, coherent, accessible design specification using modern Tailwind CSS & Shadcn design tokens.

Guidelines:
1. Choose an aesthetic theme appropriate for the domain (e.g. "minimalist-saas", "warm-editorial", "high-contrast-dashboard").
2. Create an accessible WCAG-compliant color palette (primary, secondary, accent, background, surface, text).
3. Specify typography and component guidelines.
4. Do NOT copy copyrighted designs wholesale. Produce original, clean design directions.

Respond with valid JSON matching this schema:
{
  "aestheticTheme": "string",
  "colorPalette": {
    "primary": "string (hex or tailwind color)",
    "secondary": "string",
    "accent": "string",
    "background": "string",
    "surface": "string",
    "text": "string"
  },
  "typography": {
    "headingFont": "string",
    "bodyFont": "string"
  },
  "layoutStyle": "string",
  "componentGuidelines": [
    { "componentName": "string", "stylingRules": "string" }
  ]
}
Do NOT wrap in markdown backticks or include any conversational filler. Only return raw JSON.
`;

export interface DesignerOptions {
  model?: string;
  temperature?: number;
}

export async function runDesignAgent(prd: PRD, options?: DesignerOptions): Promise<DesignSpec> {
  const selectedModel = options?.model || "gemini-2.5-flash";
  const model = getGeminiModel({
    model: selectedModel,
    temperature: options?.temperature ?? 0.3,
  });

  const agent = createAgent({
    name: "designer-agent",
    description: "Generates design token specifications and palettes",
    system: DESIGNER_PROMPT,
    model,
  });

  const result = await runWithoutStepContext(() =>
    agent.run(`Project Requirements:\n${JSON.stringify(prd, null, 2)}`)
  );
  const text = agentOutputText(result.output, "").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

  const usage = extractUsageMetadata(result);

  try {
    const rawJson = JSON.parse(cleaned);
    const spec = DesignSpecSchema.parse(rawJson) as DesignSpec & {
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      modelId?: string;
    };
    if (usage) {
      spec.usage = usage;
    }
    spec.modelId = selectedModel;
    return spec;
  } catch (error) {
    console.error("[Designer] Failed to parse DesignSpec output:", error, "Raw response:", text);
    // Safe default design spec
    return {
      aestheticTheme: "modern-minimalist",
      colorPalette: {
        primary: "#3b82f6",
        secondary: "#64748b",
        accent: "#06b6d4",
        background: "#09090b",
        surface: "#18181b",
        text: "#fafafa",
      },
      typography: {
        headingFont: "Geist",
        bodyFont: "Geist Sans",
      },
      layoutStyle: "clean-grid",
      componentGuidelines: [
        {
          componentName: "Card",
          stylingRules: "rounded-xl border border-border/50 bg-card p-4 shadow-sm",
        },
      ],
    };
  }
}

export async function saveDesignSpec(projectId: string, designSpec: DesignSpec) {
  const specJson = designSpec as unknown as Prisma.InputJsonObject;

  return prisma.projectSpecification.update({
    where: { projectId },
    data: {
      designSpec: specJson,
    },
  });
}
