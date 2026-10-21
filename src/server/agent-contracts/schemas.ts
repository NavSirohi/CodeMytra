import { z } from "zod";

/**
 * Reusable Full-Stack Application Capability Definitions (Milestone M2)
 */
export const ApplicationCapabilityEnum = z.enum([
  "pages-navigation",      // Routes, layouts and navigation
  "data-persistence",     // Models, relationships and database/file storage
  "crud-operations",      // Create, read, update, delete operations
  "authentication",       // Login, registration and sessions when required
  "authorization",        // Access control and role-based permissions
  "forms-validation",     // Inputs, client/server validation, and feedback
  "file-handling",        // File uploads and asset workflows
  "search-filtering",     // Querying, filtering, sorting, pagination
  "business-rules",       // Domain-specific business logic & constraints
  "external-integrations",// Supported APIs with explicit credentials and limitations
]);
export type ApplicationCapability = z.infer<typeof ApplicationCapabilityEnum>;

/**
 * Product Requirements Document (PRD) Schema
 * Emitted by the Planning / Requirements Agent
 */
export const PRDSchema = z.object({
  projectName: z.string(),
  summary: z.string(),
  targetAudience: z.string(),
  capabilities: z.array(ApplicationCapabilityEnum).default(["pages-navigation"]),
  unsupportedRequirements: z.array(z.string()).default([]),
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
      isPersistent: z.boolean().default(false),
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
  capabilities: z.array(ApplicationCapabilityEnum).default(["pages-navigation"]),
  requiresDatabase: z.boolean().default(false),
  routeEndpoints: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["page", "api", "action"]),
      purpose: z.string(),
      methods: z.array(z.string()).optional(),
    })
  ),
  uiComponents: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      route: z.string().optional(),
    })
  ).default([]),
  databaseModels: z.array(
    z.object({
      modelName: z.string(),
      fields: z.array(z.string()),
      relations: z.array(z.string()).default([]),
    })
  ).default([]),
  backendOperations: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      validationRules: z.array(z.string()).default([]),
      authRequired: z.boolean().default(false),
    })
  ).default([]),
  businessConstraints: z.array(z.string()).default([]),
  authRequirements: z.object({
    enabled: z.boolean().default(false),
    strategy: z.string().default("none"),
  }).default({
    enabled: false,
    strategy: "none",
  }),
  externalIntegrations: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      limitations: z.string().default("none"),
    })
  ).default([]),
  userJourneys: z.array(
    z.object({
      name: z.string(),
      steps: z.array(z.string()),
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
export const QACheckCategoryEnum = z.enum([
  "static-source",
  "sandbox-connection",
  "typescript-validation",
  "production-build",
  "runtime-health",
  "database-validation",
  "api-validation",
]);
export type QACheckCategory = z.infer<typeof QACheckCategoryEnum>;

export const QACheckSchema = z.object({
  name: z.string(),
  category: QACheckCategoryEnum,
  status: z.enum(["PASS", "FAIL", "SKIPPED"]),
  details: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  timeout: z.boolean().optional(),
});

export const QAReportSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  checks: z.array(QACheckSchema),
  repairNeeded: z.boolean(),
  repairInstructions: z.string().optional(),
  verificationMode: z.enum(["sandbox-verified", "static-only"]).default("static-only"),
  isInfrastructureTimeout: z.boolean().default(false),
  summary: z.string().default("Verification executed"),
  executedCategories: z.array(QACheckCategoryEnum).default([]),
});

export type QAReport = z.infer<typeof QAReportSchema>;
