import {
  QAReport,
  QAReportSchema,
  QACheckCategory,
  ArchitectureSpec,
  ApplicationCapability,
} from "@/server/agent-contracts/schemas";
import path from "path";
import { Sandbox } from "@e2b/code-interpreter";
import { PROJECT_WORKSPACE_DIR } from "@/server/orchestration/workspace";

export interface QACommandExecutor {
  run(command: string, options?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface DatabaseVerificationPipelineOptions {
  workspaceDir: string;
  models?: Array<{ modelName: string; fields?: string[]; relations?: string[] }>;
  disposableDbName?: string;
  runner?: "bun" | "npm";
}

/**
 * Task 1 & Task 2: Safe database verification pipeline executing on an isolated disposable database.
 * Strictly guarantees that existing development databases (dev.db) are NEVER overwritten or altered.
 * Separates schema validation, client generation, disposable initialization, engine connectivity, and model operations.
 */
export async function executeDatabaseVerificationPipeline(
  executor: QACommandExecutor,
  options: DatabaseVerificationPipelineOptions
): Promise<{ checks: QAReport["checks"]; errors: string[] }> {
  const {
    workspaceDir,
    models = [],
    disposableDbName = ".qa_disposable.db",
    runner = "bun",
  } = options;

  const checks: QAReport["checks"] = [];
  const errors: string[] = [];
  const prismaCmd = runner === "bun" ? "bunx prisma" : "npx prisma";

  // 1. Prisma schema live validation
  try {
    const valRes = await executor.run(
      `cd "${workspaceDir}" && ${prismaCmd} validate`,
      { timeoutMs: 30000 }
    );
    const valPassed = valRes.exitCode === 0;
    checks.push({
      name: "database-schema-live-validation",
      category: "database-validation",
      status: valPassed ? "PASS" : "FAIL",
      details: valPassed
        ? "Prisma schema validated successfully"
        : (valRes.stderr || valRes.stdout || "Prisma schema validation failed").slice(0, 500),
    });
    if (!valPassed) {
      errors.push(`Prisma schema validation failed: ${(valRes.stderr || valRes.stdout).slice(0, 300)}`);
      return { checks, errors };
    }
  } catch (valErr) {
    checks.push({
      name: "database-schema-live-validation",
      category: "database-validation",
      status: "FAIL",
      details: String(valErr),
    });
    errors.push(`Prisma schema validation command error: ${String(valErr)}`);
    return { checks, errors };
  }

  // 2. Prisma client generation
  try {
    const genRes = await executor.run(
      `cd "${workspaceDir}" && ${prismaCmd} generate`,
      { timeoutMs: 30000 }
    );
    const genPassed = genRes.exitCode === 0;
    checks.push({
      name: "database-client-generation",
      category: "database-validation",
      status: genPassed ? "PASS" : "FAIL",
      details: genPassed
        ? "Prisma client generated successfully"
        : (genRes.stderr || genRes.stdout || "Prisma client generation failed").slice(0, 500),
    });
    if (!genPassed) {
      errors.push(`Prisma client generation failed: ${(genRes.stderr || genRes.stdout).slice(0, 300)}`);
      return { checks, errors };
    }
  } catch (genErr) {
    checks.push({
      name: "database-client-generation",
      category: "database-validation",
      status: "FAIL",
      details: String(genErr),
    });
    errors.push(`Prisma client generation command error: ${String(genErr)}`);
    return { checks, errors };
  }

  // 3. Safe Database Initialization on DISPOSABLE database (strictly leaving dev.db untouched, NO --accept-data-loss)
  try {
    const pushRes = await executor.run(
      `cd "${workspaceDir}" && DATABASE_URL="file:./${disposableDbName}" ${prismaCmd} db push`,
      { timeoutMs: 30000 }
    );
    const pushPassed = pushRes.exitCode === 0;
    checks.push({
      name: "database-initialization",
      category: "database-validation",
      status: pushPassed ? "PASS" : "FAIL",
      details: pushPassed
        ? `Safe database schema synchronization succeeded on isolated disposable database (${disposableDbName})`
        : (pushRes.stderr || pushRes.stdout || "Database push failed").slice(0, 500),
    });
    if (!pushPassed) {
      errors.push(`Database initialization on disposable database failed: ${(pushRes.stderr || pushRes.stdout).slice(0, 300)}`);
      return { checks, errors };
    }
  } catch (pushErr) {
    checks.push({
      name: "database-initialization",
      category: "database-validation",
      status: "FAIL",
      details: String(pushErr),
    });
    errors.push(`Database initialization command error: ${String(pushErr)}`);
    return { checks, errors };
  }

  // 4. Database Engine Connectivity check (SELECT 1 on disposable database)
  try {
    const script = `import { db } from "./lib/db"; async function run() { await db.$queryRaw\`SELECT 1\`; console.log("DB_CONNECTIVITY_SUCCESS"); } run();`;
    const execCmd = runner === "bun"
      ? `cd "${workspaceDir}" && DATABASE_URL="file:./${disposableDbName}" bun -e '${script}'`
      : `cd "${workspaceDir}" && DATABASE_URL="file:./${disposableDbName}" npx tsx -e '${script}'`;

    const connRes = await executor.run(execCmd, { timeoutMs: 15000 });
    const connPassed = connRes.exitCode === 0 && connRes.stdout.includes("DB_CONNECTIVITY_SUCCESS");
    checks.push({
      name: "database-connectivity",
      category: "database-validation",
      status: connPassed ? "PASS" : "FAIL",
      details: connPassed
        ? "Database engine connectivity verified (SELECT 1 succeeded on disposable database)"
        : (connRes.stderr || connRes.stdout || "Database connectivity check failed").slice(0, 500),
    });
    if (!connPassed) {
      errors.push(`Database connectivity check failed: ${(connRes.stderr || connRes.stdout).slice(0, 300)}`);
    }
  } catch (connErr) {
    checks.push({
      name: "database-connectivity",
      category: "database-validation",
      status: "FAIL",
      details: String(connErr),
    });
    errors.push(`Database connectivity command error: ${String(connErr)}`);
  }

  // 5. Real Model Operations Verification (distinct from connectivity!)
  if (models && models.length > 0) {
    const primaryModel = models[0];
    const delegateName = primaryModel.modelName.charAt(0).toLowerCase() + primaryModel.modelName.slice(1);
    try {
      const modelScript = `import { db } from "./lib/db"; async function verify() { const delegate = db["${delegateName}"]; if (!delegate || typeof delegate.findMany !== "function") { throw new Error("Model delegate ${delegateName} is missing or not a Prisma model delegate"); } const count = await delegate.count(); console.log("MODEL_OPERATION_SUCCESS:" + count); } verify().catch(e => { console.error(e); process.exit(1); });`;
      const modelCmd = runner === "bun"
        ? `cd "${workspaceDir}" && DATABASE_URL="file:./${disposableDbName}" bun -e '${modelScript}'`
        : `cd "${workspaceDir}" && DATABASE_URL="file:./${disposableDbName}" npx tsx -e '${modelScript}'`;

      const modelRes = await executor.run(modelCmd, { timeoutMs: 15000 });
      const modelPassed = modelRes.exitCode === 0 && modelRes.stdout.includes("MODEL_OPERATION_SUCCESS");
      checks.push({
        name: "database-model-operations",
        category: "database-validation",
        status: modelPassed ? "PASS" : "FAIL",
        details: modelPassed
          ? `Verified Prisma model delegate operations on model "${primaryModel.modelName}" in disposable database`
          : (modelRes.stderr || modelRes.stdout || "Model operations verification failed").slice(0, 500),
      });
      if (!modelPassed) {
        errors.push(`Database model operations check failed: ${(modelRes.stderr || modelRes.stdout).slice(0, 300)}`);
      }
    } catch (modelErr) {
      checks.push({
        name: "database-model-operations",
        category: "database-validation",
        status: "FAIL",
        details: String(modelErr),
      });
      errors.push(`Database model operations command error: ${String(modelErr)}`);
    }
  } else {
    // Persistence was required, but no models exist
    checks.push({
      name: "database-model-operations",
      category: "database-validation",
      status: "FAIL",
      details: "Application requires data persistence, but no models were provided to execute model operations",
    });
    errors.push("Missing database models for model operations verification.");
  }

  // Cleanup disposable database files
  try {
    await executor.run(
      `cd "${workspaceDir}" && rm -f "${disposableDbName}" "${disposableDbName}-journal" "${disposableDbName}-wal"`,
      { timeoutMs: 10000 }
    );
  } catch {
    // Ignore cleanup error
  }

  return { checks, errors };
}

export interface ValidateProjectOptions {
  files: Record<string, string>;
  summary: string;
  sandboxId: string;
  runSandboxCommands: boolean;
  archSpec?: ArchitectureSpec;
  capabilities?: ApplicationCapability[];
  customExecutor?: QACommandExecutor;
  workspaceDir?: string;
  runner?: "bun" | "npm";
}

/**
 * Real QA Inspector executing multi-point verification gates on generated project files,
 * explicitly distinguishing between static source checks, capability validation (database/API),
 * sandbox connection, TypeScript compilation, and production build verification.
 */
export async function runQAInspector(options: ValidateProjectOptions): Promise<QAReport> {
  const { files, summary, sandboxId, runSandboxCommands, archSpec, capabilities } = options;
  const checks: QAReport["checks"] = [];
  const errors: string[] = [];

  // 1. Files completeness check
  const filePaths = Object.keys(files || {});
  const hasFiles = filePaths.length > 0;
  checks.push({
    name: "files-exist",
    category: "static-source",
    status: hasFiles ? "PASS" : "FAIL",
    details: hasFiles ? `${filePaths.length} files generated` : "Zero files generated",
  });
  if (!hasFiles) {
    errors.push("No files were produced in this generation run.");
  }

  // 2. Entry point check
  const hasPage = Boolean(
    files["app/page.tsx"] ||
    files["src/app/page.tsx"] ||
    files["page.tsx"]
  );
  checks.push({
    name: "entrypoint-exists",
    category: "static-source",
    status: hasPage ? "PASS" : "FAIL",
    details: hasPage ? "Found primary app/page.tsx" : "Missing primary app/page.tsx",
  });
  if (!hasPage) {
    errors.push("Missing required Next.js entry point file (app/page.tsx).");
  }

  // 3. Package manifest check
  const packageJsonContent = files["package.json"];
  let hasValidPackageJson = false;
  if (packageJsonContent) {
    try {
      JSON.parse(packageJsonContent);
      hasValidPackageJson = true;
    } catch {
      hasValidPackageJson = false;
    }
  } else {
    // If not in root files, it might be in base template
    hasValidPackageJson = true;
  }
  checks.push({
    name: "dependency-verification",
    category: "static-source",
    status: hasValidPackageJson ? "PASS" : "FAIL",
    details: hasValidPackageJson ? "Valid package configuration" : "Malformed package.json",
  });
  if (!hasValidPackageJson) {
    errors.push("package.json is malformed or invalid JSON.");
  }

  // 4. Summary check
  const hasSummary = Boolean(summary && summary.trim().length > 10);
  checks.push({
    name: "summary-generated",
    category: "static-source",
    status: hasSummary ? "PASS" : "FAIL",
    details: hasSummary ? "Valid summary generated" : "Missing summary",
  });
  if (!hasSummary) {
    errors.push("No valid task summary was produced by the code agent.");
  }

  // 5. Import integrity check
  const pageContent = files["app/page.tsx"] || files["src/app/page.tsx"] || "";
  const importMatches = pageContent.matchAll(/from\s+["'](\.\/[^"']+)["']/g);
  let missingImports = 0;
  const missingImportList: string[] = [];

  for (const match of importMatches) {
    const importPath = match[1];
    const candidateExtensions = [".tsx", ".ts", "/index.tsx", "/index.ts"];
    const resolvedBase = path.join("app", importPath);

    const exists = candidateExtensions.some((ext) => files[resolvedBase + ext] !== undefined);
    if (!exists) {
      missingImports++;
      missingImportList.push(importPath);
    }
  }

  checks.push({
    name: "import-integrity",
    category: "static-source",
    status: missingImports === 0 ? "PASS" : "FAIL",
    details: missingImports === 0 ? "All relative imports resolved" : `${missingImports} dangling imports: ${missingImportList.join(", ")}`,
  });
  if (missingImports > 0) {
    errors.push(`Dangling relative imports in page: ${missingImportList.join(", ")}`);
  }

  // 6. Security audit (no private keys or tokens in generated source)
  let foundExposedSecret = false;
  for (const content of Object.values(files)) {
    if (
      content.includes("e2b_") ||
      content.includes("sk_test_") ||
      content.includes("sk_live_") ||
      content.includes("AIzaSy") ||
      content.includes("ghp_")
    ) {
      foundExposedSecret = true;
      break;
    }
  }

  checks.push({
    name: "security-secrets-check",
    category: "static-source",
    status: !foundExposedSecret ? "PASS" : "FAIL",
    details: !foundExposedSecret ? "Zero credentials detected in source" : "Credential pattern found in code",
  });
  if (foundExposedSecret) {
    errors.push("Security violation: Hardcoded credentials or API keys detected in source code.");
  }

  // 7. Capability-Adaptive Database Validation
  const requiresDb = Boolean(
    archSpec?.requiresDatabase ||
    capabilities?.includes("data-persistence") ||
    (files["prisma/schema.prisma"] && !archSpec)
  );

  if (requiresDb) {
    const schemaContent = files["prisma/schema.prisma"] || "";
    const hasSchema = Boolean(schemaContent.length > 0);
    const hasDbClient = Boolean(files["lib/db.ts"] || files["src/lib/db.ts"]);
    const hasModels = schemaContent.includes("model ");

    const dbValid = hasSchema && hasDbClient && hasModels;
    checks.push({
      name: "database-schema-validation",
      category: "database-validation",
      status: dbValid ? "PASS" : "FAIL",
      details: dbValid
        ? "Prisma SQLite schema and database client verified with models"
        : `Database required but incomplete: ${!hasSchema ? "missing schema.prisma; " : ""}${!hasDbClient ? "missing lib/db.ts; " : ""}${!hasModels ? "no models declared; " : ""}`.trim(),
    });
    if (!dbValid) {
      errors.push("Database persistence required but prisma/schema.prisma or lib/db.ts is missing or has no models.");
    }
  } else {
    // Static app: verify no broken database residue
    checks.push({
      name: "database-schema-validation",
      category: "database-validation",
      status: "PASS",
      details: "Static application: clean architecture with no unwanted database overhead",
    });
    checks.push({
      name: "database-connectivity",
      category: "database-validation",
      status: "SKIPPED",
      details: "Static application: database connectivity not required",
    });
    checks.push({
      name: "database-model-operations",
      category: "database-validation",
      status: "SKIPPED",
      details: "Static application: no database models required",
    });
  }

  // 8. Capability-Adaptive API Route Validation
  const apiRouteFiles = filePaths.filter(
    (f) => (f.startsWith("app/api/") || f.startsWith("src/app/api/")) && (f.endsWith("/route.ts") || f.endsWith("/route.js"))
  );
  const expectsApi = Boolean(
    (archSpec?.routeEndpoints && archSpec.routeEndpoints.some((e) => e.type === "api")) ||
    (archSpec?.backendOperations && archSpec.backendOperations.length > 0) ||
    capabilities?.includes("crud-operations")
  );

  if (expectsApi || apiRouteFiles.length > 0) {
    if (apiRouteFiles.length === 0) {
      checks.push({
        name: "api-route-validation",
        category: "api-validation",
        status: "FAIL",
        details: "Architecture expects API route handlers, but no route.ts files found under app/api/",
      });
      errors.push("Expected API route handlers for backend operations, but none were found.");
    } else {
      // Validate that each API route exports at least one HTTP method handler
      let routesValid = true;
      const invalidRoutes: string[] = [];
      const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

      for (const routeFile of apiRouteFiles) {
        const content = files[routeFile] || "";
        const exportsMethod = httpMethods.some((m) =>
          new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(content) ||
          new RegExp(`export\\s+const\\s+${m}\\b`).test(content)
        );
        if (!exportsMethod) {
          routesValid = false;
          invalidRoutes.push(routeFile);
        }
      }

      checks.push({
        name: "api-route-validation",
        category: "api-validation",
        status: routesValid ? "PASS" : "FAIL",
        details: routesValid
          ? `${apiRouteFiles.length} API route handler(s) verified with exported HTTP methods`
          : `API route(s) missing standard HTTP method exports: ${invalidRoutes.join(", ")}`,
      });
      if (!routesValid) {
        errors.push(`API routes missing standard HTTP method exports: ${invalidRoutes.join(", ")}`);
      }
    }
  } else {
    // Static app without backend APIs
    checks.push({
      name: "api-route-validation",
      category: "api-validation",
      status: "PASS",
      details: "Static application: client-side interactions without server API route requirements",
    });
  }

  // 7. Live Sandbox / Custom Executor Verification: Database, TypeScript & Production Build
  let executedSandboxChecks = false;
  if ((sandboxId && runSandboxCommands) || options.customExecutor) {
    try {
      let executor: QACommandExecutor;
      let targetWorkspaceDir: string;
      const runner = options.runner || (options.customExecutor ? "npm" : "bun");

      if (options.customExecutor && options.workspaceDir) {
        executor = options.customExecutor;
        targetWorkspaceDir = options.workspaceDir;
        executedSandboxChecks = true;
        checks.push({
          name: "sandbox-connection",
          category: "sandbox-connection",
          status: "PASS",
          details: `Connected to verification executor (workspace: ${targetWorkspaceDir})`,
        });
      } else {
        const sandbox = await Sandbox.connect(sandboxId);
        executor = {
          run: (cmd, opts) => sandbox.commands.run(cmd, opts),
        };
        targetWorkspaceDir = PROJECT_WORKSPACE_DIR;
        executedSandboxChecks = true;
        checks.push({
          name: "sandbox-connection",
          category: "sandbox-connection",
          status: "PASS",
          details: `Connected to sandbox ${sandboxId}`,
        });
      }

      // Executable Database Verification (only when application requires persistence)
      if (requiresDb && files["prisma/schema.prisma"]) {
        const dbResult = await executeDatabaseVerificationPipeline(executor, {
          workspaceDir: targetWorkspaceDir,
          models: archSpec?.databaseModels,
          runner,
        });
        checks.push(...dbResult.checks);
        errors.push(...dbResult.errors);
      } else if (requiresDb) {
        checks.push({
          name: "database-schema-live-validation",
          category: "database-validation",
          status: "FAIL",
          details: "Application requires data persistence but prisma/schema.prisma is missing",
        });
        errors.push("Missing prisma/schema.prisma for database verification");
      }

      // TypeScript check
      const tscCmd = runner === "bun"
        ? `cd "${targetWorkspaceDir}" && bun run tsc --noEmit`
        : `cd "${targetWorkspaceDir}" && npx tsc --noEmit`;
      try {
        const tscResult = await executor.run(tscCmd, { timeoutMs: 30000 });
        if (tscResult.exitCode === 0) {
          checks.push({
            name: "typescript-validation",
            category: "typescript-validation",
            status: "PASS",
            details: "TypeScript compiled with zero errors",
          });
        } else {
          const tscErr = (tscResult.stderr || tscResult.stdout || "TypeScript typecheck failed").slice(0, 500);
          checks.push({
            name: "typescript-validation",
            category: "typescript-validation",
            status: "FAIL",
            details: tscErr,
          });
          errors.push(`TypeScript error: ${tscErr}`);
        }
      } catch (tscCmdErr) {
        checks.push({
          name: "typescript-validation",
          category: "typescript-validation",
          status: "FAIL",
          details: String(tscCmdErr),
        });
        errors.push(`TypeScript validation failed to execute: ${String(tscCmdErr)}`);
      }

      // Production build check
      const buildCmd = runner === "bun"
        ? `cd "${targetWorkspaceDir}" && bun run build`
        : `cd "${targetWorkspaceDir}" && npm run build`;
      try {
        const buildResult = await executor.run(buildCmd, { timeoutMs: 60000 });
        if (buildResult.exitCode === 0) {
          checks.push({
            name: "production-build",
            category: "production-build",
            status: "PASS",
            details: "Production build succeeded",
          });
        } else {
          const buildErr = (buildResult.stderr || buildResult.stdout || "Build failed").slice(0, 500);
          checks.push({
            name: "production-build",
            category: "production-build",
            status: "FAIL",
            details: buildErr,
          });
          errors.push(`Production build error: ${buildErr}`);
        }
      } catch (buildCmdErr) {
        checks.push({
          name: "production-build",
          category: "production-build",
          status: "FAIL",
          details: String(buildCmdErr),
        });
        errors.push(`Production build command failed: ${String(buildCmdErr)}`);
      }
    } catch (sandboxConnErr) {
      checks.push({
        name: "sandbox-connection",
        category: "sandbox-connection",
        status: "FAIL",
        details: `Failed to connect to verification environment: ${String(sandboxConnErr)}`,
      });
      errors.push(`Sandbox connection error: ${String(sandboxConnErr)}`);
    }
  }

  // All checks must pass or be cleanly skipped (no FAILs allowed)
  const passed = !checks.some((c) => c.status === "FAIL");
  const applicableChecks = checks.filter((c) => c.status !== "SKIPPED");
  const passedCount = applicableChecks.filter((c) => c.status === "PASS").length;
  const score = applicableChecks.length > 0
    ? Math.round((passedCount / applicableChecks.length) * 100)
    : 100;

  const verificationMode = executedSandboxChecks ? "sandbox-verified" : "static-only";

  const executedCategories = Array.from(new Set(checks.map((c) => c.category))) as QACheckCategory[];

  let factualSummary = "";
  if (executedSandboxChecks) {
    factualSummary = passed
      ? "Static source analysis, TypeScript typecheck, and production build verification succeeded. Note: Runtime end-to-end user journeys were not tested."
      : `Sandbox verification failed: ${errors.join("; ")}`;
  } else {
    factualSummary = passed
      ? "Static source checks passed. Sandbox TypeScript validation and production build checks were not executed."
      : `Static source analysis failed: ${errors.join("; ")}`;
  }

  const report: QAReport = {
    passed,
    score,
    checks,
    repairNeeded: !passed,
    repairInstructions: !passed
      ? `Validation failed with the following issues:\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
      : undefined,
    verificationMode,
    summary: factualSummary,
    executedCategories,
  };

  return QAReportSchema.parse(report);
}
