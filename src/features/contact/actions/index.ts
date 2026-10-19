"use server";

import { prisma } from "@/lib/db";
import { z } from "zod";

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
  errors?: Record<string, string>;
};

// In-memory sliding window rate limiter: max 5 submissions per email within 10 minutes
const submissionTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;

function isRateLimited(identifier: string): boolean {
  const now = Date.now();
  const timestamps = submissionTimestamps.get(identifier) ?? [];
  const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (validTimestamps.length >= MAX_SUBMISSIONS_PER_WINDOW) {
    submissionTimestamps.set(identifier, validTimestamps);
    return true;
  }

  validTimestamps.push(now);
  submissionTimestamps.set(identifier, validTimestamps);
  return false;
}

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

  // Honeypot check: If the hidden bot field is filled, silently ignore and succeed
  if (botField && botField.trim().length > 0) {
    return {
      success: true,
      message: "Thank you for reaching out! We have received your message.",
    };
  }

  // Rate limiting
  if (isRateLimited(email.toLowerCase())) {
    return {
      success: false,
      message: "Too many submissions received. Please wait a few minutes before trying again.",
    };
  }

  // Database persistence with honest fallback
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
      message: "Thank you for reaching out! Your message has been received.",
    };
  } catch (error) {
    console.error("❌ Failed to save contact submission to database:", error);
    return {
      success: false,
      fallbackToClipboard: true,
      message:
        "Storage is currently unconfigured or unavailable. Your message has been copied to your clipboard so you can send it directly.",
    };
  }
}
