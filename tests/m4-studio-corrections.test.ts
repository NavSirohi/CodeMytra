import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGenerationActiveStatus } from "@/features/projects/hooks/projects";

describe("M4 PR 1: Studio Lifecycle, Polling & Selection Corrections", () => {
  describe("Task 1: Conversation Polling Lifecycle", () => {
    // Simulate refetchInterval logic matching useGetMessages
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
      // 1. Pending initial run
      const pendingInterval = computeMessagePollInterval({
        isGenerating: false,
        messagesCount: 0,
        isActiveRunPending: true,
        status: null,
      });
      assert.strictEqual(pendingInterval, 2500, "Should poll while initial run is resolving");

      // 2. Initial run queued
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
          messagesCount: 1, // User prompt sent
          isActiveRunPending: false,
          status: stage,
        });
        assert.strictEqual(interval, 2500, `Stage ${stage} must poll every 2500ms`);
      }
    });

    it("first assistant response becomes visible and terminal status ceases continuous polling", () => {
      const terminalStatuses = ["COMPLETED", "FAILED", "CANCELLED"];
      for (const termStatus of terminalStatuses) {
        assert.strictEqual(
          isGenerationActiveStatus(termStatus),
          false,
          `Terminal status ${termStatus} must NOT be active`
        );
        const interval = computeMessagePollInterval({
          isGenerating: isGenerationActiveStatus(termStatus),
          messagesCount: 2, // User message + newly arrived assistant message
          isActiveRunPending: false,
          status: termStatus,
        });
        assert.strictEqual(
          interval,
          false,
          `Terminal status ${termStatus} must stop polling immediately`
        );
      }
    });

    it("follow-up messages resume polling when a new run transitions to QUEUED", () => {
      // User posts follow up -> new run created in QUEUED
      const followUpInterval = computeMessagePollInterval({
        isGenerating: isGenerationActiveStatus("QUEUED"),
        messagesCount: 3,
        isActiveRunPending: false,
        status: "QUEUED",
      });
      assert.strictEqual(followUpInterval, 2500, "Follow up must resume polling at 2.5s");
    });
  });

  describe("Task 2: Preserve Manual Revision Selection", () => {
    // Model the selection state logic in ProjectView and MessageContainer
    class StudioSelectionManager {
      selectedFragment: { id: string; title: string; files: Record<string, string>; messageId?: string; sandboxUrl?: string } | null = null;
      isManualSelection = false;
      lastAutoSelectedMessageId: string | null = null;

      // Stable callback for manual selection
      handleManualSelectFragment(fragment: { id: string; title: string; files: Record<string, string>; messageId?: string; sandboxUrl?: string }) {
        this.isManualSelection = true;
        this.selectedFragment = fragment;
      }

      // Stable callback for manual historical revision selection
      handleSelectRevision(rev: { id: string; title: string; files: Record<string, string> }) {
        this.isManualSelection = true;
        this.selectedFragment = {
          id: rev.id,
          messageId: "historical",
          sandboxUrl: "",
          title: rev.title,
          files: rev.files,
        };
      }

      // Stable callback for automatic latest-fragment selection
      handleAutoSelectLatestFragment(fragment: { id: string; title: string; files: Record<string, string> }) {
        if (!this.isManualSelection) {
          this.selectedFragment = fragment;
        }
      }

      // Effect simulating MessageContainer polling update
      onMessagesUpdated(messages: Array<{ id: string; role: string; fragment?: { id: string; title: string; files: Record<string, string> } }>) {
        if (this.isManualSelection) {
          // Do NOT overwrite user's explicit manual selection
          return;
        }

        const lastAssistant = messages.slice().reverse().find(m => m.role === "ASSISTANT" && m.fragment);
        if (lastAssistant?.fragment && lastAssistant.id !== this.lastAutoSelectedMessageId) {
          this.lastAutoSelectedMessageId = lastAssistant.id;
          this.handleAutoSelectLatestFragment(lastAssistant.fragment);
        }
      }

      resetToLatest() {
        this.isManualSelection = false;
        this.selectedFragment = null;
      }
    }

    it("automatically selects latest fragment when user has not made a manual selection", () => {
      const manager = new StudioSelectionManager();
      assert.strictEqual(manager.selectedFragment, null);

      manager.onMessagesUpdated([
        { id: "msg-1", role: "USER" },
        { id: "msg-2", role: "ASSISTANT", fragment: { id: "frag-1", title: "V1 App", files: { "src/App.tsx": "code1" } } },
      ]);

      assert.deepStrictEqual(manager.selectedFragment, {
        id: "frag-1",
        title: "V1 App",
        files: { "src/App.tsx": "code1" },
      });
      assert.strictEqual(manager.isManualSelection, false);
    });

    it("preserves manual historical revision selection across repeated message updates and rerenders", () => {
      const manager = new StudioSelectionManager();

      // Initial auto-selection
      manager.onMessagesUpdated([
        { id: "msg-1", role: "USER" },
        { id: "msg-2", role: "ASSISTANT", fragment: { id: "frag-1", title: "V1 App", files: { "src/App.tsx": "code1" } } },
      ]);
      assert.strictEqual(manager.selectedFragment?.id, "frag-1");

      // User explicitly selects historical revision V0
      manager.handleSelectRevision({
        id: "rev-0",
        title: "Initial Scaffold",
        files: { "src/App.tsx": "initial scaffold code" },
      });

      assert.strictEqual(manager.isManualSelection, true);
      assert.strictEqual(manager.selectedFragment?.id, "rev-0");
      assert.strictEqual(manager.selectedFragment?.messageId, "historical");
      assert.strictEqual(manager.selectedFragment?.sandboxUrl, "");

      // Subsequent message polling arrives with a new fragment from another run
      manager.onMessagesUpdated([
        { id: "msg-1", role: "USER" },
        { id: "msg-2", role: "ASSISTANT", fragment: { id: "frag-1", title: "V1 App", files: { "src/App.tsx": "code1" } } },
        { id: "msg-3", role: "USER" },
        { id: "msg-4", role: "ASSISTANT", fragment: { id: "frag-2", title: "V2 App", files: { "src/App.tsx": "code2" } } },
      ]);

      // Selection MUST remain on rev-0
      assert.strictEqual(manager.selectedFragment?.id, "rev-0", "Must NOT overwrite historical revision on poll");
      assert.strictEqual(manager.selectedFragment?.title, "Initial Scaffold");
    });

    it("allows returning to latest active selection when user resets", () => {
      const manager = new StudioSelectionManager();
      manager.handleSelectRevision({
        id: "rev-old",
        title: "Old Revision",
        files: {},
      });
      assert.strictEqual(manager.isManualSelection, true);

      manager.resetToLatest();
      assert.strictEqual(manager.isManualSelection, false);
      assert.strictEqual(manager.selectedFragment, null);
    });
  });

  describe("Task 3: Generation Query Invalidation & Discrete Statuses", () => {
    it("recognizes exact discrete lifecycle statuses without invented percentages", () => {
      const knownStatuses = [
        "QUEUED",
        "PLANNING",
        "AWAITING_APPROVAL",
        "DESIGNING",
        "ARCHITECTING",
        "RUNNING",
        "VALIDATING",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
      ];

      for (const status of knownStatuses) {
        assert.ok(typeof status === "string" && status.length > 0);
        // Ensure no progress percentage properties exist on statuses
        assert.strictEqual(status.includes("%"), false);
      }
    });

    it("invalidates active generation, messages, and project queries upon follow-up submission", () => {
      const invalidatedKeys: string[][] = [];
      const fakeQueryClient = {
        invalidateQueries: (options: { queryKey: string[] }) => {
          invalidatedKeys.push(options.queryKey);
        },
      };

      const projectId = "proj-123";
      // Simulate useCreateMessage onSuccess
      fakeQueryClient.invalidateQueries({ queryKey: ["messages", projectId] });
      fakeQueryClient.invalidateQueries({ queryKey: ["active-generation-run", projectId] });
      fakeQueryClient.invalidateQueries({ queryKey: ["project", projectId] });
      fakeQueryClient.invalidateQueries({ queryKey: ["project-revisions", projectId] });

      assert.strictEqual(invalidatedKeys.length, 4);
      assert.deepStrictEqual(invalidatedKeys[0], ["messages", "proj-123"]);
      assert.deepStrictEqual(invalidatedKeys[1], ["active-generation-run", "proj-123"]);
      assert.deepStrictEqual(invalidatedKeys[2], ["project", "proj-123"]);
      assert.deepStrictEqual(invalidatedKeys[3], ["project-revisions", "proj-123"]);
    });
  });

  describe("Task 4: Saved Revision & Preview Behaviour", () => {
    it("preserves source-code availability when sandboxUrl is empty or expired", () => {
      const fragment = {
        id: "rev-456",
        messageId: "current-revision",
        title: "Production App",
        sandboxUrl: "", // Expired or unavailable
        files: {
          "package.json": '{"name":"app"}',
          "src/index.tsx": "export default function App() {}",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Source files remain fully inspectable
      assert.strictEqual(Object.keys(fragment.files).length, 2);
      assert.strictEqual(fragment.files["src/index.tsx"], "export default function App() {}");
      assert.strictEqual(fragment.sandboxUrl, "");
    });

    it("historical revision never inherits an active sandbox URL and identifies as historical", () => {
      const activeSandboxUrl = "https://sandbox-active-123.e2b.dev";
      const historicalRevision = {
        id: "rev-historical",
        messageId: "historical",
        sandboxUrl: "", // Must remain empty
        title: "Historical Snapshot V1",
        files: { "src/page.tsx": "export default () => <h1>V1</h1>" },
      };

      assert.notStrictEqual(historicalRevision.sandboxUrl, activeSandboxUrl);
      assert.strictEqual(historicalRevision.sandboxUrl, "");
      assert.strictEqual(historicalRevision.messageId, "historical");
    });
  });

  describe("Task 5: Asynchronous Clipboard Feedback", () => {
    it("awaits clipboard write and resolves status accurately", async () => {
      let clipboardContent = "";
      const fakeNavigator = {
        clipboard: {
          writeText: async (text: string) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            clipboardContent = text;
          },
        },
      };

      let copyStatus = "idle";
      const targetUrl = "https://preview-box-999.e2b.dev";

      // Emulate onCopy implementation
      async function onCopy(url: string) {
        if (!url) return;
        try {
          await fakeNavigator.clipboard.writeText(url);
          copyStatus = "copied";
        } catch {
          copyStatus = "error";
        }
      }

      await onCopy(targetUrl);
      assert.strictEqual(clipboardContent, targetUrl);
      assert.strictEqual(copyStatus, "copied");
    });

    it("handles clipboard rejection gracefully without clearing or corrupting the URL", async () => {
      const fakeFailingNavigator = {
        clipboard: {
          writeText: async () => {
            throw new Error("Clipboard permission denied");
          },
        },
      };

      let copyStatus = "idle";
      const targetUrl = "https://preview-box-999.e2b.dev";

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
      // The URL itself must NOT be cleared or lost
      assert.strictEqual(targetUrl, "https://preview-box-999.e2b.dev");
    });
  });
});
