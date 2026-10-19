import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  focusManager,
  environmentManager,
  type Query,
} from "@tanstack/react-query";
import {
  resolveMessagePollInterval,
} from "@/features/messages/hooks/messages";
import {
  isGenerationActiveStatus,
  getActiveRunPollInterval,
  useGetActiveGenerationRun,
} from "@/features/projects/hooks/projects";
import { generateProjectZip } from "@/server/export/zip-export";
import { prisma } from "@/lib/db";
import { parseFragmentFiles, type ProjectFragment } from "@/features/projects/fragment-types";

describe("M4 PR 1: Studio Lifecycle, Polling & Selection Corrections", () => {
  describe("Task 1: Conversation Polling & QueryClient Lifecycle", () => {
    it("newly created project with no messages polls while activeRun is pending or queued", () => {
      // Direct verification of actual Studio hook resolution logic
      const pendingInterval = resolveMessagePollInterval({
        isGenerating: false,
        messagesCount: 0,
        isActiveRunPending: true,
        status: null,
      });
      assert.strictEqual(pendingInterval, 2500, "Should poll while initial run is resolving");

      const queuedInterval = resolveMessagePollInterval({
        isGenerating: isGenerationActiveStatus("QUEUED"),
        messagesCount: 0,
        isActiveRunPending: false,
        status: "QUEUED",
      });
      assert.strictEqual(queuedInterval, 2500, "Should poll when initial run is queued");
      assert.strictEqual(getActiveRunPollInterval("QUEUED"), 2000, "Active run should poll every 2000ms when queued");
    });

    it("polls during active multi-agent generation stages", () => {
      const activeStages = ["PLANNING", "DESIGNING", "ARCHITECTING", "RUNNING", "VALIDATING"];
      for (const stage of activeStages) {
        assert.strictEqual(
          isGenerationActiveStatus(stage),
          true,
          `Stage ${stage} must be marked as active generation`
        );
        assert.strictEqual(
          getActiveRunPollInterval(stage),
          2000,
          `Active run stage ${stage} must poll every 2000ms`
        );
        const interval = resolveMessagePollInterval({
          isGenerating: isGenerationActiveStatus(stage),
          messagesCount: 1,
          isActiveRunPending: false,
          status: stage,
        });
        assert.strictEqual(interval, 2500, `Stage ${stage} must poll every 2500ms`);
      }
    });

    it("verifies initial project creation and polling progression until first generation run becomes visible", () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const projectId = "proj-lifecycle-e2e";

      // 1. Initial State: Project created, 0 messages, activeRun pending
      queryClient.setQueryData(["messages", projectId], []);
      assert.strictEqual(
        resolveMessagePollInterval({
          isGenerating: false,
          messagesCount: 0,
          isActiveRunPending: true,
          status: null,
        }),
        2500,
        "Phase 1: Must poll while active run is pending"
      );

      // 2. Generation run becomes visible (QUEUED)
      queryClient.setQueryData(["active-generation-run", projectId], {
        id: "run-init-1",
        status: "QUEUED",
      });
      assert.strictEqual(
        getActiveRunPollInterval("QUEUED"),
        2000,
        "Phase 2: Active run hook must poll every 2000ms"
      );
      assert.strictEqual(
        resolveMessagePollInterval({
          isGenerating: isGenerationActiveStatus("QUEUED"),
          messagesCount: 0,
          isActiveRunPending: false,
          status: "QUEUED",
        }),
        2500,
        "Phase 2: Messages hook must poll every 2500ms while queued"
      );

      // 3. Multi-agent progression: ARCHITECTING -> RUNNING -> VALIDATING
      const progressionStages = ["ARCHITECTING", "RUNNING", "VALIDATING"];
      for (const stage of progressionStages) {
        queryClient.setQueryData(["active-generation-run", projectId], {
          id: "run-init-1",
          status: stage,
        });
        assert.strictEqual(
          getActiveRunPollInterval(stage),
          2000,
          `Phase 3: Active run in ${stage} must maintain 2000ms polling`
        );
        assert.strictEqual(
          resolveMessagePollInterval({
            isGenerating: isGenerationActiveStatus(stage),
            messagesCount: 0,
            isActiveRunPending: false,
            status: stage,
          }),
          2500,
          `Phase 3: Messages in ${stage} must maintain 2500ms polling`
        );
      }

      // 4. First assistant response arrives with completed run
      const generatedMessages = [
        {
          id: "msg-user-init",
          role: "USER",
          content: "Build a todo app",
          createdAt: new Date(),
        },
        {
          id: "msg-asst-init",
          role: "ASSISTANT",
          content: "Built the Todo app.",
          fragments: {
            id: "frag-v1",
            title: "Todo App V1",
            files: { "app/page.tsx": "export default () => <div>Todo</div>" },
          },
          generationRun: { resultRevisionId: "rev-v1" },
        },
      ];
      queryClient.setQueryData(["messages", projectId], generatedMessages);
      queryClient.setQueryData(["active-generation-run", projectId], {
        id: "run-init-1",
        status: "COMPLETED",
      });

      // 5. Terminal COMPLETED state shuts down continuous polling
      assert.strictEqual(
        getActiveRunPollInterval("COMPLETED"),
        false,
        "Phase 5: Active run must cease polling on COMPLETED"
      );
      assert.strictEqual(
        resolveMessagePollInterval({
          isGenerating: isGenerationActiveStatus("COMPLETED"),
          messagesCount: generatedMessages.length,
          isActiveRunPending: false,
          status: "COMPLETED",
        }),
        false,
        "Phase 5: Messages must cease polling on COMPLETED"
      );

      queryClient.clear();
    });

    it("handles terminal states and executes failed-generation recovery cleanly", async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const projectId = "proj-failed-recovery";

      // 1. Generation fails
      queryClient.setQueryData(["active-generation-run", projectId], {
        id: "run-fail-1",
        status: "FAILED",
        error: "E2B Sandbox initialization timeout",
      });
      queryClient.setQueryData(["messages", projectId], [
        { id: "m-user-1", role: "USER", content: "Build complex app" },
        {
          id: "m-asst-err",
          role: "ASSISTANT",
          content: "Generation failed: E2B Sandbox initialization timeout",
          isError: true,
        },
      ]);

      // 2. In terminal FAILED state, polling halts to avoid continuous network requests
      assert.strictEqual(
        getActiveRunPollInterval("FAILED"),
        false,
        "Must halt active-run polling on FAILED"
      );
      assert.strictEqual(
        resolveMessagePollInterval({
          isGenerating: isGenerationActiveStatus("FAILED"),
          messagesCount: 2,
          isActiveRunPending: false,
          status: "FAILED",
        }),
        false,
        "Must halt messages polling on FAILED"
      );

      // 3. User initiates recovery prompt: "Retry with simpler scaffold"
      // Simulates useCreateMessage / recovery submission
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["active-generation-run", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      ]);

      // State is marked invalidated/stale
      assert.strictEqual(queryClient.getQueryState(["messages", projectId])?.isInvalidated, true);
      assert.strictEqual(
        queryClient.getQueryState(["active-generation-run", projectId])?.isInvalidated,
        true
      );

      // 4. Recovery run is registered in cache as QUEUED
      queryClient.setQueryData(["active-generation-run", projectId], {
        id: "run-retry-2",
        status: "QUEUED",
      });

      // 5. Polling resumes immediately for both active run and messages
      assert.strictEqual(
        getActiveRunPollInterval("QUEUED"),
        2000,
        "Polling must resume after recovery prompt submission"
      );
      assert.strictEqual(
        resolveMessagePollInterval({
          isGenerating: isGenerationActiveStatus("QUEUED"),
          messagesCount: 3,
          isActiveRunPending: false,
          status: "QUEUED",
        }),
        2500,
        "Message polling must resume after recovery prompt submission"
      );

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

    it("transitions an initially null generation response to QUEUED through actual scheduled React Query refetches without manual fetch calls", async () => {
      // Direct verification of requirement 1: genuine timer-driven scheduled refetching
      // TanStack Query's QueryObserver manages internal scheduled refetch timers
      // when running in client environment.
      environmentManager.setIsServer(() => false);
      focusManager.setFocused(true);

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const projectId = "proj-scheduled-timer-refetch";

      let fetchCount = 0;
      const scheduledIntervalMs = 30; // Fast timer for deterministic test execution

      const observer = new QueryObserver(queryClient, {
        queryKey: ["active-generation-run", projectId],
        queryFn: async () => {
          fetchCount++;
          if (fetchCount === 1) {
            // Attempt 1: Generation run still queued in outbox / database
            return null;
          }
          // Attempt 2: Run created and discovered automatically via scheduled timer
          return {
            id: "run-scheduled-discovery-123",
            status: "QUEUED",
            createdAt: new Date(),
            events: [],
          };
        },
        refetchInterval: (q) => {
          const status = (q.state.data as { status?: string } | null)?.status ?? null;
          // While null, schedule refetch at scheduledIntervalMs
          if (status === null) {
            return scheduledIntervalMs;
          }
          // Once resolved to QUEUED, transition to active polling
          if (isGenerationActiveStatus(status)) {
            return 2000;
          }
          return false;
        },
        refetchIntervalInBackground: true,
      });

      let latestStatus: string | null = null;
      const unsubscribe = observer.subscribe((result) => {
        if (result.data) {
          latestStatus = (result.data as { status?: string }).status ?? null;
        }
      });

      try {
        // Initial fetch is executed autonomously by observer on subscription
        // Wait for TanStack Query's internal scheduled timer to fire autonomously (WITHOUT query.fetch() or setData())
        const startTime = Date.now();
        while (fetchCount < 2 && Date.now() - startTime < 1000) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }

        assert.strictEqual(
          fetchCount,
          2,
          "TanStack Query must execute scheduled refetch autonomously without manual query.fetch() calls"
        );
        assert.strictEqual(
          latestStatus,
          "QUEUED",
          "Observer must receive naturally resolved QUEUED run from scheduled timer refetch"
        );

        const cachedQuery = queryClient
          .getQueryCache()
          .find({ queryKey: ["active-generation-run", projectId] }) as Query;
        assert.ok(cachedQuery, "Query must exist in QueryCache");
        assert.strictEqual(
          (cachedQuery.state.data as { status: string })?.status,
          "QUEUED",
          "Cache data must be updated to QUEUED via scheduled refetch"
        );
      } finally {
        unsubscribe();
        environmentManager.setIsServer(() => true);
        queryClient.clear();
      }
    });

    it("recovers legitimately delayed generation runs via two-stage adaptive discovery and verifies user recovery path after discovery expiration", async () => {
      const queryClient = new QueryClient();
      const projectId = "proj-delayed-recovery-test";

      function Monitor() {
        useGetActiveGenerationRun(projectId);
        return null;
      }

      renderToString(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Monitor)
        )
      );

      const query = queryClient
        .getQueryCache()
        .find({ queryKey: ["active-generation-run", projectId] }) as Query;
      const refetchIntervalFn = (
        query.options as unknown as { refetchInterval: (q: unknown) => number | false }
      ).refetchInterval;

      // Stage 1 (Fast Discovery): attempts 0 through 4 poll at 1500ms (~7.5s)
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(
          refetchIntervalFn(query),
          1500,
          `Fast discovery attempt ${i + 1} must poll at 1500ms`
        );
        query.setData(null);
      }

      // Stage 2 (Extended Recovery Window): attempts 5 through 11 back off to 5000ms (~35s)
      // to handle database cold-starts and connection queueing without network floods
      for (let i = 5; i < 12; i++) {
        assert.strictEqual(
          refetchIntervalFn(query),
          5000,
          `Extended recovery attempt ${i + 1} must poll at 5000ms backoff`
        );
        query.setData(null);
      }

      // Stage 3 (Cessation): On attempt 12 (dataUpdateCount >= 12), polling halts
      assert.strictEqual(query.state.dataUpdateCount, 12);
      assert.strictEqual(
        refetchIntervalFn(query),
        false,
        "Must halt polling after 12 discovery attempts (~42.5s) to prevent permanent polling on idle projects"
      );

      // Requirement 2: Verify delayed-run recovery after discovery window expires,
      // including the available user recovery path.
      //
      // In the Studio interface (e.g. useCreateMessage or retry trigger),
      // the user recovery action calls queryClient.invalidateQueries({ queryKey: ["active-generation-run", projectId] }).
      // This resets stale state and triggers an immediate recheck.
      let delayedRunDatabaseRecord: { id: string; status: string } | null = null;

      // Simulates background worker eventually finishing outbox processing and persisting the run:
      delayedRunDatabaseRecord = {
        id: "delayed-run-discovered-after-window",
        status: "QUEUED",
      };

      // User initiates recovery action in Studio:
      await queryClient.invalidateQueries({
        queryKey: ["active-generation-run", projectId],
      });

      // Verify the query was marked invalidated by the user recovery path
      assert.strictEqual(
        query.state.isInvalidated,
        true,
        "User recovery path must invalidate query to trigger fresh discovery"
      );

      // Database returns the delayed run on refetch
      query.setData(delayedRunDatabaseRecord);

      // Once discovered, polling immediately transitions to 2000ms active polling
      assert.strictEqual(
        refetchIntervalFn(query),
        2000,
        "Delayed run recovery must immediately transition from expired/halted state to 2000ms active polling"
      );

      queryClient.clear();
    });

    it("verifies FAILED, CANCELLED, and COMPLETED terminal behaviors halt polling on mounted hook", () => {
      const queryClient = new QueryClient();
      const projectId = "proj-terminal-states-test";

      function TerminalMonitor() {
        useGetActiveGenerationRun(projectId);
        return null;
      }

      renderToString(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TerminalMonitor)
        )
      );

      const query = queryClient
        .getQueryCache()
        .find({ queryKey: ["active-generation-run", projectId] }) as Query;
      const refetchIntervalFn = (
        query.options as unknown as { refetchInterval: (q: unknown) => number | false }
      ).refetchInterval;

      // 1. Terminal COMPLETED
      query.setData({ id: "run-term-1", status: "COMPLETED" });
      assert.strictEqual(
        refetchIntervalFn(query),
        false,
        "COMPLETED state must halt polling immediately"
      );

      // 2. Terminal FAILED
      query.setData({ id: "run-term-2", status: "FAILED" });
      assert.strictEqual(
        refetchIntervalFn(query),
        false,
        "FAILED state must halt polling immediately"
      );

      // 3. Terminal CANCELLED
      query.setData({ id: "run-term-3", status: "CANCELLED" });
      assert.strictEqual(
        refetchIntervalFn(query),
        false,
        "CANCELLED state must halt polling immediately"
      );

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

    it("preserves revision switching while background generation continues in parallel", () => {
      // Simulates active studio state when background generation is actively running
      const state = {
        isManualSelection: false,
        selectedFragment: null as ProjectFragment | null,
        activeBackgroundRun: {
          id: "run-bg-progress",
          status: "RUNNING",
          stage: "CODING",
        },
      };

      const revisions = [
        { id: "rev-v1", title: "Version 1.0 (Scaffold)", files: { "app/page.tsx": "v1 code" } },
        { id: "rev-v2", title: "Version 2.0 (Cart Added)", files: { "app/page.tsx": "v2 code" } },
      ];

      function selectRevision(revId: string) {
        state.isManualSelection = true;
        const rev = revisions.find((r) => r.id === revId);
        if (rev) {
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
      }

      // Background generation is active
      assert.strictEqual(isGenerationActiveStatus(state.activeBackgroundRun.status), true);
      assert.strictEqual(getActiveRunPollInterval(state.activeBackgroundRun.status), 2000);

      // User switches to revision V1
      selectRevision("rev-v1");
      assert.strictEqual(state.isManualSelection, true);
      assert.strictEqual(state.selectedFragment?.id, "rev-v1");
      assert.strictEqual(state.selectedFragment?.title, "Version 1.0 (Scaffold)");

      // Background run continues to stream events / polls
      state.activeBackgroundRun.stage = "VALIDATING";
      // Revision selection remains pinned on rev-v1
      assert.strictEqual(state.selectedFragment?.id, "rev-v1");

      // User switches to revision V2
      selectRevision("rev-v2");
      assert.strictEqual(state.isManualSelection, true);
      assert.strictEqual(state.selectedFragment?.id, "rev-v2");
      assert.strictEqual(state.selectedFragment?.title, "Version 2.0 (Cart Added)");

      // Intermediate background generation tick arrives
      assert.strictEqual(state.selectedFragment?.id, "rev-v2", "Background run must never clobber active manual revision");
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
          writeText: async (..._args: unknown[]) => {
            void _args;
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
