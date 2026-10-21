import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { sanitizeProjectFiles } from "../src/server/orchestration/revisions";

describe("ZIP Export Integrity & Security", () => {
  it("prevents Zip Slip path traversal vulnerabilities", async () => {
    const rawFiles: Record<string, string> = {
      "app/page.tsx": "export default function Home() { return <div>Home</div>; }",
      "../../evil.sh": "echo pwned",
      "/tmp/malicious.js": "alert(1)",
    };

    const cleanFiles = sanitizeProjectFiles(rawFiles);
    const zip = new JSZip();
    const folder = zip.folder("test-project");

    assert.ok(folder);

    for (const [filePath, content] of Object.entries(cleanFiles)) {
      folder.file(filePath, content);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const loadedZip = await JSZip.loadAsync(zipBuffer);

    const filenames = Object.keys(loadedZip.files);

    // Verify root folder contains only safe file
    assert.ok(filenames.includes("test-project/app/page.tsx"));
    assert.equal(filenames.some((f) => f.includes("evil.sh")), false);
    assert.equal(filenames.some((f) => f.includes("malicious.js")), false);
  });

  it("generates a valid, readable zip archive with correct contents", async () => {
    const files: Record<string, string> = {
      "app/page.tsx": "console.log('App');",
      "package.json": JSON.stringify({ name: "my-app", version: "1.0.0" }),
    };

    const zip = new JSZip();
    const folder = zip.folder("project-v1");
    assert.ok(folder);

    for (const [fp, content] of Object.entries(files)) {
      folder.file(fp, content);
    }

    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const unzipped = await JSZip.loadAsync(buffer);

    const fileContent = await unzipped.file("project-v1/app/page.tsx")?.async("string");
    assert.equal(fileContent, "console.log('App');");
  });

  it("validates authentic export configuration and rejects missing or corrupted configs", async () => {
    const { validateExportFiles, ExportValidationError } = await import(
      "../src/server/export/zip-export"
    );

    const validFiles: Record<string, string> = {
      "app/page.tsx": "export default function Page() { return <div>Home</div>; }",
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "package.json": JSON.stringify({
        name: "test-app",
        version: "0.1.0",
        scripts: { build: "next build" },
        dependencies: {
          next: "15.0.0",
          react: "19.0.0",
          "react-dom": "19.0.0",
        },
      }),
    };

    // Valid file tree passes validation cleanly
    assert.doesNotThrow(() => validateExportFiles(validFiles));

    // Missing package.json throws ExportValidationError
    const missingPkg = { ...validFiles };
    delete missingPkg["package.json"];
    assert.throws(
      () => validateExportFiles(missingPkg),
      (err: unknown) => err instanceof ExportValidationError && /missing required 'package.json'/.test((err as Error).message)
    );

    // Invalid JSON in package.json throws ExportValidationError
    const badJsonPkg = { ...validFiles, "package.json": "{ invalid json" };
    assert.throws(
      () => validateExportFiles(badJsonPkg),
      (err: unknown) => err instanceof ExportValidationError && /invalid JSON syntax/.test((err as Error).message)
    );

    // Missing build script throws ExportValidationError
    const noBuildScript = {
      ...validFiles,
      "package.json": JSON.stringify({
        name: "test-app",
        scripts: { dev: "next dev" },
        dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
      }),
    };
    assert.throws(
      () => validateExportFiles(noBuildScript),
      (err: unknown) => err instanceof ExportValidationError && /must contain a 'build' script/.test((err as Error).message)
    );

    // Missing core dependencies throws ExportValidationError
    const missingDeps = {
      ...validFiles,
      "package.json": JSON.stringify({
        name: "test-app",
        scripts: { build: "next build" },
        dependencies: { next: "15.0.0" }, // missing react and react-dom
      }),
    };
    assert.throws(
      () => validateExportFiles(missingDeps),
      (err: unknown) => err instanceof ExportValidationError && /missing core dependencies/.test((err as Error).message)
    );

    // Missing tsconfig.json throws ExportValidationError
    const missingTsConfig = { ...validFiles };
    delete missingTsConfig["tsconfig.json"];
    assert.throws(
      () => validateExportFiles(missingTsConfig),
      (err: unknown) => err instanceof ExportValidationError && /missing required 'tsconfig.json'/.test((err as Error).message)
    );

    // Missing entrypoint throws ExportValidationError
    const missingEntrypoint = { ...validFiles };
    delete missingEntrypoint["app/page.tsx"];
    assert.throws(
      () => validateExportFiles(missingEntrypoint),
      (err: unknown) => err instanceof ExportValidationError && /missing entrypoint file/.test((err as Error).message)
    );
  });
});
