import path from "path";
import { Sandbox } from "@e2b/code-interpreter";
import {
  createAgent,
  createTool,
  createNetwork,
  createState,
} from "@inngest/agent-kit";
import { z } from "zod";
import { getOpenAIModel } from "@/server/providers/openai";
import {
  PRD,
  DesignSpec,
  ArchitectureSpec,
} from "@/server/agent-contracts/schemas";
import {
  PROJECT_WORKSPACE_DIR,
  resolveWorkspacePath,
} from "@/server/orchestration/workspace";
import {
  lastAssistantTextMessageContent,
} from "@/features/inngest/utils";
import { extractUsageMetadata } from "@/server/observability/metrics";
import {
  GENERATION_LIMITS,
  GenerationTimeoutError,
  RunAbortedError,
  TokenBudgetExceededError,
  NoProgressError,
  IterationLimitExceededError,
  getRemainingTimeMs,
  boundOperationTimeout,
} from "@/server/orchestration/stage-optimizer";
import { isRunActiveInDb } from "@/server/orchestration/finalization";
import { runWithoutStepContext } from "@/server/orchestration/async-context";

export interface CodeAgentState {
  sandboxId: string;
  summary: string;
  files: Record<string, string>;
  promptTokens?: number;
  completionTokens?: number;
  hasUsage?: boolean;
  iterationCount?: number;
  filesWrittenCount?: number;
  wroteFilesInLastTurn?: boolean;
  consecutiveNoWriteTurns?: number;
  lastToolUsed?: string;
}

export interface CodingAgentResult {
  files: Record<string, string>;
  summary: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  modelId?: string;
}

export interface InngestStepLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: <T>(name: string, fn: () => Promise<T>) => Promise<any>;
}

export interface RunCodingAgentOptions {
  sandboxId: string;
  prompt: string;
  prd: PRD;
  designSpec: DesignSpec;
  architectureSpec: ArchitectureSpec;
  baseFiles?: Record<string, string> | null;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  step?: InngestStepLike;
  stepPrefix?: string;
  model?: string;
  generationRunId?: string;
  deadlineMs?: number;
  maxIterations?: number;
  tokenBudget?: number;
}

export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024; // 256 KB
export const MAX_COMMAND_TIMEOUT_MS = 30000; // 30s

export const FORBIDDEN_COMMAND_PATTERNS = [
  /\.env(\b|\.|$)/i,
  /\b(id_rsa|id_ecdsa|id_ed25519)\b/i,
  /\.pem\b/i,
  /\.key\b/i,
  /\/etc\/(shadow|gshadow|sudoers)/i,
  /\/proc\/(\d+|self)\/environ/i,
  /\bcd\s+(\.\.|\/|~)/i,
  /\.\.\//,
  /\b(curl|wget)\b.*(@|--upload-file|--post-file)/i,
];

/**
 * Application-level command guardrail.
 *
 * Security Architecture Note:
 * In accordance with defense-in-depth principles, pattern-based command filtering serves as
 * an application-level guardrail to intercept accidental environment/secret access or workspace
 * escaping. The isolated E2B microVM hypervisor container boundary provides the primary,
 * authoritative security barrier against malicious execution.
 */
