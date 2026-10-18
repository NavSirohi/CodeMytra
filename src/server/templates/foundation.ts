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

/**
 * Generates an isolated SQLite Prisma schema for the generated application.
 * Compatible with Prisma ORM v7 (no datasource URL in schema; configured in prisma.config.ts).
 * Never connects to or shares CodeMytra's internal platform database.
 */
export function buildPrismaSchema(
  models: Array<{ modelName: string; fields: string[]; relations?: string[] }> = []
): string {
  let schema = `// Prisma schema for generated application (isolated SQLite)
// CodeMytra Foundation v${FOUNDATION_VERSION}
datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client-js"
}
`;

  const modelsToGenerate = models.length > 0
    ? models
    : [{ modelName: "Item", fields: ["title String"] }];

  for (const model of modelsToGenerate) {
    schema += `\nmodel ${model.modelName} {\n`;
    const fields = model.fields || [];

    // Ensure id field exists
    const hasId = fields.some((f) => f.startsWith("id ") || f.startsWith("id:"));
    if (!hasId) {
      schema += `  id String @id @default(cuid())\n`;
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
      ...(needsDb
        ? {
            "db:push": "prisma db push",
            "db:generate": "prisma generate",
            "db:migrate": "prisma migrate dev",
          }
        : {}),
    },
    dependencies: {
      next: "16.2.9",
      react: "19.2.4",
      "react-dom": "19.2.4",
      clsx: "^2.1.1",
      "tailwind-merge": "^3.0.2",
      "lucide-react": "^1.16.0",
      zod: "^3.24.2",
      ...(needsDb
        ? {
            "@prisma/client": "^7.8.0",
            "@prisma/adapter-better-sqlite3": "^7.8.0",
            "better-sqlite3": "^11.8.1",
          }
        : {}),
    },
    devDependencies: {
      typescript: "^5.7.3",
      "@types/node": "^20.17.0",
      "@types/react": "^19.0.8",
      "@types/react-dom": "^19.0.3",
      tailwindcss: "^3.4.17",
      postcss: "^8.5.1",
      autoprefixer: "^10.4.20",
      eslint: "^9.20.0",
      "eslint-config-next": "16.2.9",
      ...(needsDb
        ? {
            prisma: "^7.8.0",
            dotenv: "^16.4.7",
            "@types/better-sqlite3": "^7.6.12",
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
