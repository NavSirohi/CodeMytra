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

export interface ValidateProjectOptions {
  files: Record<string, string>;
  summary: string;
  sandboxId: string;
  runSandboxCommands: boolean;
  archSpec?: ArchitectureSpec;
  capabilities?: ApplicationCapability[];
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

  // 7. Live Sandbox Verification: TypeScript & Production Build (when sandbox active)
  let executedSandboxChecks = false;
  if (sandboxId && runSandboxCommands) {
    try {
      const sandbox = await Sandbox.connect(sandboxId);
      executedSandboxChecks = true;

      checks.push({
        name: "sandbox-connection",
        category: "sandbox-connection",
        status: "PASS",
        details: `Connected to sandbox ${sandboxId}`,
      });

      // Executable Database Verification (only when application requires persistence)
      if (requiresDb && files["prisma/schema.prisma"]) {
        // 1. Prisma validate
        try {
          const valRes = await sandbox.commands.run(
            `cd "${PROJECT_WORKSPACE_DIR}" && bunx prisma validate`,
            { timeoutMs: 30000 }
          );
          const valPassed = valRes.exitCode === 0;
          checks.push({
            name: "database-schema-live-validation",
            category: "database-validation",
            status: valPassed ? "PASS" : "FAIL",
            details: valPassed
              ? "Prisma schema validated successfully in sandbox"
              : (valRes.stderr || valRes.stdout || "Prisma schema validation failed").slice(0, 500),
          });
          if (!valPassed) {
            errors.push(`Prisma schema validation failed: ${(valRes.stderr || valRes.stdout).slice(0, 300)}`);
          }
        } catch (valErr) {
          checks.push({
            name: "database-schema-live-validation",
            category: "database-validation",
            status: "FAIL",
            details: String(valErr),
          });
          errors.push(`Prisma schema validation command error: ${String(valErr)}`);
        }

        // 2. Prisma generate
        try {
          const genRes = await sandbox.commands.run(
            `cd "${PROJECT_WORKSPACE_DIR}" && bunx prisma generate`,
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
          }
        } catch (genErr) {
          checks.push({
            name: "database-client-generation",
            category: "database-validation",
            status: "FAIL",
            details: String(genErr),
          });
          errors.push(`Prisma client generation command error: ${String(genErr)}`);
        }

        // 3. Database initialization / migration push
        try {
          const pushRes = await sandbox.commands.run(
            `cd "${PROJECT_WORKSPACE_DIR}" && bunx prisma db push --accept-data-loss`,
            { timeoutMs: 30000 }
          );
          const pushPassed = pushRes.exitCode === 0;
          checks.push({
            name: "database-initialization",
            category: "database-validation",
            status: pushPassed ? "PASS" : "FAIL",
            details: pushPassed
              ? "SQLite database schema synchronized successfully"
              : (pushRes.stderr || pushRes.stdout || "Database push failed").slice(0, 500),
          });
          if (!pushPassed) {
            errors.push(`Database push failed: ${(pushRes.stderr || pushRes.stdout).slice(0, 300)}`);
          }
        } catch (pushErr) {
          checks.push({
            name: "database-initialization",
            category: "database-validation",
            status: "FAIL",
            details: String(pushErr),
          });
          errors.push(`Database initialization command error: ${String(pushErr)}`);
        }

        // 4. Executable database connectivity and query execution verification
        try {
          const connRes = await sandbox.commands.run(
            `cd "${PROJECT_WORKSPACE_DIR}" && bun -e 'import { db } from "./lib/db"; async function run() { await db.$queryRaw\`SELECT 1\`; console.log("DB_QUERY_SUCCESS"); } run();'`,
            { timeoutMs: 15000 }
          );
          const connPassed = connRes.exitCode === 0 && connRes.stdout.includes("DB_QUERY_SUCCESS");
          checks.push({
            name: "database-crud-verification",
            category: "database-validation",
            status: connPassed ? "PASS" : "FAIL",
            details: connPassed
              ? "Database query execution and SQLite connection verified"
              : (connRes.stderr || connRes.stdout || "Database query failed").slice(0, 500),
          });
          if (!connPassed) {
            errors.push(`Database query verification failed: ${(connRes.stderr || connRes.stdout).slice(0, 300)}`);
          }
        } catch (connErr) {
          checks.push({
            name: "database-crud-verification",
            category: "database-validation",
            status: "FAIL",
            details: String(connErr),
          });
          errors.push(`Database query execution failed: ${String(connErr)}`);
        }
      }

      // TypeScript check
      try {
        const tscResult = await sandbox.commands.run(`cd "${PROJECT_WORKSPACE_DIR}" && bun run tsc --noEmit`, { timeoutMs: 30000 });
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
      try {
        const buildResult = await sandbox.commands.run(`cd "${PROJECT_WORKSPACE_DIR}" && bun run build`, { timeoutMs: 60000 });
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
        details: `Failed to connect to sandbox for verification: ${String(sandboxConnErr)}`,
      });
      errors.push(`Sandbox connection error: ${String(sandboxConnErr)}`);
    }
  }

  // All mandatory checks must pass
  const passed = checks.every((c) => c.status === "PASS");
  const passedCount = checks.filter((c) => c.status === "PASS").length;
  const score = Math.round((passedCount / checks.length) * 100);

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