export function validateSandboxCommand(command: string): { allowed: boolean; reason?: string } {
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Command blocked by security policy: contains restricted pattern "${pattern.source}". Direct access to platform secrets, environment files, or escaping project workspace is prohibited.`,
      };
    }
  }
  return { allowed: true };
}

export const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.|$)/i,
  /\.(pem|key|secret|token)$/i,
  /id_rsa/i,
  /credentials\.json$/i,
];

export function isSensitiveFilePath(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(base));
}

/**
 * Authoritative set of foundation-owned files.
 * The deterministic CodeMytra foundation owns package dependencies, tsconfig, Next config,
 * Tailwind configuration, Prisma configuration, and database client setup.
 * The AI coder and repair agent must never overwrite these files.
 */
export const PROTECTED_FOUNDATION_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "next.config.mjs",
  "next.config.ts",
  "next.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.mjs",
  "postcss.config.js",
  "prisma/schema.prisma",
  "prisma.config.ts",
  "lib/db.ts",
  "lib/utils.ts",
  ".env.example",
]);

export function isProtectedFoundationFile(relPath: string): boolean {
  const normalizedRel = path.normalize(relPath).replace(/^(\.\/|\/)/, "");
  return PROTECTED_FOUNDATION_FILES.has(normalizedRel);
}

export interface BatchFileWriteTarget {
  path: string;
  content: string;
}

export interface SandboxFilesClient {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  write: (path: string, data: string) => Promise<unknown>;
  remove: (path: string) => Promise<unknown>;
}

export interface BatchFileWriteResult {
  success: boolean;
  filesWritten?: string[];
  count?: number;
  error?: string;
  failedFile?: string;
  rolledBack?: boolean;
  unrecoveredFilesystem?: boolean;
  updatedMap?: Record<string, string>;
}

/**
 * Executes a batch file write against sandbox files with pre-validation,
 * pre-write state snapshotting, sequential writes, and automated rollback upon write failure.
 * Automatically preserves and protects foundation-owned files from AI overwrites.
 */
export async function executeBatchFileWrites(
  filesClient: SandboxFilesClient,
  files: BatchFileWriteTarget[],
  options?: { allowFoundationFiles?: boolean }
): Promise<BatchFileWriteResult> {
  // Filter out protected foundation files to enforce single authoritative ownership
  const eligibleFiles = options?.allowFoundationFiles
    ? files
    : files.filter((f) => !isProtectedFoundationFile(f.path));

  if (eligibleFiles.length === 0) {
    return {
      success: true,
      filesWritten: [],
      count: 0,
      updatedMap: {},
    };
  }

  // STEP 1: Pre-validation of incoming paths, duplicates, and file sizes
  const seenNormalizedPaths = new Set<string>();
  const validatedFiles: Array<{
    relativePath: string;
    fullWorkspacePath: string;
    content: string;
  }> = [];

  for (const file of eligibleFiles) {
    const normalizedRel = path.normalize(file.path).replace(/^(\.\/|\/)/, "");
    if (seenNormalizedPaths.has(normalizedRel)) {
      return {
        success: false,
        error: `Duplicate file path "${file.path}" in batch is forbidden. Each path must be unique.`,
        failedFile: file.path,
      };
    }
    seenNormalizedPaths.add(normalizedRel);

    // Path boundary validation
    let fullWorkspacePath: string;
    try {
      fullWorkspacePath = resolveWorkspacePath(file.path);
    } catch {
      return {
        success: false,
        error: `Path traversal forbidden: file "${file.path}" resolves outside project workspace.`,
        failedFile: file.path,
      };
    }

    // Sensitive file policy check
    if (isSensitiveFilePath(file.path)) {
      return {
        success: false,
        error: `Writing to sensitive file "${file.path}" is forbidden by security policy.`,
        failedFile: file.path,
      };
    }

    // Resource limit check per file (1 MB)
    const fileBytes = Buffer.byteLength(file.content || "", "utf8");
    if (fileBytes > 1024 * 1024) {
      return {
        success: false,
        error: `File "${file.path}" exceeds maximum size limit of 1 MB (${fileBytes} bytes).`,
        failedFile: file.path,
      };
    }

    validatedFiles.push({
      relativePath: file.path,
      fullWorkspacePath,
      content: file.content,
    });
  }

  // STEP 2: Capture pre-write state of every target file before any writes
  const preWriteStates: Array<{
    relativePath: string;
    fullWorkspacePath: string;
    content: string;
    existed: boolean;
    originalContent: string | null;
  }> = [];

  for (const vFile of validatedFiles) {
    let existed = false;
    let originalContent: string | null = null;
    try {
      existed = await filesClient.exists(vFile.fullWorkspacePath);
    } catch (existsErr) {
      return {
        success: false,
        error: `Pre-write existence check failed for "${vFile.relativePath}": ${existsErr instanceof Error ? existsErr.message : String(existsErr)}. Write batch aborted.`,
        failedFile: vFile.relativePath,
        unrecoveredFilesystem: false,
      };
    }

    if (existed) {
      try {
        originalContent = await filesClient.read(vFile.fullWorkspacePath);
      } catch (readErr) {
        // Do NOT interpret a failed pre-write read as a missing file.
        // Abort immediately before any writes occur to guarantee zero filesystem mutation.
        return {
          success: false,
          error: `Pre-write read failed for existing file "${vFile.relativePath}": ${readErr instanceof Error ? readErr.message : String(readErr)}. Write batch aborted to protect existing file.`,
          failedFile: vFile.relativePath,
          unrecoveredFilesystem: false,
        };
      }
    }

    preWriteStates.push({
      relativePath: vFile.relativePath,
      fullWorkspacePath: vFile.fullWorkspacePath,
      content: vFile.content,
      existed,
      originalContent,
    });
  }

  // STEP 3: Sequentially write files and track successful writes
  const successfullyWritten: Array<{
    relativePath: string;
    fullWorkspacePath: string;
    existed: boolean;
    originalContent: string | null;
  }> = [];

  for (const item of preWriteStates) {
    try {
      await filesClient.write(item.fullWorkspacePath, item.content);
      successfullyWritten.push(item);
    } catch (writeErr) {
      // A write failed!
      // Must include the failing write target `item` in rollback because the write may have partially changed its contents
      const rollbackTargets = [item, ...[...successfullyWritten].reverse()];
      const rollbackErrors: string[] = [];

      for (const target of rollbackTargets) {
        try {
          if (target.existed && target.originalContent !== null) {
            await filesClient.write(target.fullWorkspacePath, target.originalContent);
            // Verify rollback completed: file must exist and content must match originalContent
            const existsAfter = await filesClient.exists(target.fullWorkspacePath);
            if (!existsAfter) {
              rollbackErrors.push(
                `Rollback verification failed for "${target.relativePath}": file missing after restoration write.`
              );
              continue;
            }
            const contentAfter = await filesClient.read(target.fullWorkspacePath);
            if (contentAfter !== target.originalContent) {
              rollbackErrors.push(
                `Rollback verification failed for "${target.relativePath}": restored content does not match original.`
              );
            }
          } else {
            // Target was not pre-existing: remove any partial/created file
            await filesClient.remove(target.fullWorkspacePath);
            // Verify rollback completed: file must no longer exist
            const existsAfter = await filesClient.exists(target.fullWorkspacePath);
            if (existsAfter) {
              rollbackErrors.push(
                `Rollback verification failed for "${target.relativePath}": file still exists after removal.`
              );
            }
          }
        } catch (rbErr) {
          rollbackErrors.push(
            `Failed restoring "${target.relativePath}": ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`
          );
        }
      }

      if (rollbackErrors.length > 0) {
        return {
          success: false,
          error: `UNRECOVERED_FILESYSTEM_ERROR: Write failed on "${item.relativePath}" and rollback could not be verified:\n${rollbackErrors.join("\n")}`,
          failedFile: item.relativePath,
          unrecoveredFilesystem: true,
          rolledBack: false,
        };
      }

      return {
        success: false,
        error: `Write failed on "${item.relativePath}": ${writeErr instanceof Error ? writeErr.message : String(writeErr)}. All ${rollbackTargets.length} affected files were verified and restored to their original pre-write state.`,
        failedFile: item.relativePath,
        rolledBack: true,
        unrecoveredFilesystem: false,
      };
    }
  }

  // STEP 4: All writes succeeded without error
  const updatedMap = validatedFiles.reduce((acc, f) => {
    acc[f.relativePath] = f.content;
    return acc;
  }, {} as Record<string, string>);

  return {
    success: true,
    filesWritten: validatedFiles.map((f) => f.relativePath),
    count: validatedFiles.length,
    updatedMap,
  };
}

export interface CodingAgentResult {
  files: Record<string, string>;
  summary: string;
}

export class CodingAgentError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "CodingAgentError";
  }
}

/**
 * Generates TypeScript interface definitions from architecture database models
 * to provide the AI coder with explicit, compiler-verified type contracts.
 */
export function formatModelInterfacesForPrompt(
  models?: Array<{ modelName: string; fields: string[]; relations?: string[] }>
): string {
  if (!models || models.length === 0) return "";
  return models
    .map((m) => {
      const rawFields = m.fields || [];
      const lines: string[] = [];
      const seenFields = new Set<string>();

      for (const f of rawFields) {
        const clean = f.replace(":", " ").trim().replace(/\s+/g, " ");
        const parts = clean.split(" ");
        const name = parts[0];
        if (name === "id" || seenFields.has(name)) continue;
        seenFields.add(name);

        const type = parts[1] || "String";
        let tsType = "string";
        if (
          /Int|Float|Decimal|Number/i.test(type) ||
          /price|amount|cost|total|rating|score|count|quantity|stock/i.test(name)
        ) {
          tsType = "number";
        } else if (/Boolean/i.test(type) || /^(is|has|can)[A-Z]/i.test(name)) {
          tsType = "boolean";
        } else if (/DateTime|Date/i.test(type) || /date|time|at$/i.test(name)) {
          tsType = "Date | string";
        }
        const isOptional = type.includes("?") || name.endsWith("Id");
        lines.push(`  ${name}${isOptional ? "?" : ""}: ${tsType};`);
      }

      // Guarantee essential business properties on common models
      const lowerName = m.modelName.toLowerCase();
      if (lowerName === "order") {
        if (!seenFields.has("totalPrice")) lines.push("  totalPrice: number;");
        if (!seenFields.has("orderDate")) lines.push("  orderDate: Date | string;");
        if (!seenFields.has("status")) lines.push("  status: string;");
      } else if (lowerName === "book") {
        if (!seenFields.has("price")) lines.push("  price: number;");
        if (!seenFields.has("stock")) lines.push("  stock: number;");
      } else if (lowerName === "review") {
        if (!seenFields.has("rating")) lines.push("  rating: number;");
      } else if (lowerName === "user") {
        if (!seenFields.has("email")) lines.push("  email: string;");
      }

      return `export interface ${m.modelName} {\n  id: string;\n${lines.join("\n")}\n  createdAt?: Date | string;\n  updatedAt?: Date | string;\n}`;
    })
    .join("\n\n");
}

/**
 * Builds the authoritative context prompt for the Implementation Agent,
 * embedding PRD, DesignSpec, ArchitectureSpec, and project rules.
 */
export function buildContextEnhancedPrompt(
  prd: PRD,
  designSpec: DesignSpec,
  archSpec: ArchitectureSpec
): string {
  const requiresDb = archSpec.requiresDatabase;
  const modelInterfaces = formatModelInterfacesForPrompt(archSpec.databaseModels);

  return `
You are the Lead Full-Stack Code Implementation Agent for CodeMytra.
Build a complete, working, interactive Next.js application adhering strictly to the approved specifications.
All source files must reside in the project workspace (${PROJECT_WORKSPACE_DIR}).

=== APPROVED PRODUCT REQUIREMENTS ===
Project: ${prd.projectName || "CodeMytra Project"}
Summary: ${prd.summary || "Full-stack web application"}
Target Audience: ${prd.targetAudience || "General users"}
Capabilities: ${archSpec.capabilities?.join(", ") || prd.capabilities?.join(", ") || "pages-navigation"}
Requires Persistence: ${requiresDb ? "YES (isolated SQLite database)" : "NO (static / client state)"}

Pages to implement:
${(prd.pages || []).map((p) => `- ${p.route} (${p.title}): ${p.purpose} [Components: ${p.keyComponents?.join(", ") || "Main"}]`).join("\n") || "- / (Home): Main application page"}

Data Entities:
${prd.dataEntities?.length ? prd.dataEntities.map((e) => `- ${e.name} (persistent: ${e.isPersistent ? "YES" : "NO"}): fields=[${e.fields.join(", ")}], relationships=[${e.relationships?.join(", ") || "none"}]`).join("\n") : "None specified"}

User Flows:
${prd.userFlows?.length ? prd.userFlows.map((f) => `- ${f.name}: ${f.steps.join(" -> ")}`).join("\n") : "Standard user journey"}

=== DESIGN SPECIFICATION ===
Theme: ${designSpec.aestheticTheme || "Modern Clean"}
Primary: ${designSpec.colorPalette?.primary || "#2563eb"} | Secondary: ${designSpec.colorPalette?.secondary || "#475569"} | Surface: ${designSpec.colorPalette?.surface || "#ffffff"} | Text: ${designSpec.colorPalette?.text || "#0f172a"}
Font: ${designSpec.typography?.headingFont || "Inter"} / ${designSpec.typography?.bodyFont || "Inter"}
Layout: ${designSpec.layoutStyle || "Responsive single-page"}

=== ARCHITECTURE SPECIFICATION ===
Routes & Endpoints:
${(archSpec.routeEndpoints || []).map((r) => `- [${r.type.toUpperCase()}] ${r.path}: ${r.purpose}${r.methods ? ` (Methods: ${r.methods.join(", ")})` : ""}`).join("\n") || "- [PAGE] /: Main application entry point"}

${requiresDb ? `Database Models:
${archSpec.databaseModels?.length ? archSpec.databaseModels.map((m) => `- ${m.modelName} (${m.fields.join(", ")})${m.relations?.length ? ` [Relations: ${m.relations.join(", ")}]` : ""}`).join("\n") : "- Default entities"}
` : "Database Models: None required (static application)"}

Backend Operations & Validation:
${archSpec.backendOperations?.length ? archSpec.backendOperations.map((o) => `- ${o.name}: ${o.description} [Validation: ${o.validationRules.join("; ") || "Input required"}]`).join("\n") : "Standard Next.js route handlers"}

Business Constraints:
${archSpec.businessConstraints?.length ? archSpec.businessConstraints.map((c) => `- ${c}`).join("\n") : "Enforce data integrity and standard validation rules"}

File Boundaries:
- Frontend: ${archSpec.fileOwnership?.frontend?.join(", ") || "app/page.tsx, components/**"}
- Backend: ${archSpec.fileOwnership?.backend?.length ? archSpec.fileOwnership.backend.join(", ") : "None required for static app"}
- Database: ${requiresDb && archSpec.fileOwnership?.database ? archSpec.fileOwnership.database.join(", ") : "None required for static app"}

=== FOUNDATION OWNERSHIP & INFRASTRUCTURE BOUNDARIES ===
The deterministic CodeMytra Foundation authoritatively owns package dependencies, tsconfig, Next config, Tailwind configuration, and database client setup.
Do NOT attempt to write or overwrite:
- "package.json", "tsconfig.json", "next.config.mjs"
- "tailwind.config.ts", "postcss.config.mjs"
- "lib/utils.ts" (already exports the canonical 'cn' function)
- "lib/db.ts", "prisma.config.ts", "prisma/schema.prisma" (already generated and configured)

=== CRITICAL EXECUTION DIRECTIVES: COMPLETE, CONSISTENT DELIVERY ===
1. REQUIRED ROOT PAGE: You MUST create app/page.tsx in EVERY initial generation (also when the requested website primarily uses other routes). Export a valid default React component with meaningful content and navigation. Do not merely describe the home page in the summary.
2. PLAN FILES BEFORE WRITING: Build a dependency graph of every page, component, hook, type, utility and API route you intend to import. Every local import MUST correspond to a real generated file or an existing foundation file. Inspect the existing project with readFiles when needed, especially during repair/follow-ups.
3. COMPLETE FILE WRITES: Write all mutually dependent files, including app/page.tsx, in coherent batches. If you hit a tool or output limit, continue in subsequent batches. Never terminate with promised files unwritten. Before concluding, use readFiles to verify app/page.tsx and any shared utility/type modules referenced by generated code exist.
4. IMPORT RULE: Prefer explicit imports such as @/components/Header. Do not import @/components unless components/index.ts exists and actually exports every imported symbol. A type imported from @/lib/types requires a real lib/types.ts; do not invent paths.
5. TYPESCRIPT: Use explicit types for arrays, keyed records, form state, component props, API payloads and timer data. Never suppress errors with @ts-ignore or ts-nocheck. Avoid placeholder interfaces and dead buttons; implement requested behavior.
6. DEPENDENCIES: Use dependencies declared by the foundation manifest. Do not import new npm libraries without a supported manifest reconciliation path; prefer available platform dependencies. Do not change foundation-owned configuration files.
7. DB/SECURITY: Use foundation Prisma models exactly as specified; never store plain-text passwords or expose user records through unauthenticated GET endpoints. If secure authentication cannot be completed with the available contract, report that limitation instead of claiming it works.
8. FINAL VERIFICATION: Finish only after all required files have been written. QA owns build execution; your summary must accurately identify implemented and omitted functionality. In QA repair, address every supplied diagnostic with actual file changes, not a textual explanation.

5. IF requiresDb IS TRUE (Full-Stack Application):
   - ACCESS DATABASE VIA: import { db } from "@/lib/db";
   - EXPECTED MODEL TYPES (Use these TypeScript contracts across pages and API routes):
${modelInterfaces}

   - API ROUTE IMPLEMENTATION REQUIREMENTS (app/api/**/route.ts):
     Every API route file must export standard Next.js App Router HTTP handlers:
     export async function GET(request: Request) { ... }
     export async function POST(request: Request) { ... }
     - app/api/books/route.ts:
       - GET: query db.book.findMany(), support query filtering, return NextResponse.json(books, { status: 200 })
       - POST: validate body { title, author, price }, return 400 if invalid, create record, return 201
     - app/api/reviews/route.ts:
       - GET: query db.review.findMany(), filter by bookId if present, return 200
       - POST: validate body { rating, comment, bookId }, return 400 if invalid, create record, return 201
     - app/api/users/route.ts:
       - GET: query db.user.findMany(), return 200
       - POST: validate body { email, name }, return 400 if invalid, create record, return 201
     - app/api/orders/route.ts:
       - GET: query db.order.findMany({ orderBy: { createdAt: "desc" } }), return 200
       - POST: validate body { totalPrice, items }, return 400 if invalid, create record with orderDate and status, return 201
     - If database tables are initially empty, seed realistic default items in GET handlers before returning so frontend preview renders populated content immediately.

   - CLIENT COMPONENT TYPE SAFETY RULES (e.g. app/profile/page.tsx, app/orders/page.tsx):
     - When using useState in client components ("use client"), NEVER leave useState([]) untyped because TypeScript infers never[]!
       ALWAYS explicitly provide the generic type parameter:
       const [orders, setOrders] = useState<Order[]>([]);
       const [books, setBooks] = useState<Book[]>([]);
       const [reviews, setReviews] = useState<Review[]>([]);
       const [user, setUser] = useState<User | null>(null);
     - Ensure all property accesses match the model interface: order.id, order.totalPrice, order.orderDate, order.status.
     - Handle dates safely: typeof order.orderDate === "string" ? new Date(order.orderDate).toLocaleDateString() : order.orderDate?.toLocaleDateString()

6. IF requiresDb IS FALSE (Static Application / Landing Page / Fixture A):
   - Keep the app lean, fast, and 100% self-contained.
   - Do NOT generate any prisma schema, dev.db, sqlite configuration, or backend database files.
   - Implement rich interactive features (menus, shopping cart simulation, filters, search, contact/newsletter forms, booking inquiries) using React client state in "app/page.tsx" or modular components.
   - Put "use client"; on line 1 of interactive components.

7. Put the primary landing content and user interface in app/page.tsx. ALWAYS put "use client"; on line 1 of any interactive component or page using useState, useEffect, onClick, or browser events.
8. COMPLETE FUNCTIONAL IMPLEMENTATION (NO PLACEHOLDERS):
   - Never generate empty placeholders, stub components, or explanatory placeholder text (e.g. "Calendar management functionality will be displayed here" or "// TODO: Add booking grid").
   - Always implement genuine, interactive UI components: full interactive month/week calendar grids, active day/slot pickers, event modals, sortable data tables, and live status badges.
   - SECURITY & SENSITIVE DATA: Never store plaintext passwords in database models or expose passwords in API routes. For user management, use safe identity fields ({ id, email, name, role }), and validate inputs strictly.
9. Use standard, verified Lucide React icons (e.g., ShoppingBag, Coffee, Clock, MapPin, Phone, Mail, Star, Check, ChevronRight, Menu, X, Search, Heart, ArrowRight, User, Settings, Info, AlertCircle, Calendar, Plus, Trash2, Edit, Filter, ChevronLeft, Eye). NEVER invent or hallucinate icon names.
10. Do NOT import non-existent external npm packages. Use only standard React, Next.js, and Lucide icons.
11. When performing follow-up modifications, PRESERVE all existing working features while integrating requested additions.
`;
}

/**
 * Authoritative Implementation Engine for CodeMytra.
 * Shared by both the customer-facing Inngest workflow and standalone E2E runners.
 * Executes multi-turn tool calling (terminal, createOrUpdateFiles, readFiles) against the sandbox workspace.
 */
export async function runCodingAgent(
  options: RunCodingAgentOptions
): Promise<CodingAgentResult> {
  const {
    sandboxId,
    prompt,
    prd,
    designSpec,
    architectureSpec,
    baseFiles = {},
    previousMessages = [],
    stepPrefix = "code-agent",
    model,
    generationRunId,
    deadlineMs,
    maxIterations,
    tokenBudget,
  } = options;

  const runStep = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => {
    // Tool calls within autonomous LLM loops must execute directly as asynchronous actions.
    // They must never register dynamic nested Inngest step.run calls, which breaks deterministic
    // replay discovery ("Could not find step ... to run; timed out").
    return await fn();
  };

  const initialFiles: Record<string, string> = { ...(baseFiles || {}) };

  const state = createState<CodeAgentState>(
    {
      sandboxId,
      summary: "",
      files: initialFiles,
      iterationCount: 0,
      filesWrittenCount: 0,
      wroteFilesInLastTurn: false,
      consecutiveNoWriteTurns: 0,
    },
    {
      messages: previousMessages.map((m) => ({
        type: "text" as const,
        role: m.role,
        content: m.content,
      })),
    }
  );

  const selectedModel = model || (
    stepPrefix?.includes("repair")
      ? "gpt-4o"
      : "gpt-4o-mini"
  );

  const openAIModel = getOpenAIModel({
    model: selectedModel,
  });

  const systemPrompt = buildContextEnhancedPrompt(
    prd,
    designSpec,
    architectureSpec
  );

  const effectiveMaxIterations: number =
    maxIterations ||
    (stepPrefix?.includes("repair")
      ? (GENERATION_LIMITS.maxRepairIterations ?? 2)
      : (GENERATION_LIMITS.maxCodingIterations ?? 4));

  const effectiveTokenBudget: number =
    tokenBudget || (GENERATION_LIMITS.maxRunTokenBudget ?? 150000);

  const codeAgent = createAgent({
    name: "code-agent",
    description: "Authoritative full-stack implementation agent",
    system: systemPrompt,
    model: openAIModel,
    tools: [
      // 1. Terminal Tool (operates inside project workspace with strict security and output limits)
      createTool({
        name: "terminal",
        description: `Run allowed terminal commands inside the project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          command: z.string(),
        }),
        handler: async ({ command }, { network }) => {
          // Pre-execution deadline check
          if (deadlineMs && getRemainingTimeMs(deadlineMs) < 5000) {
            throw new GenerationTimeoutError(
              `Generation deadline exceeded before terminal execution.`,
              Date.now() - (deadlineMs - GENERATION_LIMITS.maxGenerationDurationMs),
              GENERATION_LIMITS.maxGenerationDurationMs
            );
          }
          // Pre-execution DB terminal status check
          if (generationRunId && !(await isRunActiveInDb(generationRunId))) {
            throw new RunAbortedError(
              `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
            );
          }
          // Token budget check
          if (effectiveTokenBudget && network?.state?.data) {
            const currentTokens = (network.state.data.promptTokens || 0) + (network.state.data.completionTokens || 0);
            if (currentTokens >= effectiveTokenBudget) {
              throw new TokenBudgetExceededError(
                `Token budget (${effectiveTokenBudget} tokens) exceeded. Halting command execution.`,
                currentTokens,
                effectiveTokenBudget
              );
            }
          }
          if (network?.state?.data) {
            network.state.data.lastToolUsed = "terminal";
            network.state.data.wroteFilesInLastTurn = false;
          }

          // Pre-execution security check (defense-in-depth)
          const secCheck = validateSandboxCommand(command);
          if (!secCheck.allowed) {
            return JSON.stringify({
              success: false,
              exitCode: 126,
              stdout: "",
              stderr: secCheck.reason || "Command blocked by security policy.",
              error: "COMMAND_SECURITY_BLOCKED",
            });
          }

          const commandTimeout = deadlineMs
            ? boundOperationTimeout(deadlineMs, MAX_COMMAND_TIMEOUT_MS, 5000, "terminal command")
            : MAX_COMMAND_TIMEOUT_MS;

          return await runStep("terminal", async () => {
            let stdout = "";
            let stderr = "";
            try {
              const sandbox = await Sandbox.connect(sandboxId);
              // Ensure commands execute inside the project workspace
              const wrappedCommand = `cd "${PROJECT_WORKSPACE_DIR}" && ${command}`;
              const result = await sandbox.commands.run(wrappedCommand, {
                onStdout: (data) => {
                  if (stdout.length < MAX_COMMAND_OUTPUT_BYTES) {
                    stdout += data;
                  }
                },
                onStderr: (data) => {
                  if (stderr.length < MAX_COMMAND_OUTPUT_BYTES) {
                    stderr += data;
                  }
                },
                timeoutMs: commandTimeout,
              });

              const exitCode = result.exitCode ?? 0;
              const cleanStdout = (result.stdout || stdout || "").slice(0, MAX_COMMAND_OUTPUT_BYTES);
              const cleanStderr = (result.stderr || stderr || "").slice(0, MAX_COMMAND_OUTPUT_BYTES);

              return JSON.stringify({
                success: exitCode === 0,
                exitCode,
                stdout: cleanStdout,
                stderr: cleanStderr,
              });
            } catch (error) {
              return JSON.stringify({
                success: false,
                exitCode: 1,
                stdout: stdout.slice(0, MAX_COMMAND_OUTPUT_BYTES),
                stderr: stderr.slice(0, MAX_COMMAND_OUTPUT_BYTES),
                error: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          });
        },
      }),

      // 2. createOrUpdateFiles Tool (pre-validates entire batch before writing to avoid partial corruptions)
      createTool({
        name: "createOrUpdateFiles",
        description: `Create or update files in the sandbox project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          files: z.array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          ).min(1).max(50),
        }),
        handler: async ({ files }, { network }) => {
          // Pre-execution deadline check
          if (deadlineMs && getRemainingTimeMs(deadlineMs) < 5000) {
            throw new GenerationTimeoutError(
              `Generation deadline exceeded before file creation.`,
              Date.now() - (deadlineMs - GENERATION_LIMITS.maxGenerationDurationMs),
              GENERATION_LIMITS.maxGenerationDurationMs
            );
          }
          // Pre-execution DB terminal status check
          if (generationRunId && !(await isRunActiveInDb(generationRunId))) {
            throw new RunAbortedError(
              `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
            );
          }
          // Token budget check
          if (effectiveTokenBudget && network?.state?.data) {
            const currentTokens = (network.state.data.promptTokens || 0) + (network.state.data.completionTokens || 0);
            if (currentTokens >= effectiveTokenBudget) {
              throw new TokenBudgetExceededError(
                `Token budget (${effectiveTokenBudget} tokens) exceeded. Halting file write execution.`,
                currentTokens,
                effectiveTokenBudget
              );
            }
          }
          if (network?.state?.data) {
            network.state.data.lastToolUsed = "createOrUpdateFiles";
          }

          let sandbox: Sandbox;
          try {
            sandbox = await Sandbox.connect(sandboxId);
          } catch (connErr) {
            return JSON.stringify({
              success: false,
              error: `Sandbox connection failed: ${connErr instanceof Error ? connErr.message : String(connErr)}`,
            });
          }

          const stepResult = await runStep("createOrUpdateFiles", async () => {
            return await executeBatchFileWrites(sandbox.files, files);
          });

          // Stop generation when rollback cannot be guaranteed
          if (stepResult.unrecoveredFilesystem) {
            throw new CodingAgentError(
              `UNRECOVERED_FILESYSTEM_ERROR: File rollback could not be guaranteed after failure on "${stepResult.failedFile}". Generation stopped to prevent corruption. Details: ${stepResult.error}`
            );
          }

          // Only mutate network state if the entire batch write succeeded
          if (stepResult.success && stepResult.updatedMap && network?.state?.data) {
            network.state.data.files = {
              ...(network.state.data.files || initialFiles),
              ...stepResult.updatedMap,
            };
            network.state.data.filesWrittenCount =
              (network.state.data.filesWrittenCount || 0) + (stepResult.count || 0);
            network.state.data.wroteFilesInLastTurn = true;
            network.state.data.consecutiveNoWriteTurns = 0;
          }

          return JSON.stringify({
            success: stepResult.success,
            filesWritten: stepResult.filesWritten,
            count: stepResult.count,
            error: stepResult.error,
            failedFile: stepResult.failedFile,
            rolledBack: stepResult.rolledBack,
            unrecoveredFilesystem: stepResult.unrecoveredFilesystem,
          });
        },
      }),

      // 3. readFiles Tool (reads from project workspace with secrets protection and structured results)
      createTool({
        name: "readFiles",
        description: `Read files from the sandbox project workspace (${PROJECT_WORKSPACE_DIR})`,
        parameters: z.object({
          files: z.array(z.string()).min(1).max(20),
        }),
        handler: async ({ files }, { network }) => {
          // Pre-execution deadline check
          if (deadlineMs && getRemainingTimeMs(deadlineMs) < 5000) {
            throw new GenerationTimeoutError(
              `Generation deadline exceeded before reading files.`,
              Date.now() - (deadlineMs - GENERATION_LIMITS.maxGenerationDurationMs),
              GENERATION_LIMITS.maxGenerationDurationMs
            );
          }
          // Pre-execution DB terminal status check
          if (generationRunId && !(await isRunActiveInDb(generationRunId))) {
            throw new RunAbortedError(
              `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
            );
          }
          if (network?.state?.data) {
            network.state.data.lastToolUsed = "readFiles";
            network.state.data.wroteFilesInLastTurn = false;
          }

          return await runStep("readFiles", async () => {
            // Pre-validate all requested paths
            for (const filePath of files) {
              if (isSensitiveFilePath(filePath)) {
                return JSON.stringify({
                  success: false,
                  error: `Reading sensitive file "${filePath}" is forbidden by security policy.`,
                  failedFile: filePath,
                });
              }
              try {
                resolveWorkspacePath(filePath);
              } catch {
                return JSON.stringify({
                  success: false,
                  error: `Path traversal forbidden: file "${filePath}" resolves outside project workspace.`,
                  failedFile: filePath,
                });
              }
            }

            try {
              const sandbox = await Sandbox.connect(sandboxId);
              const contents: Array<{ path: string; content: string }> = [];

              for (const filePath of files) {
                const fullWorkspacePath = resolveWorkspacePath(filePath);
                let content = await sandbox.files.read(fullWorkspacePath);
                if (typeof content === "string" && content.length > 1024 * 1024) {
                  content =
                    content.slice(0, 1024 * 1024) + "\n... [Content truncated at 1 MB]";
                }
                contents.push({
                  path: filePath,
                  content: typeof content === "string" ? content : "",
                });
              }

              return JSON.stringify({
                success: true,
                files: contents,
                count: contents.length,
              });
            } catch (error) {
              return JSON.stringify({
                success: false,
                error: `Error reading files: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          });
        },
      }),
    ],

    lifecycle: {
      onResponse: async ({ result, network }) => {
        const lastText = lastAssistantTextMessageContent(result);
        if (lastText && network?.state?.data) {
          if (lastText.includes("<task_summary>")) {
            network.state.data.summary = lastText;
          } else if ((network.state.data.filesWrittenCount || 0) > 0) {
            // Fast path: if files have already been written and assistant emitted text,
            // capture it as the task summary even if the tag was omitted.
            network.state.data.summary = `<task_summary>${lastText.trim()}</task_summary>`;
          }
        }
        const stepUsage = extractUsageMetadata(result);
        if (stepUsage && network?.state?.data) {
          network.state.data.promptTokens = (network.state.data.promptTokens || 0) + (stepUsage.promptTokens || 0);
          network.state.data.completionTokens = (network.state.data.completionTokens || 0) + (stepUsage.completionTokens || 0);
          network.state.data.hasUsage = true;
        }

        // Track non-writing turns
        if (network?.state?.data) {
          if (!network.state.data.wroteFilesInLastTurn) {
            network.state.data.consecutiveNoWriteTurns =
              (network.state.data.consecutiveNoWriteTurns || 0) + 1;
          }
          // Reset wroteFilesInLastTurn flag for the next cycle
          network.state.data.wroteFilesInLastTurn = false;
        }
        return result;
      },
    },
  });

  const network = createNetwork({
    name: "code-agent-network",
    agents: [codeAgent],
    maxIter: effectiveMaxIterations,
    router: async ({ network }) => {
      // 1. If summary is set, we are finished!
      if (network.state.data.summary) {
        return undefined;
      }

      // 2. Mid-flight DB terminal check: stop immediately if run was failed/cancelled in DB
      if (generationRunId) {
        const active = await isRunActiveInDb(generationRunId);
        if (!active) {
          throw new RunAbortedError(
            `GenerationRun "${generationRunId}" reached terminal status in database. Halting execution immediately.`
          );
        }
      }

      // 3. Mid-flight deadline check
      if (deadlineMs) {
        const remaining = getRemainingTimeMs(deadlineMs);
        if (remaining < 5000) {
          throw new GenerationTimeoutError(
            `Generation deadline exceeded during coding (${remaining}ms remaining). Halting further turns.`,
            GENERATION_LIMITS.maxGenerationDurationMs - remaining,
            GENERATION_LIMITS.maxGenerationDurationMs
          );
        }
      }

      // 4. Token budget check
      const currentTokens =
        (network.state.data.promptTokens || 0) +
        (network.state.data.completionTokens || 0);
      if (effectiveTokenBudget && currentTokens >= effectiveTokenBudget) {
        throw new TokenBudgetExceededError(
          `Token budget (${effectiveTokenBudget} tokens) exceeded during coding. Current usage: ${currentTokens} tokens.`,
          currentTokens,
          effectiveTokenBudget
        );
      }

      // 5. Track iteration count and enforce hard bound
      const iter = (network.state.data.iterationCount || 0) + 1;
      network.state.data.iterationCount = iter;
      if (iter >= effectiveMaxIterations) {
        if ((network.state.data.filesWrittenCount || 0) > 0) {
          return undefined;
        }
        throw new IterationLimitExceededError(
          `Coding agent reached maximum iteration limit (${effectiveMaxIterations}) without producing valid files.`,
          iter,
          effectiveMaxIterations
        );
      }

      // 6. Fast Path Completion:
      // If the agent already wrote files on a previous turn and did not write files on the latest turn:
      // it has concluded its work! Stop immediately!
      if (
        (network.state.data.filesWrittenCount || 0) > 0 &&
        !network.state.data.wroteFilesInLastTurn
      ) {
        return undefined;
      }

      // 7. No-Progress Rule:
      // If the agent has run 2 consecutive non-writing turns without producing any files:
      if (
        (network.state.data.consecutiveNoWriteTurns || 0) >= 2 &&
        (network.state.data.filesWrittenCount || 0) === 0
      ) {
        throw new NoProgressError(
          `Coding agent halted: 2 consecutive turns without creating or updating files.`,
          network.state.data.consecutiveNoWriteTurns
        );
      }

      return codeAgent;
    },
  });

  const result = await runWithoutStepContext(() =>
    network.run(prompt, { state })
  );
  const finalSummaryRaw = result.state.data.summary || "";
  const finalFiles = result.state.data.files || initialFiles;

  let cleanedSummary = finalSummaryRaw;
  const match = finalSummaryRaw.match(/<task_summary>([\s\S]*?)<\/task_summary>/);
  if (match) {
    cleanedSummary = match[1].trim();
  } else if (!cleanedSummary) {
    cleanedSummary = `Built ${prd.projectName} with ${Object.keys(finalFiles).length} files adhering to approved PRD and design guidelines.`;
  }

  const networkUsage = extractUsageMetadata(result);
  let finalUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

  if (result.state.data.hasUsage) {
    const pt = result.state.data.promptTokens || 0;
    const ct = result.state.data.completionTokens || 0;
    finalUsage = {
      promptTokens: pt,
      completionTokens: ct,
      totalTokens: pt + ct,
    };
  } else if (networkUsage) {
    finalUsage = networkUsage;
  }

  return {
    files: finalFiles,
    summary: cleanedSummary,
    usage: finalUsage,
    modelId: selectedModel,
  };
}
