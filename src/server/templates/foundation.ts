import path from "path";
import { ApplicationCapability } from "@/server/agent-contracts/schemas";

/**
 * Pinned and documented CodeMytra Foundation Version.
 * Reflects verified compatibility with Next.js 16 (App Router), React 19,
 * Tailwind CSS, and Prisma ORM v7 with SQLite Driver Adapter.
 */
export const FOUNDATION_VERSION = "2.1.0";

export interface BaseProjectOptions {
  projectName?: string;
  capabilities?: ApplicationCapability[];
  requiresDatabase?: boolean;
  models?: Array<{ modelName: string; fields: string[]; relations?: string[] }>;
}

/**
 * Checks whether the given capabilities require database infrastructure.
 */
export function isDatabaseRequired(capabilities?: ApplicationCapability[]): boolean {
  if (!capabilities || capabilities.length === 0) return false;
  return capabilities.some((c) => c === "data-persistence" || c === "crud-operations");
}

export class MissingDatabaseModelsError extends Error {
  constructor(message = "Architecture specification requires database persistence but contains no database models") {
    super(message);
    this.name = "MissingDatabaseModelsError";
  }
}

/**
 * Normalizes field definitions and infers appropriate Prisma scalar types
 * when only a field name is provided without a type.
 */
export function normalizePrismaField(field: string): string {
  const clean = field.replace(":", " ").trim().replace(/\s+/g, " ");
  const parts = clean.split(" ");
  if (parts.length === 1) {
    const name = parts[0];
    if (name.toLowerCase() === "id") return "id String @id @default(cuid())";
    if (/date|time|at$/i.test(name)) return `${name} DateTime @default(now())`;
    if (/price|amount|cost|total|rating|score/i.test(name)) return `${name} Float @default(0.0)`;
    if (/count|quantity|stock|number|age/i.test(name)) return `${name} Int @default(0)`;
    if (/^(is|has|can|should)[A-Z]/i.test(name) || /active|completed|published/i.test(name)) return `${name} Boolean @default(false)`;
    return `${name} String`;
  }
  return clean;
}

/**
 * Generates an isolated SQLite Prisma schema for the generated application.
 * Compatible with Prisma ORM v7 (no datasource URL in schema; configured in prisma.config.ts).
 * Never connects to or shares CodeMytra's internal platform database.
 */
export function buildPrismaSchema(
  models: Array<{ modelName: string; fields: string[]; relations?: string[] }>
): string {
  if (!models || models.length === 0) {
    throw new MissingDatabaseModelsError(
      "Cannot generate Prisma schema: persistence is required but no database models were provided."
    );
  }

  let schema = `// Prisma schema for generated application (isolated SQLite)
// CodeMytra Foundation v${FOUNDATION_VERSION}
datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client-js"
}
`;

  for (const model of models) {
    schema += `\nmodel ${model.modelName} {\n`;
    const rawFields = model.fields || [];
    const fields = rawFields.map(normalizePrismaField);

    // Ensure id field exists
    const hasId = fields.some((f) => f.startsWith("id ") || f.startsWith("id:"));
    if (!hasId) {
      schema += `  id String @id @default(cuid())\n`;
    }

    // Specific model guarantees for full-stack applications (such as Bookstore)
    if (model.modelName.toLowerCase() === "order") {
      const hasTotalPrice = fields.some((f) => f.startsWith("totalPrice ") || f.startsWith("totalPrice:"));
      if (!hasTotalPrice) {
        // If 'total' field exists, check if it's already Float; otherwise add totalPrice
        fields.push("totalPrice Float @default(0.0)");
      }
      const hasOrderDate = fields.some((f) => f.startsWith("orderDate ") || f.startsWith("orderDate:"));
      if (!hasOrderDate) {
        fields.push("orderDate DateTime @default(now())");
      }
      const hasStatus = fields.some((f) => f.startsWith("status ") || f.startsWith("status:"));
      if (!hasStatus) {
        fields.push('status String @default("pending")');
      }
    } else if (model.modelName.toLowerCase() === "book") {
      const hasPrice = fields.some((f) => f.startsWith("price ") || f.startsWith("price:"));
      if (!hasPrice) {
        fields.push("price Float @default(0.0)");
      }
      const hasStock = fields.some((f) => f.startsWith("stock ") || f.startsWith("stock:"));
      if (!hasStock) {
        fields.push("stock Int @default(10)");
      }
    } else if (model.modelName.toLowerCase() === "review") {
      const hasRating = fields.some((f) => f.startsWith("rating ") || f.startsWith("rating:"));
      if (!hasRating) {
        fields.push("rating Int @default(5)");
      }
    } else if (model.modelName.toLowerCase() === "user") {
      const hasEmail = fields.some((f) => f.startsWith("email ") || f.startsWith("email:"));
      if (!hasEmail) {
        fields.push("email String @unique");
      }
    }

    for (const field of fields) {
      // Normalize field definition: e.g. "title: String" -> "title String"
      const cleanField = field.replace(":", "");
      schema += `  ${cleanField}\n`;
    }

    // Ensure createdAt and updatedAt fields exist for auditability
    const hasCreatedAt = fields.some((f) => f.startsWith("createdAt"));
    if (!hasCreatedAt) {
      schema += `  createdAt DateTime @default(now())\n`;
    }
    const hasUpdatedAt = fields.some((f) => f.startsWith("updatedAt"));
    if (!hasUpdatedAt) {
      schema += `  updatedAt DateTime @updatedAt\n`;
    }

    schema += `}\n`;
  }

  return schema;
}

