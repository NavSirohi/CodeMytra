import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeProjectFiles,
  validateRevisionManifest,
  RestorationError,
  MAX_FILES_PER_REVISION,
} from "../src/server/orchestration/revisions";
import { runQAInspector } from "../src/server/agents/qa";
import { PlannerError } from "../src/server/agents/planner";

describe("M1.5 Hardening: Resource Limits, Manifest & Restoration Integrity", () => {
  it("enforces maximum file limit per revision", () => {
    const tooManyFiles: Record<string, string> = {};
    for (let i = 0; i < MAX_FILES_PER_REVISION + 1; i++) {
      tooManyFiles[`file_${i}.ts`] = "export const x = 1;";
    }

    assert.throws(
      () => sanitizeProjectFiles(tooManyFiles),
      (err: Error) => {
        return err.message.includes("Revision exceeds maximum file limit");
      }
    );
  });

  it("enforces maximum single file size limit (1 MB)", () => {
    // 1MB + 10 bytes
    const largeContent = "a".repeat(1024 * 1024 + 10);
    const files = {
      "app/page.tsx": "export default function Page() {}",
      "large.txt": largeContent,
    };

    assert.throws(
      () => sanitizeProjectFiles(files),
      (err: Error) => {
        return err.message.includes("exceeds single file size limit of 1MB");
      }
    );
  });

  it("manifest validation detects missing required files", () => {
    const files = {
      "app/page.tsx": "export default function Page() {}",
    };
    const recordedManifest = {
      fileCount: 2,
      totalSizeBytes: 100,
      paths: ["app/page.tsx", "app/header.tsx"],
    };

    const result = validateRevisionManifest(files, recordedManifest);
    assert.equal(result.valid, false);
    assert.match(result.error || "", /fileCount mismatch/);
  });

  it("manifest validation succeeds for authentic complete file trees", () => {
    const files = {
      "app/header.tsx": "export function Header() {}",
      "app/page.tsx": "export default function Page() {}",
    };
    const recordedManifest = {
      fileCount: 2,
      totalSizeBytes: 60,
      paths: ["app/header.tsx", "app/page.tsx"],
    };

    const result = validateRevisionManifest(files, recordedManifest);
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it("RestorationError formats explicit error messages and preserves error name", () => {
    const err = new RestorationError("Failed to write app/page.tsx", { path: "app/page.tsx" });
    assert.equal(err.name, "RestorationError");
    assert.equal(err.message, "Failed to write app/page.tsx");
    assert.deepEqual(err.details, { path: "app/page.tsx" });
  });
});

describe("M1.5 Hardening: Real QA Verification Gates & Failure Diagnostics", () => {
  it("QA inspector fails when app/page.tsx is missing", async () => {
    const report = await runQAInspector({
      files: {
        "components/header.tsx": "export function Header() {}",
      },
      summary: "Created header component for the application.",
    });

    assert.equal(report.passed, false);
    assert.equal(report.repairNeeded, true);
    assert.match(report.repairInstructions || "", /entry point file/i);

    const entryCheck = report.checks.find((c) => c.name === "entrypoint-exists");
    assert.equal(entryCheck?.status, "FAIL");
  });

  it("QA inspector flags detected secret tokens in source", async () => {
    const report = await runQAInspector({
      files: {
        "app/page.tsx": "const key = 'sk_live_1234567890abcdef'; export default function Page() {}",
      },
      summary: "Implemented page with secret.",
    });

    assert.equal(report.passed, false);
    const secCheck = report.checks.find((c) => c.name === "security-secrets-check");
    assert.equal(secCheck?.status, "FAIL");
    assert.match(report.repairInstructions || "", /Hardcoded credentials/i);
  });

  it("QA inspector flags dangling relative imports", async () => {
    const report = await runQAInspector({
      files: {
        "app/page.tsx": "import { NonExistent } from './non-existent'; export default function Page() {}",
      },
      summary: "Implemented page with missing import component.",
    });

    assert.equal(report.passed, false);
    const importCheck = report.checks.find((c) => c.name === "import-integrity");
    assert.equal(importCheck?.status, "FAIL");
    assert.match(report.repairInstructions || "", /Dangling relative imports/i);
  });

  it("QA inspector passes on healthy, complete project files", async () => {
    const report = await runQAInspector({
      files: {
        "package.json": JSON.stringify({ name: "bakery-app", dependencies: { next: "16.0.0" } }),
        "app/header.tsx": "export function Header() { return <header>Bakery</header>; }",
        "app/page.tsx": "import { Header } from './header'; export default function Page() { return <Header />; }",
      },
      summary: "Successfully generated authentic bakery homepage with Header and interactive menu.",
    });

    assert.equal(report.passed, true);
    assert.equal(report.score, 100);
    assert.equal(report.repairNeeded, false);
  });
});

describe("M1.5 Hardening: Explicit Error Propagation without Silent Fallback", () => {
  it("PlannerError preserves raw failure details", () => {
    const err = new PlannerError("Invalid JSON from LLM", "{ malformed: }");
    assert.equal(err.name, "PlannerError");
    assert.equal(err.rawOutput, "{ malformed: }");
    assert.match(err.message, /Invalid JSON/);
  });
});
