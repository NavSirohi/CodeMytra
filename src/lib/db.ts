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
  // Next.js sets NEXT_PHASE to phase-production-build strictly during next build
  const isNextProductionBuild = process.env.NEXT_PHASE === "phase-production-build";

  if (isProduction) {
    if (!url) {
      if (isNextProductionBuild) {
        // Next.js build step needs Prisma client symbols for type-checking and route tracing
        // without live runtime database queries.
        return {
          isValid: true,
          connectionString: "postgresql://build-stub:build-stub@localhost:5432/build_stub_disabled",
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
  const client = new PrismaClient({ adapter });

  // In production build phase with fallback, proxy the client to ensure no queries can execute
  if (config.isProduction && config.isFallback) {
    return new Proxy(client, {
      get(target, prop, receiver) {
        // Allow inspection and symbol access
        if (typeof prop === "symbol" || prop === "then" || prop === "toString") {
          return Reflect.get(target, prop, receiver);
        }
        // If a query delegate or query execution is attempted without real DATABASE_URL, fail immediately
        if (typeof target[prop as keyof PrismaClient] === "function") {
          return () => {
            throw new Error(
              "[Database Configuration] Cannot execute database queries during build or without a valid production DATABASE_URL. Implicit localhost fallback is blocked."
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;