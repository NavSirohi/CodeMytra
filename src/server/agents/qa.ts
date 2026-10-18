import { QAReport, QAReportSchema } from "@/server/agent-contracts/schemas";
import path from "path";

export interface ValidateProjectOptions {
  files: Record<string, string>;
  summary: string;
}

/**
 * QA Inspector executing multi-point verification gates on generated project files.
 */
export async function runQAInspector(options: ValidateProjectOptions): Promise<QAReport> {
  const { files, summary } = options;
  const checks: QAReport["checks"] = [];

  // 1. Files completeness check
  const filePaths = Object.keys(files || {});
  const hasFiles = filePaths.length > 0;
  checks.push({
    name: "files-exist",
    status: hasFiles ? "PASS" : "FAIL",
    details: `${filePaths.length} files generated`,
  });

  // 2. Entry point check
  const hasPage = Boolean(
    files["app/page.tsx"] ||
    files["src/app/page.tsx"] ||
    files["page.tsx"]
  );
  checks.push({
    name: "entrypoint-exists",
    status: hasPage ? "PASS" : "FAIL",
    details: hasPage ? "Found primary app/page.tsx" : "Missing primary page.tsx",
  });

  // 3. Summary check
  const hasSummary = Boolean(summary && summary.trim().length > 10);
  checks.push({
    name: "summary-generated",
    status: hasSummary ? "PASS" : "FAIL",
    details: hasSummary ? "Valid summary generated" : "Missing summary",
  });

  // 4. Import integrity check
  // Verify that any relative import within app/page.tsx has a corresponding file
  const pageContent = files["app/page.tsx"] || files["src/app/page.tsx"] || "";
  const importMatches = pageContent.matchAll(/from\s+["'](\.\/[^"']+)["']/g);
  let missingImports = 0;

  for (const match of importMatches) {
    const importPath = match[1];
    const candidateExtensions = [".tsx", ".ts", "/index.tsx", "/index.ts"];
    const resolvedBase = path.join("app", importPath);

    const exists = candidateExtensions.some((ext) => files[resolvedBase + ext] !== undefined);
    if (!exists) {
      missingImports++;
    }
  }

  checks.push({
    name: "import-integrity",
    status: missingImports === 0 ? "PASS" : "FAIL",
    details: missingImports === 0 ? "All relative imports resolved" : `${missingImports} dangling imports detected`,
  });

  // 5. Security audit (no private keys or tokens in generated source)
  let foundExposedSecret = false;
  for (const content of Object.values(files)) {
    if (
      content.includes("e2b_") ||
      content.includes("sk_test_") ||
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

  // Compute overall score
  const passedCount = checks.filter((c) => c.status === "PASS").length;
  const score = Math.round((passedCount / checks.length) * 100);
  const passed = checks.every((c) => c.name === "security-secrets-check" || c.name === "entrypoint-exists" ? c.status === "PASS" : true) && hasFiles && hasSummary;

  const report: QAReport = {
    passed,
    score,
    checks,
    repairNeeded: !passed,
    repairInstructions: !passed
      ? `Validation failed on: ${checks.filter((c) => c.status === "FAIL").map((c) => c.name).join(", ")}`
      : undefined,
  };

  return QAReportSchema.parse(report);
}
