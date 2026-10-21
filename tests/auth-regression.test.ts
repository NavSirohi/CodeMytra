import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { NextRequest } from "next/server";
import { Header } from "@/components/marketing/header";
import { evaluateAuthRouting, config as proxyConfig } from "@/proxy";
import { createProject, getProjectById, getProjectRevisions } from "@/features/projects/actions";
import { generateProjectZip } from "@/server/export/zip-export";
import { getCurrentUser } from "@/features/auth/actions";
import { prisma } from "@/lib/db";
import { MessageRole, GenerationRunStatus } from "@/generated/prisma/client";

describe("M4 Authentication & Navigation Regression Suite", () => {
  let originalDevAuth: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalClerkPub: string | undefined;
  let originalClerkSec: string | undefined;
  let originalUserUpsert: any;
  let originalUserFindUnique: any;
  let originalProjectFindUnique: any;
  let originalProjectFindMany: any;
  let originalRevisionFindMany: any;
  let originalTx: any;
  let originalQueryRaw: any;

  beforeEach(() => {
    originalDevAuth = process.env.ALLOW_INSECURE_DEV_AUTH;
    originalNodeEnv = process.env.NODE_ENV;
    originalClerkPub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    originalClerkSec = process.env.CLERK_SECRET_KEY;
    originalUserUpsert = prisma.user.upsert;
    originalUserFindUnique = prisma.user.findUnique;
    originalProjectFindUnique = prisma.project.findUnique;
    originalProjectFindMany = prisma.project.findMany;
    originalRevisionFindMany = prisma.projectRevision.findMany;
    originalTx = prisma.$transaction;
    originalQueryRaw = prisma.$queryRawUnsafe;
  });

  afterEach(() => {
    process.env.ALLOW_INSECURE_DEV_AUTH = originalDevAuth;
    (process.env as any).NODE_ENV = originalNodeEnv;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalClerkPub;
    process.env.CLERK_SECRET_KEY = originalClerkSec;
    prisma.user.upsert = originalUserUpsert;
    prisma.user.findUnique = originalUserFindUnique;
    prisma.project.findUnique = originalProjectFindUnique;
    prisma.project.findMany = originalProjectFindMany;
    prisma.projectRevision.findMany = originalRevisionFindMany;
    prisma.$transaction = originalTx;
    prisma.$queryRawUnsafe = originalQueryRaw;
  });

  describe("Requirement 1: Signed-Out Navigation Displays Authentication Actions", () => {
    it("renders Sign In, Get Started / Sign Up, and Try the Builder for unauthenticated visitors", () => {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
      const html = renderToString(
        React.createElement(Header as React.ComponentType<{ isAuthenticated?: boolean }>, {
          isAuthenticated: false,
        })
      );

      assert.ok(
        html.includes('href="/sign-in"'),
        "Header must render a link to /sign-in"
      );
      assert.ok(
        html.includes("Sign In"),
        "Header must display 'Sign In' text for signed-out users"
      );
      assert.ok(
        html.includes("Get Started / Sign Up"),
        "Header must display 'Get Started / Sign Up' action for signed-out users"
      );
      assert.ok(
        html.includes('href="/builder"'),
        "Header must contain link to /builder"
      );
      assert.ok(
        html.includes("Try the builder"),
        "Header must display 'Try the builder' action"
      );

      // Must not display signed-in actions
      assert.ok(
        !html.includes('href="/dashboard"'),
        "Signed-out header must not display Dashboard link"
      );
      assert.ok(
        !html.includes("Sign Out"),
        "Signed-out header must not display Sign Out button"
      );
    });
  });

  describe("Requirement 2: Signed-In Navigation Displays Dashboard/Account Actions", () => {
    it("renders Dashboard, user account controls, and Sign Out for authenticated users", () => {
      const html = renderToString(
        React.createElement(Header as React.ComponentType<{ isAuthenticated?: boolean }>, {
          isAuthenticated: true,
        })
      );

      assert.ok(
        html.includes('href="/dashboard"'),
        "Signed-in header must display link to /dashboard"
      );
      assert.ok(
        html.includes("Dashboard"),
        "Signed-in header must display 'Dashboard' text"
      );
      assert.ok(
        html.includes("Sign Out"),
        "Signed-in header must display 'Sign Out' action"
      );
      assert.ok(
        html.includes('href="/builder"'),
        "Signed-in header must continue to provide Try the builder"
      );

      // Must not display signed-out exclusive actions
      assert.ok(
        !html.includes("Get Started / Sign Up"),
        "Signed-in header must not display 'Get Started / Sign Up'"
      );
    });
  });

  describe("Requirement 3: Clerk Middleware Executes on Relevant Routes and Server Actions", () => {
    it("delegates to Clerk middleware for all matched routes and Server Actions when credentials are configured", () => {
      const credentials = {
        clerkPublishableKey: "pk_test_valid_live_acceptance",
        clerkSecretKey: "sk_test_valid_live_acceptance",
        nodeEnv: "production",
      };

      const testPaths = [
        { path: "/", method: "GET", description: "Homepage (public)" },
        { path: "/builder", method: "GET", description: "Builder preview (public page)" },
        { path: "/builder", method: "POST", description: "Builder Server Action execution (createProject)" },
        { path: "/product", method: "GET", description: "Product page (public)" },
        { path: "/dashboard", method: "GET", description: "Dashboard (protected)" },
        { path: "/projects/proj-123", method: "GET", description: "Project workspace (protected)" },
        { path: "/api/projects/proj-123/export", method: "GET", description: "Project export API (protected API)" },
      ];

      for (const t of testPaths) {
        const req = new NextRequest(`http://localhost:3000${t.path}`, {
          method: t.method,
          headers: t.method === "POST" ? { "next-action": "action_createProject" } : {},
        });

        const result = evaluateAuthRouting(req, credentials);
        assert.equal(
          result.action,
          "delegate_to_clerk",
          `Route ${t.method} ${t.path} (${t.description}) must delegate to Clerk middleware when credentials are configured`
        );
      }
    });

    it("proxy matcher configuration covers pages, API routes, and Server Actions", () => {
      assert.ok(Array.isArray(proxyConfig.matcher), "Proxy must export an array of matchers");
      const matcherStrings = proxyConfig.matcher.map(String);

      // Verify API routes are matched
      assert.ok(
        matcherStrings.some((m) => m.includes("api") || m.includes("trpc")),
        "Proxy matcher must explicitly include API and TRPC routes"
      );

      // Verify static assets are excluded so Next internals and images do not invoke proxy unnecessarily
      assert.ok(
        matcherStrings.some((m) => m.includes("_next")),
        "Proxy matcher must filter out _next internal static assets"
      );
    });
  });

  describe("Requirement 4: Unauthenticated Project Creation Cannot Proceed", () => {
    it("rejects project creation when no authenticated user session exists", async () => {
      delete process.env.ALLOW_INSECURE_DEV_AUTH;
      (process.env as any).NODE_ENV = "production";

      let transactionCalled = false;
      prisma.$transaction = (async () => {
        transactionCalled = true;
        throw new Error("Transaction should never be called for unauthenticated request");
      }) as any;

      const result = await createProject("I want to build an automated delivery tracker");

      assert.ok("error" in result, "Result must contain error property");
      assert.equal(result.error, "Unauthorized");
      assert.equal(transactionCalled, false, "Database transaction must not be initiated for unauthenticated request");
    });
  });

  describe("Requirement 5: Successful Authentication Resumes the Builder Flow", () => {
    it("retains idempotency identifier and creates project once authentication is established", async () => {
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";

      const testUser = {
        id: "usr_auth_resumed_123",
        clerkId: "clerk_resumed_123",
        email: "authenticated@codemytra.com",
        name: "Authenticated Builder",
      };

      prisma.user.upsert = (async () => testUser) as any;
      prisma.user.findUnique = (async () => testUser) as any;
      prisma.project.findUnique = (async () => null) as any;
      prisma.$queryRawUnsafe = (async () => [{ id: "evt_resumed_1", status: "PROCESSING", attempts: 1 }]) as any;

      const submissionId = "brief_resumed_flow_uuid_789";
      const fullPrompt = "Goal: Build a coffee subscription web app\nVisual Style: Warm & friendly";

      // Mock transaction for project creation
      let createdProject: any = null;
      let createdRun: any = null;
      let createdEvent: any = null;

      prisma.$transaction = (async (callback: any) => {
        const tx = {
          project: {
            create: async ({ data }: any) => {
              createdProject = {
                id: "proj_resumed_success_1",
                name: "coffee-shop",
                userId: data.userId,
                idempotencyKey: data.idempotencyKey,
                currentRevisionId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              return createdProject;
            },
          },
          generationRun: {
            create: async ({ data }: any) => {
              createdRun = {
                id: "run_resumed_1",
                projectId: data.projectId,
                userId: data.userId,
                prompt: data.prompt,
                status: GenerationRunStatus.QUEUED,
              };
              return createdRun;
            },
          },
          outboxEvent: {
            create: async ({ data }: any) => {
              createdEvent = {
                id: "evt_resumed_1",
                eventName: data.eventName,
                payload: data.payload,
              };
              return createdEvent;
            },
          },
        };
        return callback(tx);
      }) as any;

      // 1. Initial attempt fails if unauthenticated
      delete process.env.ALLOW_INSECURE_DEV_AUTH;
      (process.env as any).NODE_ENV = "production";
      const unauthResult = await createProject(fullPrompt, submissionId);
      assert.equal((unauthResult as any).error, "Unauthorized");

      // 2. User authenticates and resumes with the preserved brief & idempotency key
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";
      const authResult = await createProject(fullPrompt, submissionId);

      assert.ok("id" in authResult, "Successful project creation must return project id");
      assert.equal((authResult as any).id, "proj_resumed_success_1");
      assert.equal((authResult as any).userId, testUser.id);
      assert.equal((authResult as any).idempotencyKey, submissionId);
      assert.equal(createdRun.prompt, fullPrompt);

      // 3. Duplicate resume replay with same idempotency key returns existing project without duplicate creation
      prisma.project.findUnique = (async ({ where }: any) => {
        if (where.userId_idempotencyKey) {
          return {
            ...createdProject,
            generationRuns: [createdRun],
            messages: [{ content: fullPrompt, role: MessageRole.USER }],
          };
        }
        return null;
      }) as any;

      const replayResult = await createProject(fullPrompt, submissionId);
      assert.ok("id" in replayResult);
      assert.equal((replayResult as any).id, "proj_resumed_success_1");
    });
  });

  describe("Requirement 6: Users Cannot Access Other Users' Projects", () => {
    it("strictly isolates project access, revision history, and ZIP export by user ID", async () => {
      const userA = { id: "usr_alice_456", email: "alice@test.com" };
      const userB = { id: "usr_bob_789", email: "bob@test.com" };

      // Alice owns project A
      const projectA = {
        id: "proj_alice_secret_app",
        name: "alice-project",
        userId: userA.id,
        currentRevisionId: "rev_alice_1",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock database lookup
      prisma.project.findUnique = (async ({ where }: any) => {
        // Enforce user-scoped query: matches ONLY if both id AND userId match
        if (where.id === projectA.id && where.userId === userA.id) {
          return projectA;
        }
        return null;
      }) as any;

      // 1. Bob attempts to fetch Alice's project via getProjectById
      // Mock Bob as the current active user
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";
      (process.env as any).NODE_ENV = "test";
      prisma.user.upsert = (async () => userB) as any;
      prisma.user.findUnique = (async () => userB) as any;

      const bobProjectLookup = await getProjectById(projectA.id);
      assert.ok("error" in bobProjectLookup);
      assert.equal(bobProjectLookup.error, "Project not found", "Bob must not be able to retrieve Alice's project");

      // 2. Bob attempts to fetch Alice's revisions via getProjectRevisions
      await assert.rejects(
        async () => {
          await getProjectRevisions(projectA.id);
        },
        /Project not found or unauthorized/,
        "Bob must not be able to retrieve Alice's project revisions"
      );

      // 3. Bob attempts to export Alice's project via generateProjectZip
      await assert.rejects(
        async () => {
          await generateProjectZip({
            projectId: projectA.id,
            userId: userB.id,
          });
        },
        /Project not found or unauthorized/,
        "Bob must not be able to export Alice's project ZIP"
      );

      // 4. Alice can access her own project successfully
      prisma.user.upsert = (async () => userA) as any;
      prisma.user.findUnique = (async () => userA) as any;

      const aliceProjectLookup = await getProjectById(projectA.id);
      assert.ok("id" in aliceProjectLookup);
      assert.equal((aliceProjectLookup as any).id, projectA.id);
    });
  });

  describe("Requirement 7: Sign-Out Revokes Access to Protected Pages", () => {
    it("redirects unauthenticated/signed-out requests on protected routes to sign-in with redirect URL preserved", () => {
      const signedOutEnv = {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "production",
      };

      const protectedRoutes = [
        "/dashboard",
        "/projects/proj-12345",
        "/projects/proj-12345/revisions",
      ];

      for (const route of protectedRoutes) {
        const req = new NextRequest(`http://localhost:3000${route}`);
        const result = evaluateAuthRouting(req, signedOutEnv);

        assert.equal(result.action, "fail_closed", `Signed-out request to ${route} must fail closed`);
        assert.equal(result.response?.status, 307, "Must redirect unauthenticated request");

        const location = result.response?.headers.get("location");
        assert.ok(location?.includes("/sign-in"), `Redirect location must target /sign-in, got ${location}`);
        assert.ok(
          location?.includes(`redirect_url=${encodeURIComponent(route)}`),
          `Redirect URL must preserve target route ${route}`
        );
      }

      // API requests must return 401 Unauthorized
      const apiReq = new NextRequest("http://localhost:3000/api/projects/proj-12345/export");
      const apiResult = evaluateAuthRouting(apiReq, signedOutEnv);
      assert.equal(apiResult.action, "fail_closed");
      assert.equal(apiResult.response?.status, 401);
    });
  });

  describe("Requirement 8: No Insecure Development-Auth Fallback in Production", () => {
    it("strictly blocks dev auth fallback in production even if ALLOW_INSECURE_DEV_AUTH is true", async () => {
      (process.env as any).NODE_ENV = "production";
      process.env.ALLOW_INSECURE_DEV_AUTH = "true";

      // 1. evaluateAuthRouting must fail closed in production
      const req = new NextRequest("http://localhost:3000/dashboard");
      const result = evaluateAuthRouting(req, {
        clerkPublishableKey: "",
        clerkSecretKey: "",
        nodeEnv: "production",
        allowInsecureDevAuth: "true",
      });

      assert.equal(result.action, "fail_closed", "Production must NEVER allow insecure dev auth");
      assert.equal(result.response?.status, 307);

      // 2. getCurrentUser must never return dev user in production
      let userUpsertCalled = false;
      prisma.user.upsert = (async () => {
        userUpsertCalled = true;
        return { id: "dev-user", clerkId: "dev-user-local" };
      }) as any;

      const user = await getCurrentUser();
      assert.equal(userUpsertCalled, false, "Dev user upsert must never be triggered in production");
      assert.equal(user, null, "getCurrentUser must return null in production when Clerk is unavailable");
    });
  });
});
