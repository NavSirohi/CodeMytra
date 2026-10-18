import { QAReport, QAReportSchema } from "@/server/agent-contracts/schemas";
import path from "path";
import { Sandbox } from "@e2b/code-interpreter";

export interface ValidateProjectOptions {
  files: Record<string, string>;
  summary: string;
  sandboxId?: string;
  runSandboxCommands?: boolean;
}

/**
 * Real QA Inspector executing multi-point verification gates on generated project files,
 * including actual Sandbox TypeScript validation and production build execution.
 */
export async function runQAInspector(options: ValidateProjectOptions): Promise<QAReport> {
  const { files, summary, sandboxId, runSandboxCommands = false } = options;
  const checks: QAReport["checks"] = [];
  const errors: string[] = [];

  // 1. Files completeness check
  const filePaths = Object.keys(files || {});
  const hasFiles = filePaths.length > 0;
  checks.push({
    name: "files-exist",
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
    status: !foundExposedSecret ? "PASS" : "FAIL",
    details: !foundExposedSecret ? "Zero credentials detected in source" : "Credential pattern found in code",
  });
  if (foundExposedSecret) {
    errors.push("Security violation: Hardcoded credentials or API keys detected in source code.");
  }

  // 7. Live Sandbox Verification: TypeScript & Production Build (when sandbox active)
  if (sandboxId && runSandboxCommands) {
    try {
      const sandbox = await Sandbox.connect(sandboxId);

      // TypeScript check
      try {
        const tscResult = await sandbox.commands.run("bun run tsc --noEmit", { timeoutMs: 30000 });
        if (tscResult.exitCode === 0) {
          checks.push({
            name: "typescript-validation",
            status: "PASS",
            details: "TypeScript compiled with zero errors",
          });
        } else {
          const tscErr = (tscResult.stderr || tscResult.stdout || "TypeScript typecheck failed").slice(0, 500);
          checks.push({
            name: "typescript-validation",
            status: "FAIL",
            details: tscErr,
          });
          errors.push(`TypeScript error: ${tscErr}`);
        }
      } catch (tscCmdErr) {
        checks.push({
          name: "typescript-validation",
          status: "FAIL",
          details: String(tscCmdErr),
        });
        errors.push(`TypeScript validation failed to execute: ${String(tscCmdErr)}`);
      }

      // Production build check
      try {
        const buildResult = await sandbox.commands.run("bun run build", { timeoutMs: 60000 });
        if (buildResult.exitCode === 0) {
          checks.push({
            name: "production-build",
            status: "PASS",
            details: "Production build succeeded",
          });
        } else {
          const buildErr = (buildResult.stderr || buildResult.stdout || "Build failed").slice(0, 500);
          checks.push({
            name: "production-build",
            status: "FAIL",
            details: buildErr,
          });
          errors.push(`Production build error: ${buildErr}`);
        }
      } catch (buildCmdErr) {
        checks.push({
          name: "production-build",
          status: "FAIL",
          details: String(buildCmdErr),
        });
        errors.push(`Production build command failed: ${String(buildCmdErr)}`);
      }
    } catch (sandboxConnErr) {
      checks.push({
        name: "sandbox-connection",
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

  const report: QAReport = {
    passed,
    score,
    checks,
    repairNeeded: !passed,
    repairInstructions: !passed
      ? `Validation failed with the following issues:\n${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
      : undefined,
  };

  return QAReportSchema.parse(report);
}
