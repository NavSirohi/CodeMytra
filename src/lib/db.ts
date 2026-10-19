import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export interface DatabaseConfigValidation {
  isValid: boolean;
  connectionString: string;
  isProduction: boolean;
  isFallback: boolean;
  error?: string;
}

/**
 * Validates the database configuration against runtime environment policies.
 * Replaces implicit production fallbacks with explicit validation.
 */
export function validateDatabaseConfig(): DatabaseConfigValidation {
  const url = process.env.DATABASE_URL;
  const isProduction = process.env.NODE_ENV === "production";
  const isBuilding =
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build";

  if (isProduction) {
    if (!url) {
      if (isBuilding) {
        // Next.js build step needs Prisma client types without live runtime queries
        return {
          isValid: true,
          connectionString: "postgresql://postgres:postgres@localhost:5432/codemytra",
          isProduction: true,
          isFallback: true,
        };
      }
      return {
        isValid: false,
        connectionString: "",
        isProduction: true,
        isFallback: false,
        error:
          "[Database Configuration] DATABASE_URL is not configured. Production runtime requires a valid Neon PostgreSQL connection string. Implicit localhost fallback is prohibited.",
      };
    }

    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      return {
        isValid: false,
        connectionString: url,
        isProduction: true,
        isFallback: false,
        error:
          "[Database Configuration] DATABASE_URL cannot target localhost or 127.0.0.1 in production. Configure a production-grade PostgreSQL connection string.",
      };
    }

    return {
      isValid: true,
      connectionString: url,
      isProduction: true,
      isFallback: false,
    };
  }

  // Development and test environments
  if (!url) {
    return {
      isValid: true,
      connectionString: "postgresql://postgres:postgres@localhost:5432/codemytra",
      isProduction: false,
      isFallback: true,
    };
  }

  return {
    isValid: true,
    connectionString: url,
    isProduction: false,
    isFallback: false,
  };
}

function createPrismaClient(): PrismaClient {
  const config = validateDatabaseConfig();
  if (!config.isValid) {
    throw new Error(config.error);
  }
  const adapter = new PrismaPg({ connectionString: config.connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;