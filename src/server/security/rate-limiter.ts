import crypto from "node:crypto";
import { prisma } from "@/lib/db";

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
      allowed: true,
      status: "unconfigured",
      message: "Shared rate limit backend is not configured.",
    };
  }

  try {
    const windowStart = new Date(Date.now() - windowMs);

    // Count attempts within the sliding window from shared database
    const count = await prisma.rateLimitRecord.count({
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
    await prisma.rateLimitRecord.create({
      data: { keyHash },
    });

    return {
      configured: true,
      allowed: true,
      status: "ok",
    };
  } catch (error) {
    console.warn(
      `[AbuseProtection] Shared rate limit backend error; treating as unconfigured:`,
      error instanceof Error ? error.message : error
    );
    return {
      configured: false,
      allowed: true,
      status: "unconfigured",
      message: "Shared rate limit backend is unavailable.",
    };
  }
}
