import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeProjectFiles,
  generateManifest,
} from "../src/server/orchestration/revisions";

describe("Revision Sanitization & Manifest", () => {
  it("strips path traversal attacks and dangerous absolute paths", () => {
    const dirtyFiles: Record<string, string> = {
      "app/page.tsx": "export default function Page() {}",
      "app/components/header.tsx": "export function Header() {}",
      "../../etc/passwd": "root:x:0:0",
      "/var/log/system.log": "log content",
      "app/../../../secret.txt": "sensitive",
    };

    const sanitized = sanitizeProjectFiles(dirtyFiles);

    assert.equal(sanitized["app/page.tsx"], "export default function Page() {}");
    assert.equal(sanitized["app/components/header.tsx"], "export function Header() {}");
    assert.equal(sanitized["../../etc/passwd"], undefined);
    assert.equal(sanitized["/var/log/system.log"], undefined);
    assert.equal(sanitized["app/../../../secret.txt"], undefined);
  });

  it("filters out .env, credentials, and build dependencies", () => {
    const dirtyFiles: Record<string, string> = {
      "app/page.tsx": "export default function Page() {}",
      ".env": "DATABASE_URL=secret",
      ".env.local": "API_KEY=secret",
      "node_modules/react/index.js": "module.exports = {}",
      ".next/server/pages.js": "bundled code",
      "server.key": "PRIVATE_KEY",
      "cert.pem": "CERTIFICATE",
    };

    const sanitized = sanitizeProjectFiles(dirtyFiles);

    assert.equal(sanitized["app/page.tsx"], "export default function Page() {}");
    assert.equal(sanitized[".env"], undefined);
    assert.equal(sanitized[".env.local"], undefined);
    assert.equal(sanitized["node_modules/react/index.js"], undefined);
    assert.equal(sanitized[".next/server/pages.js"], undefined);
    assert.equal(sanitized["server.key"], undefined);
    assert.equal(sanitized["cert.pem"], undefined);
  });

  it("correctly calculates file count, sizes, and sorted paths in manifest", () => {
    const files: Record<string, string> = {
      "b.ts": "hello", // 5 bytes
      "a.ts": "world!", // 6 bytes
    };

    const manifest = generateManifest(files);

    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.totalSizeBytes, 11);
    assert.deepEqual(manifest.paths, ["a.ts", "b.ts"]); // Alphabetically sorted
  });
});
