import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type TransactionOrClient = Prisma.TransactionClient | typeof prisma;

export type RateLimitStatus = "ok" | "rate_limited" | "unconfigured";

export interface RateLimitResult {
  configured: boolean;
  allowed: boolean;
  status: RateLimitStatus;
  message?: string;
  retryAfterSeconds?: number;
}

export interface RateLimitOptions {
  identifier: string;
  limit?: number;
  windowMs?: number;
  requireProtection?: boolean;
}

export function isAbuseProtectionRequired(options?: RateLimitOptions): boolean {
  if (options?.requireProtection !== undefined) {
    return options.requireProtection;
  }
  return (
    process.env.NODE_ENV === "production" ||
    process.env.REQUIRE_ABUSE_PROTECTION === "true"
  );
}

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Shared production-compatible rate limiter backed by the database.
 * Operates across separate application processes.
 * Hashing is applied to avoid storing or logging sensitive PII.
 */
export async function checkContactRateLimit(
  options: RateLimitOptions
): Promise<RateLimitResult> {
  const { identifier, limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS } = options;
  const protectionRequired = isAbuseProtectionRequired(options);

  if (!identifier || !identifier.trim()) {
    return {
      configured: true,
      allowed: true,
      status: "ok",
    };
  }

  // Hash identifier to protect user privacy (no plaintext email/IP in logs or abuse store)
  const keyHash = crypto
    .createHash("sha256")
    .update(identifier.trim().toLowerCase())
    .digest("hex");
  const maskedKey = keyHash.substring(0, 10);

  // Check if database storage is configured
  const hasDbConfig = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_DIRECT);
  if (!hasDbConfig) {
    console.warn(
      `[AbuseProtection] Shared rate limit backend is not configured (status: unconfigured).`
    );
    return {
      configured: false,
      allowed: !protectionRequired,
      status: "unconfigured",
      message: "Shared rate limit backend is unconfigured and not configured.",
    };
  }

  try {
    const executeAdmission = async (tx: TransactionOrClient): Promise<RateLimitResult> => {
      // PostgreSQL atomic admission: serialize checks for this identifier hash
      // using transaction-level advisory locks to prevent concurrent race conditions.
      try {
        if (typeof tx.$executeRaw === "function") {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${keyHash}))`;
        }
      } catch {
        // If the database does not support pg_advisory_xact_lock (e.g. SQLite / mock), proceed inside transaction.
      }

      const windowStart = new Date(Date.now() - windowMs);

      // Count attempts within the sliding window from shared database
      const count = await tx.rateLimitRecord.count({
        where: {
          keyHash,
          createdAt: { gte: windowStart },
        },
      });

      if (count >= limit) {
        console.warn(
          `[AbuseProtection] Rate limit exceeded for identifier hash: ${maskedKey}`
        );
        return {
          configured: true,
          allowed: false,
          status: "rate_limited",
          message: "Too many submissions received. Please wait a few minutes before trying again.",
          retryAfterSeconds: Math.ceil(windowMs / 1000),
        };
      }

      // Record the current attempt in the shared database
      await tx.rateLimitRecord.create({
        data: { keyHash },
      });

      return {
        configured: true,
        allowed: true,
        status: "ok",
      };
    };

    if (typeof prisma.$transaction === "function") {
      return await prisma.$transaction(async (tx) => executeAdmission(tx));
    }
    return await executeAdmission(prisma);
  } catch (error) {
    console.warn(
      `[AbuseProtection] Shared rate limit backend error:`,
      error instanceof Error ? error.message : error
    );
    return {
      configured: false,
      allowed: !protectionRequired,
      status: "unconfigured",
      message: "Shared rate limit backend is unavailable.",
    };
  }
}
