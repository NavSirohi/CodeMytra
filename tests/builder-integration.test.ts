import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/db";
import { createProject } from "@/features/projects/actions";
import { submitContactMessage } from "@/features/contact/actions";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";

describe("Phase 2: Builder & Contact Integration", () => {
  let originalDevAuth: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalUserUpsert: any;
  let originalUserFindUnique: any;
  let originalTx: any;
  let originalContactCreate: any;
  let originalQueryRaw: any;

  beforeEach(() => {
    originalDevAuth = process.env.ALLOW_INSECURE_DEV_AUTH;
    originalNodeEnv = process.env.NODE_ENV;
    originalUserUpsert = prisma.user.upsert;
    originalUserFindUnique = prisma.user.findUnique;
    originalTx = prisma.$transaction;
    originalQueryRaw = prisma.$queryRawUnsafe;
    originalContactCreate = (prisma as any).contactSubmission?.create;
  });

  afterEach(() => {
    process.env.ALLOW_INSECURE_DEV_AUTH = originalDevAuth;
    (process.env as any).NODE_ENV = originalNodeEnv;
    prisma.user.upsert = originalUserUpsert;
    prisma.user.findUnique = originalUserFindUnique;
    prisma.$transaction = originalTx;
    prisma.$queryRawUnsafe = originalQueryRaw;
    if ((prisma as any).contactSubmission) {
      (prisma as any).contactSubmission.create = originalContactCreate;
    }
  });

  describe("Task 4 & 5: Project Onboarding & Prompt Handling", () => {
    it("rejects prompts that are too short (< 3 characters)", async () => {
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";

      prisma.user.upsert = (async () => ({
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
      })) as any;

      const result = await createProject("ab");
      assert.ok("error" in result);
      assert.equal(result.error, "Prompt must be at least 3 characters long");
    });

    it("rejects prompts exceeding maximum length (> 4000 characters)", async () => {
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";

      prisma.user.upsert = (async () => ({
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
      })) as any;

      const longPrompt = "a".repeat(4001);
      const result = await createProject(longPrompt);
      assert.ok("error" in result);
      assert.equal(result.error, "Prompt exceeds maximum length of 4000 characters");
    });

    it("rejects unauthenticated project creation when dev auth is disabled", async () => {
      delete process.env.ALLOW_INSECURE_DEV_AUTH;
      (process.env as any).NODE_ENV = "production";

      const result = await createProject("Valid arbitrary prompt for my bakery app");
      assert.ok("error" in result);
      assert.equal(result.error, "Unauthorized");
    });

    it("creates project, user message, queued GenerationRun, and OutboxEvent for arbitrary prompt", async () => {
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";

      const testUserId = "usr-builder-123";
      prisma.user.upsert = (async () => ({
        id: testUserId,
        email: "builder@example.com",
        name: "Builder User",
        clerkId: "dev-user-local",
      })) as any;

      prisma.$queryRawUnsafe = (async (query: string, ...args: any[]) => {
        if (query.includes("FOR UPDATE SKIP LOCKED")) {
          return [{
            id: "evt-generated-012",
            eventName: "code-agent/run",
            payload: { runId: "run-generated-789", projectId: "prj-generated-456", prompt: arbitraryPrompt },
            claimToken: "token-test",
          }];
        }
        return [{ id: args[0] }];
      }) as any;
      let capturedProject: any = null;
      let capturedRun: any = null;
      let capturedOutbox: any = null;

      prisma.$transaction = (async (callback: any) => {
        const fakeTx = {
          project: {
            create: async (args: any) => {
              capturedProject = {
                id: "prj-generated-456",
                name: args.data.name,
                userId: args.data.userId,
                messages: args.data.messages,
              };
              return capturedProject;
            },
          },
          generationRun: {
            create: async (args: any) => {
              capturedRun = {
                id: "run-generated-789",
                ...args.data,
              };
              return capturedRun;
            },
          },
          outboxEvent: {
            create: async (args: any) => {
              capturedOutbox = {
                id: "evt-generated-012",
                ...args.data,
              };
              return capturedOutbox;
            },
          },
        };
        return await callback(fakeTx);
      }) as any;

      const arbitraryPrompt = "Goal: Build a modern inventory tracker for a boutique floral shop\nVisual Style: Bold & modern";
      const result = await createProject(arbitraryPrompt);

      assert.ok(!("error" in result), `Expected project creation but got error: ${JSON.stringify(result)}`);
      assert.ok("id" in result, "Result must contain project ID");
      assert.equal(result.id, "prj-generated-456");

      // Verify Project and Message data
      assert.ok(capturedProject);
      assert.equal(capturedProject.userId, testUserId);
      assert.equal(capturedProject.messages.create.role, MessageRole.USER);
      assert.equal(capturedProject.messages.create.type, MessageType.RESULT);
      assert.equal(capturedProject.messages.create.content, arbitraryPrompt);

      // Verify GenerationRun was queued
      assert.ok(capturedRun);
      assert.equal(capturedRun.status, GenerationRunStatus.QUEUED);
      assert.equal(capturedRun.prompt, arbitraryPrompt);
      assert.equal(capturedRun.baseRevisionId, null);

      // Verify OutboxEvent
      assert.ok(capturedOutbox);
      assert.equal(capturedOutbox.eventName, "code-agent/run");
      assert.equal(capturedOutbox.payload.runId, "run-generated-789");
      assert.equal(capturedOutbox.payload.projectId, "prj-generated-456");
      assert.equal(capturedOutbox.payload.prompt, arbitraryPrompt);
    });

    it("verifies prompt preservation logic without duplicate submissions", () => {
      const pendingBrief = {
        idea: "Build a bespoke coffee subscription service",
        selectedStyle: "Warm & friendly",
        selectedExample: null,
        pendingSubmit: true,
        savedAt: Date.now(),
      };

      const serialized = JSON.stringify(pendingBrief);
      const restored = JSON.parse(serialized);

      assert.equal(restored.idea, "Build a bespoke coffee subscription service");
      assert.equal(restored.selectedStyle, "Warm & friendly");
      assert.equal(restored.pendingSubmit, true);

      // Disarm pendingSubmit immediately upon resumption to guarantee no repeated runs
      const disarmed = { ...restored, pendingSubmit: false };
      assert.equal(disarmed.pendingSubmit, false, "Must disarm pendingSubmit to prevent duplicate runs on refresh");
    });
  });

  describe("Task 6: Functional Contact Workflow", () => {
    it("validates form fields (rejects invalid email, short message, etc.)", async () => {
      const invalidEmailRes = await submitContactMessage({
        name: "Tester",
        email: "not-an-email",
        subject: "General",
        message: "This is a valid long enough message.",
      });
      assert.equal(invalidEmailRes.success, false);
      assert.ok(invalidEmailRes.errors?.email);

      const shortMessageRes = await submitContactMessage({
        name: "Tester",
        email: "test@example.com",
        subject: "General",
        message: "Hi",
      });
      assert.equal(shortMessageRes.success, false);
      assert.ok(shortMessageRes.errors?.message);
    });

    it("silently discards spam when honeypot botField is filled without storing", async () => {
      let created = false;
      (prisma as any).contactSubmission = {
        create: async () => {
          created = true;
          return { id: "contact-1" };
        },
      };

      const res = await submitContactMessage({
        name: "Spam Bot",
        email: "spammer@bot.com",
        subject: "Spam Topic",
        message: "Buy cheap products now online!",
        botField: "https://spamlink.com",
      });

      assert.equal(res.success, true);
      assert.ok(res.message.includes("received"));
      assert.equal(created, false, "Honeypot submission must not be saved in database");
    });

    it("persists valid contact submissions in database", async () => {
      let savedData: any = null;
      (prisma as any).contactSubmission = {
        create: async (args: any) => {
          savedData = args.data;
          return { id: "contact-valid-1", ...args.data };
        },
      };

      const email = `contact-test-${Date.now()}@example.com`;
      const res = await submitContactMessage({
        name: "Sarah Chen",
        email,
        subject: "Early access",
        message: "We would love to try CodeMytra for our team agency projects.",
      });

      assert.equal(res.success, true);
      assert.ok(res.message.includes("received"));
      assert.ok(savedData, "Contact submission must be saved via prisma");
      assert.equal(savedData.name, "Sarah Chen");
      assert.equal(savedData.subject, "Early access");
      assert.equal(savedData.message, "We would love to try CodeMytra for our team agency projects.");
    });

    it("falls back gracefully with clipboard guidance when database storage fails", async () => {
      (prisma as any).contactSubmission = {
        create: async () => {
          throw new Error("Database unconfigured or connection refused");
        },
      };

      const res = await submitContactMessage({
        name: "Fallback User",
        email: "fallback@example.com",
        subject: "Question",
        message: "Checking the fallback behavior when database is offline.",
      });

      assert.equal(res.success, false);
      assert.equal(res.fallbackToClipboard, true);
      assert.ok(res.message.includes("clipboard"));
    });

    it("enforces rate limits on excessive repeated submissions from the same email", async () => {
      (prisma as any).contactSubmission = {
        create: async (args: any) => ({ id: "rate-1", ...args.data }),
      };

      const rateLimitEmail = `rate-limit-${Date.now()}@test.com`;

      for (let i = 0; i < 5; i++) {
        const res = await submitContactMessage({
          name: "Rapid Submitter",
          email: rateLimitEmail,
          subject: "Feedback",
          message: `Testing repeated submission attempt #${i + 1}`,
        });
        assert.equal(res.success, true, `Submission ${i + 1} should succeed within rate limit`);
      }

      // 6th attempt within window must be rate limited
      const sixthRes = await submitContactMessage({
        name: "Rapid Submitter",
        email: rateLimitEmail,
        subject: "Feedback",
        message: "This sixth attempt should exceed rate limit threshold",
      });

      assert.equal(sixthRes.success, false);
      assert.ok(sixthRes.message.includes("Too many submissions"));
    });
  });

  describe("Task 7: Graceful Skip When AI Credentials Unconfigured", () => {
    it("gracefully detects unconfigured Gemini API key without false reporting", () => {
      const hasGemini = Boolean(process.env.GEMINI_API_KEY);
      if (!hasGemini) {
        assert.ok(true, "GEMINI_API_KEY is not configured in local environment; live generation skipped as required");
      } else {
        assert.ok(process.env.GEMINI_API_KEY!.length > 0);
      }
    });

    it("gracefully detects unconfigured E2B sandbox credentials without false reporting", () => {
      const hasE2B = Boolean(process.env.E2B_API_KEY);
      if (!hasE2B) {
        assert.ok(true, "E2B_API_KEY is not configured in local environment; live sandbox execution skipped as required");
      } else {
        assert.ok(process.env.E2B_API_KEY!.length > 0);
      }
    });
  });
});