/**
 * Produces clean, versioned base application files for any generated project.
 * Provides reusable infrastructure (Next.js 16 App router, TypeScript 5, Tailwind CSS,
 * ESLint 9 flat config, and optional Prisma 7 SQLite driver adapter),
 * without imposing any predefined business functionality.
 */
export function getBaseProjectFiles(options: BaseProjectOptions = {}): Record<string, string> {
  const {
    projectName = "codemytra-app",
    capabilities = ["pages-navigation"],
    requiresDatabase = false,
    models = [],
  } = options;

  const needsDb = requiresDatabase || isDatabaseRequired(capabilities);

  const packageJson = {
    name: projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
      lint: "eslint",
      tsc: "tsc",
      typecheck: "tsc --noEmit",
      ...(needsDb
        ? {
            "db:push": "prisma db push",
            "db:generate": "prisma generate",
            "db:migrate": "prisma migrate dev",
          }
        : {}),
    },
    dependencies: {
      next: "16.4.2",
      react: "19.2.4",
      "react-dom": "19.2.4",
      clsx: "^2.1.1",
      "tailwind-merge": "^3.6.0",
      "lucide-react": "^1.21.0",
      zod: "^3.24.2",
      ...(needsDb
        ? {
            "@prisma/client": "^7.8.0",
            "@prisma/adapter-better-sqlite3": "^7.10.1",
            "better-sqlite3": "^13.0.3",
          }
        : {}),
    },
    devDependencies: {
      typescript: "5.9.3",
      "@types/node": "^20.17.0",
      "@types/react": "^19.0.8",
      "@types/react-dom": "^19.0.3",
      tailwindcss: "^3.4.17",
      postcss: "^8.5.1",
      autoprefixer: "^10.4.20",
      eslint: "^9.20.0",
      "eslint-config-next": "16.4.2",
      ...(needsDb
        ? {
            prisma: "^7.10.1",
            dotenv: "^16.4.7",
            "@types/better-sqlite3": "^9.6.0",
          }
        : {}),
    },
  };

  const tsConfig = {
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      paths: {
        "@/*": ["./*"],
      },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  };

  const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`;

  const eslintConfig = `import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
`;

  const tailwindConfig = `import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
