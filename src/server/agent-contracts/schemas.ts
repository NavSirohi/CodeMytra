import { z } from "zod";

/**
 * Product Requirements Document (PRD) Schema
 * Emitted by the Planning / Requirements Agent
 */
export const PRDSchema = z.object({
  projectName: z.string(),
  summary: z.string(),
  targetAudience: z.string(),
  coreFeatures: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      priority: z.enum(["MUST", "SHOULD", "COULD"]),
    })
  ),
  pages: z.array(
    z.object({
      route: z.string(),
      title: z.string(),
      purpose: z.string(),
      keyComponents: z.array(z.string()),
    })
  ),
  dataEntities: z.array(
    z.object({
      name: z.string(),
      fields: z.array(z.string()),
      relationships: z.array(z.string()).default([]),
    })
  ).default([]),
  userFlows: z.array(
    z.object({
      name: z.string(),
      steps: z.array(z.string()),
    })
  ).default([]),
});

export type PRD = z.infer<typeof PRDSchema>;

/**
 * Design Specification Schema
 * Emitted by the Design Agent
 */
export const DesignSpecSchema = z.object({
  aestheticTheme: z.string(),
  colorPalette: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
  }),
  typography: z.object({
    headingFont: z.string().default("Geist"),
    bodyFont: z.string().default("Geist Sans"),
  }),
  layoutStyle: z.string(),
  componentGuidelines: z.array(
    z.object({
      componentName: z.string(),
      stylingRules: z.string(),
    })
  ).default([]),
});

export type DesignSpec = z.infer<typeof DesignSpecSchema>;

/**
 * Architecture Specification Schema
 * Emitted by the Architecture Agent
 */
export const ArchitectureSpecSchema = z.object({
  appType: z.literal("nextjs-fullstack").default("nextjs-fullstack"),
  routeEndpoints: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["page", "api", "action"]),
      purpose: z.string(),
    })
  ),
  databaseModels: z.array(
    z.object({
      modelName: z.string(),
      fields: z.array(z.string()),
    })
  ).default([]),
  fileOwnership: z.record(z.string(), z.array(z.string())).default({
    frontend: ["app/**/*.tsx", "components/**/*.tsx"],
    backend: ["app/api/**/*.ts", "server/**/*.ts"],
    database: ["prisma/schema.prisma", "lib/db.ts"],
  }),
  dependencies: z.array(z.string()).default([]),
});

export type ArchitectureSpec = z.infer<typeof ArchitectureSpecSchema>;

/**
 * QA & Verification Report Schema
 * Emitted by the QA Agent
 */
export const QACheckSchema = z.object({
  name: z.string(),
  status: z.enum(["PASS", "FAIL", "SKIPPED"]),
  details: z.string().optional(),
});

export const QAReportSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  checks: z.array(QACheckSchema),
  repairNeeded: z.boolean(),
  repairInstructions: z.string().optional(),
  verificationMode: z.enum(["sandbox-verified", "static-only"]).default("static-only"),
});

export type QAReport = z.infer<typeof QAReportSchema>;
