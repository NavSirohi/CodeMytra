import JSZip from "jszip";
import path from "path";
import { prisma } from "@/lib/db";
import { sanitizeProjectFiles } from "@/server/orchestration/revisions";

export interface GenerateProjectZipOptions {
  projectId: string;
  revisionId?: string;
  userId: string;
}

export class ExportValidationError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ExportValidationError";
  }
}

/**
 * Validates that the revision contains authentic, standalone project configuration.
 * Prevents exporting broken or incomplete revisions without authentic package.json or tsconfig.json.
 */
export function validateExportFiles(files: Record<string, string>): void {
  const fileKeys = Object.keys(files).map((f) =>
    path.normalize(f).replace(/^(\.\/|\/)/, "").toLowerCase()
  );

  // 1. Mandatory package.json check
  const pkgKey = Object.keys(files).find(
    (f) => path.normalize(f).replace(/^(\.\/|\/)/, "").toLowerCase() === "package.json"
  );
  if (!pkgKey) {
    throw new ExportValidationError(
      "Export validation failed: revision is missing required 'package.json'. Export must reflect authentic project files."
    );
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(files[pkgKey]);
  } catch {
    throw new ExportValidationError(
      "Export validation failed: 'package.json' contains invalid JSON syntax."
    );
  }

  // 2. Validate essential scripts
  const scripts = (pkgJson.scripts as Record<string, string>) || {};
  if (!scripts.build) {
    throw new ExportValidationError(
      "Export validation failed: 'package.json' must contain a 'build' script for standalone compilation."
    );
  }

  // 3. Validate essential runtime dependencies
  const deps = (pkgJson.dependencies as Record<string, string>) || {};
  if (!deps.next || !deps.react || !deps["react-dom"]) {
    throw new ExportValidationError(
      "Export validation failed: 'package.json' is missing core dependencies ('next', 'react', 'react-dom')."
    );
  }

  // 4. Mandatory tsconfig.json check
  const hasTsConfig = fileKeys.includes("tsconfig.json");
  if (!hasTsConfig) {
    throw new ExportValidationError(
      "Export validation failed: revision is missing required 'tsconfig.json'. Standalone TypeScript compilation cannot proceed."
    );
  }

  // 5. Mandatory entrypoint check
  const hasEntrypoint = fileKeys.some(
    (k) =>
      k === "app/page.tsx" ||
      k === "src/app/page.tsx" ||
      k === "app/page.jsx" ||
      k === "src/app/page.jsx" ||
      k === "pages/index.tsx" ||
      k === "pages/index.jsx"
  );
  if (!hasEntrypoint) {
    throw new ExportValidationError(
      "Export validation failed: revision is missing entrypoint file (app/page.tsx or src/app/page.tsx)."
    );
  }
}

/**
 * Generates a clean, validated ZIP archive of a project's revision.
 * Enforces server-side authorization, strict Zip Slip protection, and authentic project integrity.
 */
export async function generateProjectZip(options: GenerateProjectZipOptions) {
  const { projectId, revisionId, userId } = options;

  // 1. Authenticate & verify project ownership
  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
    select: { id: true, name: true, currentRevisionId: true },
  });

  if (!project) {
    throw new Error("Project not found or unauthorized");
  }

  // 2. Resolve revision
  const targetRevId = revisionId || project.currentRevisionId;

  const revision = targetRevId
    ? await prisma.projectRevision.findUnique({
        where: { id: targetRevId, projectId },
      })
    : await prisma.projectRevision.findFirst({
        where: { projectId },
        orderBy: { revisionNumber: "desc" },
      });

  if (!revision) {
    throw new Error("No revision available to export for this project");
  }

  const rawFiles = (revision.files as Record<string, string>) || {};
  const cleanFiles = sanitizeProjectFiles(rawFiles);

  // 3. Strict authenticity and completeness validation
  validateExportFiles(cleanFiles);

  const zip = new JSZip();

  // Root folder inside the zip for clean extraction
  const rootFolderName = `codemytra-${project.name || "project"}-v${revision.revisionNumber}`;
  const folder = zip.folder(rootFolderName);

  if (!folder) {
    throw new Error("Failed to initialize zip directory");
  }

  let hasReadme = false;

  for (const [filePath, content] of Object.entries(cleanFiles)) {
    // Security: strict Zip Slip defense
    const normalized = path.normalize(filePath).replace(/^(\.\/|\/)/, "");
    if (normalized.includes("..") || path.isAbsolute(filePath)) {
      continue;
    }

    if (normalized.toLowerCase() === "readme.md") {
      hasReadme = true;
    }

    folder.file(normalized, content);
  }

  // Include default README if user project didn't generate one
  if (!hasReadme) {
    const defaultReadme = `# ${project.name || "CodeMytra Application"} (Revision ${revision.revisionNumber})

Generated by **CodeMytra** AI Application Builder.

## Getting Started

1. Install dependencies:
\`\`\`bash
npm install
\`\`\`

2. Run the development server:
\`\`\`bash
npm run dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000) with your browser to view the application.
`;
    folder.file("README.md", defaultReadme);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const filename = `${rootFolderName}.zip`;

  return {
    filename,
    buffer,
    revisionNumber: revision.revisionNumber,
    fileCount: Object.keys(cleanFiles).length,
  };
}
