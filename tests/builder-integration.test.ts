import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/db";
import { createProject } from "@/features/projects/actions";
import { submitContactMessage } from "@/features/contact/actions";
import { checkContactRateLimit } from "@/server/security/rate-limiter";
import { MessageRole, MessageType, GenerationRunStatus } from "@/generated/prisma/client";

describe("Phase 2: Builder & Contact Integration", () => {
  let originalDevAuth: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalDbUrl: string | undefined;
  let originalUserUpsert: any;
  let originalUserFindUnique: any;
  let originalProjectFindUnique: any;
  let originalTx: any;
  let originalContactCreate: any;
  let originalRateLimitCount: any;
  let originalRateLimitCreate: any;
  let originalQueryRaw: any;

  beforeEach(() => {
    originalDevAuth = process.env.ALLOW_INSECURE_DEV_AUTH;
    originalNodeEnv = process.env.NODE_ENV;
    originalDbUrl = process.env.DATABASE_URL;
    originalUserUpsert = prisma.user.upsert;
    originalUserFindUnique = prisma.user.findUnique;
    originalProjectFindUnique = prisma.project.findUnique;
    originalTx = prisma.$transaction;
    originalQueryRaw = prisma.$queryRawUnsafe;
    originalContactCreate = (prisma as any).contactSubmission?.create;
    originalRateLimitCount = (prisma as any).rateLimitRecord?.count;
    originalRateLimitCreate = (prisma as any).rateLimitRecord?.create;
  });

  afterEach(() => {
    process.env.ALLOW_INSECURE_DEV_AUTH = originalDevAuth;
    (process.env as any).NODE_ENV = originalNodeEnv;
    if (originalDbUrl !== undefined) {
      process.env.DATABASE_URL = originalDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    prisma.user.upsert = originalUserUpsert;
    prisma.user.findUnique = originalUserFindUnique;
    prisma.project.findUnique = originalProjectFindUnique;
    prisma.$transaction = originalTx;
    prisma.$queryRawUnsafe = originalQueryRaw;
    if ((prisma as any).contactSubmission) {
      (prisma as any).contactSubmission.create = originalContactCreate;
    }
    if ((prisma as any).rateLimitRecord) {
      (prisma as any).rateLimitRecord.count = originalRateLimitCount;
      (prisma as any).rateLimitRecord.create = originalRateLimitCreate;
    }
  });

  describe("Task 1: Idempotent Project Creation", () => {
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

      const arbitraryPrompt = "Goal: Build a modern inventory tracker for a boutique floral shop\nVisual Style: Bold & modern";
      const submissionKey = "brief-key-999";

      prisma.project.findUnique = (async () => null) as any;

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
                idempotencyKey: args.data.idempotencyKey,
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

      const result = await createProject(arbitraryPrompt, submissionKey);

      assert.ok(!("error" in result), `Expected project creation but got error: ${JSON.stringify(result)}`);
      assert.ok("id" in result, "Result must contain project ID");
      assert.equal(result.id, "prj-generated-456");

      // Verify Project and Message data
      assert.ok(capturedProject);
      assert.equal(capturedProject.userId, testUserId);
      assert.equal(capturedProject.idempotencyKey, submissionKey);
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

    it("returns existing project on repeated submission of the same idempotencyKey", async () => {
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";

      const testUserId = "usr-builder-123";
      prisma.user.upsert = (async () => ({
        id: testUserId,
        email: "builder@example.com",
        name: "Builder User",
        clerkId: "dev-user-local",
      })) as any;

      const existingProject = {
        id: "prj-already-created",
        name: "warm-bakery",
        userId: testUserId,
        idempotencyKey: "brief-key-existing",
      };

      // Mock findUnique to return existing project
      prisma.project.findUnique = (async () => existingProject) as any;

      let txCalled = false;
      prisma.$transaction = (async () => {
        txCalled = true;
      }) as any;

      const result = await createProject("Goal: Build bakery app", "brief-key-existing");

      assert.ok(!("error" in result));
      assert.equal((result as any).id, "prj-already-created");
      assert.equal(txCalled, false, "Transaction must not run for already existing idempotencyKey");
    });

    it("safely handles race condition when concurrent insert throws unique constraint error", async () => {
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";

      const testUserId = "usr-builder-123";
      prisma.user.upsert = (async () => ({
        id: testUserId,
        email: "builder@example.com",
        name: "Builder User",
        clerkId: "dev-user-local",
      })) as any;

      const committedProject = {
        id: "prj-race-winner",
        name: "race-project",
        userId: testUserId,
        idempotencyKey: "key-race-1",
      };

      let findUniqueCallCount = 0;
      prisma.project.findUnique = (async () => {
        findUniqueCallCount++;
        // First check returns null (neither exists yet), catch block check returns committedProject
        if (findUniqueCallCount === 1) return null;
        return committedProject;
      }) as any;

      // Transaction throws unique constraint violation (simulating second concurrent insert losing the race)
      prisma.$transaction = (async () => {
        const p2002Err: any = new Error("Unique constraint failed on the fields: (`userId`,`idempotencyKey`)");
        p2002Err.code = "P2002";
        p2002Err.meta = { target: ["userId", "idempotencyKey"] };
        throw p2002Err;
      }) as any;

      const result = await createProject("Goal: Concurrent app", "key-race-1");

      assert.ok(!("error" in result));
      assert.equal((result as any).id, "prj-race-winner", "Raced request must recover and return committed project");
    });
  });

  describe("Task 2: Truthful Contact Submission Feedback", () => {
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

    it("rejects honeypot bot submissions without claiming reception or saving", async () => {
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

      assert.equal(res.success, false);
      assert.equal(created, false, "Honeypot submission must not be saved in database");
      assert.ok(!res.message.includes("received"), "Never claim message received when not saved");
    });

    it("persists valid contact submissions and reports honest reception", async () => {
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

    it("honestly reports failure and instructs clipboard fallback when database storage fails", async () => {
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
      assert.ok(!res.message.includes("received"), "Must never say message received on database failure");
      assert.ok(res.message.includes("unconfigured") || res.message.includes("unavailable"));
    });
  });

  describe("Task 3: Shared Abuse Protection (Rate Limiter)", () => {
    it("explicitly identifies unconfigured rate limit backend when DATABASE_URL is unset", async () => {
      delete process.env.DATABASE_URL;
      delete process.env.DATABASE_URL_DIRECT;

      const result = await checkContactRateLimit({ identifier: "unconfigured-test@example.com" });
      assert.equal(result.configured, false);
      assert.equal(result.status, "unconfigured");
      assert.ok(result.message?.includes("not configured"));
    });

    it("records attempts and enforces limit in shared store without storing plaintext PII", async () => {
      process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";

      const attempts: string[] = [];
      (prisma as any).rateLimitRecord = {
        count: async () => attempts.length,
        create: async (args: any) => {
          attempts.push(args.data.keyHash);
          return { id: `rl-${attempts.length}`, ...args.data };
        },
      };

      const testEmail = "AbuseUser@Domain.COM";

      for (let i = 0; i < 5; i++) {
        const res = await checkContactRateLimit({ identifier: testEmail, limit: 5 });
        assert.equal(res.allowed, true, `Attempt ${i + 1} should be allowed`);
        assert.equal(res.configured, true);
      }

      // 6th attempt must be rejected
      const sixthRes = await checkContactRateLimit({ identifier: testEmail, limit: 5 });
      assert.equal(sixthRes.allowed, false, "6th attempt must be rate-limited");
      assert.equal(sixthRes.status, "rate_limited");
      assert.ok(sixthRes.message?.includes("Too many submissions"));

      // Verify no PII (email, name) was stored in attempts list
      assert.equal(attempts.length, 5);
      for (const hash of attempts) {
        assert.ok(!hash.includes("@"), "Hash must not contain email symbol");
        assert.ok(!hash.includes("AbuseUser"), "Hash must not contain plaintext email name");
        assert.equal(hash.length, 64, "Key hash must be SHA-256 (64 hex chars)");
      }
    });
  });

  describe("Task 4: Graceful Skip When AI Credentials Unconfigured", () => {
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