`;

  const postCssConfig = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

  const globalsCss = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: #09090b;
  --foreground: #fafafa;
  --card: #18181b;
  --card-foreground: #fafafa;
  --primary: #3b82f6;
  --primary-foreground: #ffffff;
  --secondary: #27272a;
  --secondary-foreground: #fafafa;
  --muted: #27272a;
  --muted-foreground: #a1a1aa;
  --accent: #06b6d4;
  --accent-foreground: #ffffff;
  --border: #27272a;
}

body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
`;

  const rootLayout = `import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "${projectName}",
  description: "Built with CodeMytra",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
`;

  const libUtils = `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

  const baseFiles: Record<string, string> = {
    "package.json": JSON.stringify(packageJson, null, 2),
    "tsconfig.json": JSON.stringify(tsConfig, null, 2),
    "next.config.mjs": nextConfig,
    "eslint.config.mjs": eslintConfig,
    "tailwind.config.ts": tailwindConfig,
    "postcss.config.mjs": postCssConfig,
    "app/globals.css": globalsCss,
    "app/layout.tsx": rootLayout,
    "lib/utils.ts": libUtils,
  };

  if (needsDb) {
    if (!models || models.length === 0) {
      throw new MissingDatabaseModelsError(
        `Persistence is required for project "${projectName}" but the ArchitectureSpec contains no valid database models.`
      );
    }
    baseFiles["prisma/schema.prisma"] = buildPrismaSchema(models);
    baseFiles["prisma.config.ts"] = `import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"] ?? "file:./dev.db",
  },
});
`;
    baseFiles["lib/db.ts"] = `import path from "path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL;
  if (envUrl && envUrl.startsWith("file:")) {
    const rawPath = envUrl.slice(5);
    if (path.isAbsolute(rawPath)) return envUrl;
    return \`file:\${path.resolve(process.cwd(), rawPath)}\`;
  }
  return \`file:\${path.resolve(process.cwd(), "dev.db")}\`;
}

// Isolated application database (SQLite file inside sandbox workspace with Prisma 7 driver adapter)
function createPrismaClient(): PrismaClient {
  const url = resolveDatabaseUrl();
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
`;
    baseFiles[".env.example"] = `DATABASE_URL="file:./dev.db"\n`;
  }

  return baseFiles;
}

/**
 * Automatically synthesizes a components/index.ts barrel file if components exist
 * and no barrel file is already present. This ensures that imports like
 * `import { Header, Footer } from "@/components"` resolve cleanly without failing
 * TypeScript typechecking or Next.js production builds.
 */
export function synthesizeComponentsBarrel(files: Record<string, string>): Record<string, string> {
  // If components/index.ts or components/index.tsx already exists, preserve it
  if (files["components/index.ts"] || files["components/index.tsx"]) {
    return files;
  }

  // Find all component files in components/ (not index, test files, or non-ts/tsx)
  const componentPaths = Object.keys(files).filter((p) => {
    return (
      p.startsWith("components/") &&
      (p.endsWith(".tsx") || p.endsWith(".ts")) &&
      !p.endsWith("/index.ts") &&
      !p.endsWith("/index.tsx") &&
      !p.endsWith(".test.tsx") &&
      !p.endsWith(".test.ts")
    );
  });

  if (componentPaths.length === 0) {
    return files;
  }

  const exportStatements: string[] = [
    "// Auto-generated CodeMytra component barrel export",
  ];

  for (const compPath of componentPaths) {
    // Relative path from components/ to the file without extension
    const relFromComponents = compPath.slice("components/".length);
    const withoutExt = relFromComponents.replace(/\.(tsx|ts)$/, "");
    const importTarget = `./${withoutExt}`;
    const componentName = path.basename(withoutExt);
    const content = files[compPath] || "";

    const hasDefaultExport = /export\s+default\s+/m.test(content);
    const hasNamedExport =
      /export\s+(async\s+)?(function|const|let|var|class|interface|type)\s+/m.test(content) ||
      /export\s+\{/m.test(content);

    // Re-export named exports if any exist
    if (hasNamedExport) {
      exportStatements.push(`export * from "${importTarget}";`);
    }

    // If there is a default export, re-export it under the component filename
    // e.g. export { default as Header } from "./Header";
    if (hasDefaultExport && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(componentName)) {
      exportStatements.push(`export { default as ${componentName} } from "${importTarget}";`);
    } else if (!hasNamedExport) {
      exportStatements.push(`export * from "${importTarget}";`);
    }
  }

  return {
    ...files,
    "components/index.ts": exportStatements.join("\n") + "\n",
  };
}
