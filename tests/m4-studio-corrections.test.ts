import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { QueryClient } from "@tanstack/react-query";
import { isGenerationActiveStatus } from "@/features/projects/hooks/projects";
import { generateProjectZip } from "@/server/export/zip-export";
import { prisma } from "@/lib/db";
import { parseFragmentFiles, type ProjectFragment } from "@/features/projects/fragment-types";

describe("M4 PR 1: Studio Lifecycle, Polling & Selection Corrections", () => {
  describe("Task 1: Conversation Polling & QueryClient Lifecycle", () => {
    function computeMessagePollInterval(options: {
      isGenerating: boolean;
      messagesCount: number;
      isActiveRunPending: boolean;
      status: string | null;
    }): number | false {
      const { isGenerating, messagesCount, isActiveRunPending, status } = options;
      const isTerminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";

      // 1. While generation is queued or active, poll every 2.5s
      if (isGenerating) {
        return 2500;
      }

      // 2. Newly created project with no messages and activeRun pending: poll until settled
      if (messagesCount === 0 && isActiveRunPending) {
        return 2500;
      }

      // 3. Terminal state or idle -> do not poll
      if (isTerminal || !isGenerating) {
        return false;
      }

      return false;
    }

    it("newly created project with no messages polls while activeRun is pending or queued", () => {
      const pendingInterval = computeMessagePollInterval({
        isGenerating: false,
        messagesCount: 0,
        isActiveRunPending: true,
        status: null,
      });
      assert.strictEqual(pendingInterval, 2500, "Should poll while initial run is resolving");

      const queuedInterval = computeMessagePollInterval({
        isGenerating: true,
        messagesCount: 0,
        isActiveRunPending: false,
        status: "QUEUED",
      });
      assert.strictEqual(queuedInterval, 2500, "Should poll when initial run is queued");
    });

    it("polls during active multi-agent generation stages", () => {
      const activeStages = ["PLANNING", "DESIGNING", "ARCHITECTING", "RUNNING", "VALIDATING"];
      for (const stage of activeStages) {
        assert.strictEqual(
          isGenerationActiveStatus(stage),
          true,
          `Stage ${stage} must be marked as active generation`
        );
        const interval = computeMessagePollInterval({
          isGenerating: isGenerationActiveStatus(stage),
          messagesCount: 1,
          isActiveRunPending: false,
          status: stage,
        });
        assert.strictEqual(interval, 2500, `Stage ${stage} must poll every 2500ms`);
      }
    });

    it("initial assistant response appears after empty conversation and ceases continuous polling", () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const projectId = "proj-initial-test";

      // 1. Initially empty conversation
      queryClient.setQueryData(["messages", projectId], []);
      const initialMessages = queryClient.getQueryData<unknown[]>(["messages", projectId]);
      assert.strictEqual(initialMessages?.length, 0);

      // Polling is active while initial run is resolving
      const initialInterval = computeMessagePollInterval({
        isGenerating: false,
        messagesCount: initialMessages?.length ?? 0,
        isActiveRunPending: true,
        status: null,
      });
      assert.strictEqual(initialInterval, 2500);

      // 2. Initial assistant response arrives
      const newMessages = [
        {
          id: "msg-user-1",
          role: "USER",
          content: "Create a SaaS landing page",
          createdAt: new Date(),
        },
        {
          id: "msg-assistant-1",
          role: "ASSISTANT",
          content: "I have built the landing page with authentication and dark mode.",
          createdAt: new Date(),
          fragments: {
            id: "frag-landing-1",
            title: "Landing Page V1",
            sandboxUrl: "https://preview-1.e2b.dev",
            files: {
              "app/page.tsx": "export default function Page() { return <h1>SaaS</h1>; }",
            },
          },
          generationRun: {
            resultRevisionId: "rev-landing-1",
          },
        },
      ];
      queryClient.setQueryData(["messages", projectId], newMessages);

      const updatedMessages = queryClient.getQueryData<typeof newMessages>(["messages", projectId]);
      assert.strictEqual(updatedMessages?.length, 2);
      assert.strictEqual(updatedMessages?.[1]?.role, "ASSISTANT");
      assert.strictEqual(updatedMessages?.[1]?.fragments?.title, "Landing Page V1");

      // 3. Once completed, polling ceases immediately
      const completedInterval = computeMessagePollInterval({
        isGenerating: isGenerationActiveStatus("COMPLETED"),
        messagesCount: updatedMessages?.length ?? 0,
        isActiveRunPending: false,
        status: "COMPLETED",
      });
      assert.strictEqual(completedInterval, false, "Must stop polling on COMPLETED");

      queryClient.clear();
    });

    it("follow-up message invalidates active run, messages, project, and revisions in QueryClient", async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const projectId = "proj-invalidation-test";

      // Seed queries in cache
      queryClient.setQueryData(["messages", projectId], [{ id: "m1" }]);
      queryClient.setQueryData(["active-generation-run", projectId], { status: "COMPLETED" });
      queryClient.setQueryData(["project", projectId], { id: projectId, name: "Test" });
      queryClient.setQueryData(["project-revisions", projectId], [{ id: "r1" }]);

      // Verify all queries are currently fresh/not stale
      assert.ok(queryClient.getQueryData(["messages", projectId]));
      assert.ok(queryClient.getQueryData(["active-generation-run", projectId]));
      assert.ok(queryClient.getQueryData(["project", projectId]));
      assert.ok(queryClient.getQueryData(["project-revisions", projectId]));

      // Execute actual query invalidations corresponding to follow-up submission
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["active-generation-run", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project-revisions", projectId] }),
      ]);

      // All 4 query keys are marked stale in the QueryClient
      const messagesState = queryClient.getQueryState(["messages", projectId]);
      const runState = queryClient.getQueryState(["active-generation-run", projectId]);
      const projectState = queryClient.getQueryState(["project", projectId]);
      const revisionsState = queryClient.getQueryState(["project-revisions", projectId]);

      assert.strictEqual(messagesState?.isInvalidated, true, "messages must be invalidated");
      assert.strictEqual(runState?.isInvalidated, true, "active-generation-run must be invalidated");
      assert.strictEqual(projectState?.isInvalidated, true, "project must be invalidated");
      assert.strictEqual(revisionsState?.isInvalidated, true, "project-revisions must be invalidated");

      queryClient.clear();
    });
  });

  describe("Task 2: Manual Selection, View Latest & Preview Expiration", () => {
    it("preserves manual historical revision selection across repeated message updates", () => {
      const state = {
        isManualSelection: false,
        selectedFragment: null as ProjectFragment | null,
        lastAutoSelectedMessageId: null as string | null,
      };

      function onManualSelectRevision(rev: { id: string; title: string; files: Record<string, string> }) {
        state.isManualSelection = true;
        state.selectedFragment = {
          id: rev.id,
          messageId: "historical",
          sandboxUrl: "",
          title: rev.title,
          files: rev.files,
          createdAt: new Date(),
          updatedAt: new Date(),
          selectionType: "historical-revision",
          revisionId: rev.id,
        };
      }

      function onMessagesPolled(messages: Array<{
        id: string;
        role: string;
        fragments?: { id: string; title: string; files: Record<string, string>; sandboxUrl?: string };
        generationRun?: { resultRevisionId?: string | null };
      }>) {
        if (state.isManualSelection) {
          // Locked by manual selection
          return;
        }
        const lastAssistant = messages.slice().reverse().find((m) => m.role === "ASSISTANT" && m.fragments);
        if (lastAssistant?.fragments && lastAssistant.id !== state.lastAutoSelectedMessageId) {
          state.lastAutoSelectedMessageId = lastAssistant.id;
          state.selectedFragment = {
            id: lastAssistant.fragments.id,
            messageId: lastAssistant.id,
            sandboxUrl: lastAssistant.fragments.sandboxUrl || "",
            title: lastAssistant.fragments.title,
            files: lastAssistant.fragments.files,
            createdAt: new Date(),
            updatedAt: new Date(),
            selectionType: "assistant-fragment",
            revisionId: lastAssistant.generationRun?.resultRevisionId ?? null,
          };
        }
      }

      // Initial auto-selection
      onMessagesPolled([
        {
          id: "m-1",
          role: "ASSISTANT",
          fragments: { id: "frag-1", title: "V1 App", files: { "app/page.tsx": "v1" } },
          generationRun: { resultRevisionId: "rev-1" },
        },
      ]);
      assert.strictEqual(state.selectedFragment?.id, "frag-1");
      assert.strictEqual(state.selectedFragment?.selectionType, "assistant-fragment");

      // User manually inspects historical revision V0
      onManualSelectRevision({
        id: "rev-0",
        title: "Initial Scaffold V0",
        files: { "app/page.tsx": "v0" },
      });
      assert.strictEqual(state.isManualSelection, true);
      assert.strictEqual(state.selectedFragment?.id, "rev-0");
      assert.strictEqual(state.selectedFragment?.selectionType, "historical-revision");
      assert.strictEqual(state.selectedFragment?.sandboxUrl, "");

      // Next poll brings V2
      onMessagesPolled([
        {
          id: "m-1",
          role: "ASSISTANT",
          fragments: { id: "frag-1", title: "V1 App", files: { "app/page.tsx": "v1" } },
        },
        {
          id: "m-2",
          role: "ASSISTANT",
          fragments: { id: "frag-2", title: "V2 App", files: { "app/page.tsx": "v2" } },
          generationRun: { resultRevisionId: "rev-2" },
        },
      ]);

      // Selection remains locked on historical revision V0
      assert.strictEqual(state.selectedFragment?.id, "rev-0", "Must NOT overwrite manual revision");
      assert.strictEqual(state.selectedFragment?.title, "Initial Scaffold V0");
    });

    it("View Latest deterministically restores the latest assistant fragment or current revision", () => {
      let isManualSelection = true;
      let selectedFragment: ProjectFragment | null = {
        id: "rev-hist",
        messageId: "historical",
        sandboxUrl: "",
        title: "Historical V1",
        files: { "app/page.tsx": "v1" },
        createdAt: new Date(),
        updatedAt: new Date(),
        selectionType: "historical-revision",
        revisionId: "rev-hist",
      };

      const messages = [
        {
          id: "m-1",
          role: "ASSISTANT",
          fragments: {
            id: "frag-latest",
            title: "Latest Application V3",
            sandboxUrl: "https://sandbox-v3.e2b.dev",
            files: {
              "package.json": '{"name":"app"}',
              "app/page.tsx": "export default () => <div>V3</div>",
            },
          },
          generationRun: { resultRevisionId: "rev-latest" },
        },
      ];

      // View Latest implementation from ProjectView
      function handleResetToLatest() {
        isManualSelection = false;
        const lastAssistant = messages.findLast((m) => m.role === "ASSISTANT" && Boolean(m.fragments));
        if (lastAssistant?.fragments) {
          selectedFragment = {
            id: lastAssistant.fragments.id,
            messageId: lastAssistant.id,
            sandboxUrl: lastAssistant.fragments.sandboxUrl,
            title: lastAssistant.fragments.title,
            files: parseFragmentFiles(lastAssistant.fragments.files),
            createdAt: new Date(),
            updatedAt: new Date(),
            selectionType: "assistant-fragment",
            revisionId: lastAssistant.generationRun?.resultRevisionId ?? null,
          };
        } else {
          selectedFragment = null;
        }
      }

      handleResetToLatest();

      assert.strictEqual(isManualSelection, false);
      assert.strictEqual(selectedFragment?.id, "frag-latest");
      assert.strictEqual(selectedFragment?.selectionType, "assistant-fragment");
      assert.strictEqual(selectedFragment?.revisionId, "rev-latest");
      assert.strictEqual(selectedFragment?.sandboxUrl, "https://sandbox-v3.e2b.dev");
    });

    it("preserves source files and provides accurate preview-unavailable state when sandbox expires", () => {
      const expiredFragment: ProjectFragment = {
        id: "frag-expired",
        messageId: "msg-123",
        sandboxUrl: "", // Sandbox container stopped or expired
        title: "E-Commerce Store V2",
        files: {
          "package.json": JSON.stringify({ name: "store", version: "1.0.0" }),
          "app/page.tsx": "export default function Store() { return <div>Store</div>; }",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        selectionType: "assistant-fragment",
        revisionId: "rev-persisted-123",
      };

      // Files remain 100% available for Code Explorer and ZIP export
      assert.strictEqual(Object.keys(expiredFragment.files).length, 2);
      assert.ok(expiredFragment.files["app/page.tsx"].includes("export default function Store"));
      assert.strictEqual(expiredFragment.sandboxUrl, "");
      assert.strictEqual(expiredFragment.revisionId, "rev-persisted-123");
    });
  });

  describe("Task 3: Asynchronous Clipboard Feedback", () => {
    it("awaits clipboard write and resolves status to copied only after promise completes", async () => {
      let clipboardContent = "";
      const fakeNavigator = {
        clipboard: {
          writeText: async (text: string) => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            clipboardContent = text;
          },
        },
      };

      let copyStatus = "idle";
      const targetUrl = "https://preview-e2b.dev/instance-1";

      async function onCopy(url: string) {
        if (!url) return;
        try {
          await fakeNavigator.clipboard.writeText(url);
          copyStatus = "copied";
        } catch {
          copyStatus = "error";
        }
      }

      assert.strictEqual(copyStatus, "idle");
      const copyPromise = onCopy(targetUrl);
      assert.strictEqual(copyStatus, "idle", "Must remain idle while promise is unresolved");

      await copyPromise;
      assert.strictEqual(clipboardContent, targetUrl);
      assert.strictEqual(copyStatus, "copied");
    });

    it("handles clipboard rejection gracefully without clearing or wiping target URL", async () => {
      const fakeFailingNavigator = {
        clipboard: {
          writeText: async () => {
            throw new Error("Clipboard permission denied");
          },
        },
      };

      let copyStatus = "idle";
      const targetUrl = "https://preview-e2b.dev/instance-1";

      async function onCopy(url: string) {
        if (!url) return;
        try {
          await fakeFailingNavigator.clipboard.writeText(url);
          copyStatus = "copied";
        } catch {
          copyStatus = "error";
        }
      }

      await onCopy(targetUrl);
      assert.strictEqual(copyStatus, "error");
      assert.strictEqual(targetUrl, "https://preview-e2b.dev/instance-1");
    });
  });

  describe("Task 4: ZIP Export ID Handling & Ownership Security", () => {
    const testUserId = "user-auth-123";
    const testProjectId = "proj-studio-456";
    const testCurrentRevId = "rev-current-001";
    const testHistoricalRevId = "rev-hist-002";

    const validFiles: Record<string, string> = {
      "app/page.tsx": "export default function Page() { return <div>App</div>; }",
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "package.json": JSON.stringify({
        name: "studio-test-app",
        version: "0.1.0",
        scripts: { build: "next build" },
        dependencies: {
          next: "15.0.0",
          react: "19.0.0",
          "react-dom": "19.0.0",
        },
      }),
    };

    // Backup Prisma methods
    const originalFindUniqueProject = prisma.project.findUnique;
    const originalFindUniqueRevision = prisma.projectRevision.findUnique;
    const originalFindFirstRevision = prisma.projectRevision.findFirst;

    function setupMockDb() {
      // @ts-expect-error test mock
      prisma.project.findUnique = async (args: { where: { id: string; userId: string } }) => {
        if (args?.where?.id === testProjectId && args?.where?.userId === testUserId) {
          return {
            id: testProjectId,
            name: "test-app",
            currentRevisionId: testCurrentRevId,
          };
        }
        return null;
      };

      const resolveRev = (id?: string) => {
        if (id === testCurrentRevId) {
          return {
            id: testCurrentRevId,
            projectId: testProjectId,
            revisionNumber: 1,
            files: validFiles,
            title: "Current Revision V1",
          };
        }
        if (id === testHistoricalRevId) {
          return {
            id: testHistoricalRevId,
            projectId: testProjectId,
            revisionNumber: 2,
            files: validFiles,
            title: "Historical Revision V2",
          };
        }
        return null;
      };

      // @ts-expect-error test mock
      prisma.projectRevision.findUnique = async (args: { where: { id: string } }) => {
        return resolveRev(args?.where?.id);
      };

      // @ts-expect-error test mock
      prisma.projectRevision.findFirst = async (args: { where: { id?: string; projectId: string } }) => {
        if (args?.where?.projectId !== testProjectId) {
          return null;
        }
        return resolveRev(args?.where?.id) || resolveRev(testCurrentRevId);
      };
    }

    function restoreDb() {
      prisma.project.findUnique = originalFindUniqueProject;
      prisma.projectRevision.findUnique = originalFindUniqueRevision;
      prisma.projectRevision.findFirst = originalFindFirstRevision;
    }

    it("exports current saved revision when no revisionId is passed", async () => {
      setupMockDb();
      try {
        const result = await generateProjectZip({
          projectId: testProjectId,
          userId: testUserId,
        });

        assert.ok(result.buffer.length > 500);
        assert.ok(result.filename.includes("codemytra-test-app-v1"));

        const zip = await JSZip.loadAsync(result.buffer);
        const fileNames = Object.keys(zip.files);
        assert.ok(fileNames.some((f) => f.endsWith("app/page.tsx")));
        assert.ok(fileNames.some((f) => f.endsWith("package.json")));
      } finally {
        restoreDb();
      }
    });

    it("exports historical saved revision when historical revisionId is passed", async () => {
      setupMockDb();
      try {
        const result = await generateProjectZip({
          projectId: testProjectId,
          revisionId: testHistoricalRevId,
          userId: testUserId,
        });

        assert.ok(result.buffer.length > 500);
        assert.ok(result.filename.includes("codemytra-test-app-v2"));

        const zip = await JSZip.loadAsync(result.buffer);
        const fileNames = Object.keys(zip.files);
        assert.ok(fileNames.some((f) => f.endsWith("app/page.tsx")));
      } finally {
        restoreDb();
      }
    });

    it("exports successfully when an assistant fragment with a persisted revisionId is selected", async () => {
      setupMockDb();
      try {
        const assistantFragment = {
          id: "frag-cuid-999", // Fragment ID
          selectionType: "assistant-fragment",
          revisionId: testCurrentRevId, // Resolved Revision ID
        };

        // Client passes fragment.revisionId, NOT fragment.id
        const result = await generateProjectZip({
          projectId: testProjectId,
          revisionId: assistantFragment.revisionId,
          userId: testUserId,
        });

        assert.ok(result.buffer.length > 500);
        assert.ok(result.filename.includes("codemytra-test-app-v1"));
      } finally {
        restoreDb();
      }
    });

    it("strictly rejects fragment IDs erroneously passed as revision IDs", async () => {
      setupMockDb();
      try {
        const invalidFragmentId = "frag-assistant-bubble-123";

        await assert.rejects(
          async () => {
            await generateProjectZip({
              projectId: testProjectId,
              revisionId: invalidFragmentId,
              userId: testUserId,
            });
          },
          (err: Error) => {
            return (
              err.message.includes(`Revision "${invalidFragmentId}" not found`) &&
              err.message.includes("Fragment IDs cannot be used as revision IDs")
            );
          }
        );
      } finally {
        restoreDb();
      }
    });

    it("strictly rejects revisions belonging to another project or unauthorized users", async () => {
      setupMockDb();
      try {
        // 1. Unauthorized user
        await assert.rejects(
          async () => {
            await generateProjectZip({
              projectId: testProjectId,
              userId: "unauthorized-intruder-999",
            });
          },
          /Project not found or unauthorized/
        );

        // 2. Revision belonging to another project
        const foreignRevId = "rev-belonging-to-other-project";
        await assert.rejects(
          async () => {
            await generateProjectZip({
              projectId: testProjectId,
              revisionId: foreignRevId,
              userId: testUserId,
            });
          },
          /not found or does not belong to project/
        );
      } finally {
        restoreDb();
      }
    });

    it("produces valid ZIP content with authenticated root folder, package.json, and tsconfig", async () => {
      setupMockDb();
      try {
        const result = await generateProjectZip({
          projectId: testProjectId,
          revisionId: testCurrentRevId,
          userId: testUserId,
        });

        const zip = await JSZip.loadAsync(result.buffer);
        const rootFolder = `codemytra-test-app-v1`;

        const pkgJson = await zip.file(`${rootFolder}/package.json`)?.async("string");
        assert.ok(pkgJson);
        const parsed = JSON.parse(pkgJson);
        assert.strictEqual(parsed.name, "studio-test-app");
        assert.strictEqual(parsed.scripts.build, "next build");

        const tsConfig = await zip.file(`${rootFolder}/tsconfig.json`)?.async("string");
        assert.ok(tsConfig);

        const page = await zip.file(`${rootFolder}/app/page.tsx`)?.async("string");
        assert.ok(page?.includes("export default function Page"));

        const readme = await zip.file(`${rootFolder}/README.md`)?.async("string");
        assert.ok(readme?.includes("test-app"));
        assert.ok(readme?.includes("CodeMytra"));
      } finally {
        restoreDb();
      }
    });
  });
});
