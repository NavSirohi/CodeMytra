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
});
