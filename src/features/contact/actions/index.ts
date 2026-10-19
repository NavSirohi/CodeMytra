"use server";

import { prisma } from "@/lib/db";
import { z } from "zod";
import { checkContactRateLimit, type RateLimitStatus } from "@/server/security/rate-limiter";

const contactSubmissionSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name too long"),
  email: z.string().trim().email("Invalid email address").max(100, "Email too long"),
  subject: z.string().trim().min(1, "Subject is required").max(100, "Subject too long"),
  message: z.string().trim().min(5, "Message must be at least 5 characters").max(4000, "Message too long"),
  botField: z.string().optional(),
});

export type ContactSubmissionInput = z.infer<typeof contactSubmissionSchema>;

export type ContactSubmissionResult = {
  success: boolean;
  message: string;
  fallbackToClipboard?: boolean;
  rateLimitStatus?: RateLimitStatus;
  errors?: Record<string, string>;
};

export async function submitContactMessage(
  data: ContactSubmissionInput
): Promise<ContactSubmissionResult> {
  const parsed = contactSubmissionSchema.safeParse(data);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0]?.toString() ?? "general";
      errors[field] = issue.message;
    }
    return {
      success: false,
      message: "Please correct the errors in the form.",
      errors,
    };
  }

  const { name, email, subject, message, botField } = parsed.data;

  // Honeypot check: If the hidden bot field is filled, reject without claiming reception
  if (botField && botField.trim().length > 0) {
    return {
      success: false,
      message: "Submission could not be accepted.",
    };
  }

  // Shared production-compatible rate limiting
  const rateLimit = await checkContactRateLimit({ identifier: email });
  if (!rateLimit.allowed) {
    return {
      success: false,
      fallbackToClipboard: rateLimit.status === "unconfigured",
      rateLimitStatus: rateLimit.status,
      message: rateLimit.message || "Too many submissions received. Please wait a few minutes before trying again.",
    };
  }

  // Database persistence with honest fallback reporting
  try {
    await prisma.contactSubmission.create({
      data: {
        name,
        email,
        subject,
        message,
      },
    });

    return {
      success: true,
      rateLimitStatus: rateLimit.status,
      message: "Thank you for reaching out! Your message has been received.",
    };
  } catch (error) {
    console.error("❌ Failed to save contact submission to database:", error);
    return {
      success: false,
      fallbackToClipboard: true,
      rateLimitStatus: rateLimit.status,
      message:
        "Storage is currently unconfigured or unavailable. Please use the copyable message below to contact us directly.",
    };
  }
}
