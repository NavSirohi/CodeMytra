"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { Code, EyeIcon, Download, Rocket, History, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageRole } from "@/generated/prisma/enums";
import ProjectHeader from "./project-header";
import MessageContainer from "./message-container";
import FragmentWeb from "./fragment-web";
import { FileExplorer } from "./file-explorer";
import { GenerationStatusBanner } from "./generation-status-banner";
import { AgentTimeline } from "./agent-timeline";
import { RevisionHistory } from "./revision-history";
import { PRDViewer } from "./prd-viewer";
import {
  useGetProjectById,
  useGetActiveGenerationRun,
  isGenerationActiveStatus,
} from "@/features/projects/hooks/projects";
import { useGetMessages } from "@/features/messages/hooks/messages";
import {
  parseFragmentFiles,
  type ProjectFragment,
} from "@/features/projects/fragment-types";

export type { ProjectFragment };

export function ProjectView({ projectId }: { projectId: string }) {
  const [selectedFragment, setSelectedFragment] = useState<ProjectFragment | null>(null);
  const [isManualSelection, setIsManualSelection] = useState<boolean>(false);
  const [tabState, setTabState] = useState<"preview" | "code">("preview");
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");

  const { data: project, isPending, isError, error } = useGetProjectById(projectId);
  const { data: activeRun } = useGetActiveGenerationRun(projectId);
  const isGenerating = isGenerationActiveStatus(activeRun?.status);
  const isFailed = activeRun?.status === "FAILED";
  const { data: messages } = useGetMessages(projectId);

  // Deterministically find latest assistant fragment from active conversation
  const lastAssistantMessage = messages?.findLast(
    (message) => message.role === MessageRole.ASSISTANT && Boolean(message.fragments)
  );

  const latestAssistantFragment: ProjectFragment | null = useMemo(() => {
    if (!lastAssistantMessage?.fragments) return null;
    return {
      ...lastAssistantMessage.fragments,
      files: parseFragmentFiles(lastAssistantMessage.fragments.files),
      selectionType: "assistant-fragment",
      revisionId:
        (lastAssistantMessage as unknown as { generationRun?: { resultRevisionId?: string | null } })
          .generationRun?.resultRevisionId ?? null,
    };
  }, [lastAssistantMessage]);

  // Derive current revision fragment
  const currentRev = project?.currentRevision;
  const currentRevFragment: ProjectFragment | null = useMemo(() => {
    if (!currentRev) return null;
    return {
      id: currentRev.id,
      messageId: "current-revision",
      sandboxUrl: "",
      title: currentRev.title,
      files: (currentRev.files as Record<string, string>) || {},
      createdAt: new Date(currentRev.createdAt),
      updatedAt: new Date(currentRev.createdAt),
      selectionType: "current-revision",
      revisionId: currentRev.id,
    };
  }, [currentRev]);

  // Derive unverified draft fragment (persisted when coding completed, even if QA failed)
  const draftFragment: ProjectFragment | null = useMemo(() => {
    const draft = (activeRun as unknown as { draft?: { id: string; files: unknown; summary?: string | null; createdAt: string; updatedAt: string; validationStatus: string } })?.draft;
    if (!draft || !draft.files) return null;
    const files = parseFragmentFiles(draft.files);
    if (Object.keys(files).length === 0) return null;
    return {
      id: draft.id,
      messageId: "unverified-draft",
      sandboxUrl: "",
      title: draft.summary ? `${draft.summary.slice(0, 40)}... (Draft)` : "Unverified Draft",
      files,
      createdAt: new Date(draft.createdAt),
      updatedAt: new Date(draft.updatedAt),
      selectionType: "draft-artifact",
      revisionId: null,
      draftId: draft.id,
      isDraft: true,
      validationStatus: draft.validationStatus,
    };
  }, [activeRun]);

  // Active fragment: manual selection takes precedence; otherwise latest assistant fragment, current revision, or unverified draft
  const activeFragment: ProjectFragment | null = selectedFragment
    ? selectedFragment
    : (isFailed && draftFragment && !latestAssistantFragment)
    ? draftFragment
    : latestAssistantFragment || currentRevFragment || draftFragment;

  // Stable callback for explicit user selection of a fragment card in the chat
  const handleManualSelectFragment = useCallback((fragment: ProjectFragment) => {
    setIsManualSelection(true);
    setSelectedFragment(fragment);
  }, []);

  // Stable callback for automatic selection of the latest generated fragment
  const handleAutoSelectLatestFragment = useCallback((fragment: ProjectFragment) => {
    setIsManualSelection((prevIsManual) => {
      if (!prevIsManual) {
        setSelectedFragment(fragment);
      }
      return prevIsManual;
    });
  }, []);

  // Stable callback for explicit user selection of a historical revision
  const handleSelectRevision = useCallback((rev: { id: string; title: string; files: Record<string, string> }) => {
    setIsManualSelection(true);
    // Explicit historical revision: Never associate with an unrelated live sandbox URL
    setSelectedFragment({
      id: rev.id,
      messageId: "historical",
      sandboxUrl: "",
      title: rev.title,
      files: rev.files,
      createdAt: new Date(),
      updatedAt: new Date(),
      selectionType: "historical-revision",
      revisionId: rev.id,
    });
    setTabState("code");
    setMobileView("workspace");
  }, []);

  // Switch back to latest intended active revision/fragment deterministically
  const handleResetToLatest = useCallback(() => {
    setIsManualSelection(false);
    setSelectedFragment(latestAssistantFragment || currentRevFragment || draftFragment);
  }, [latestAssistantFragment, currentRevFragment, draftFragment]);

  const handleExport = () => {
    // 0. Explicit draft artifact or failure state with draft
    if (
      activeFragment?.selectionType === "draft-artifact" ||
      activeFragment?.isDraft ||
      (isFailed && draftFragment)
    ) {
      const draftId = activeFragment?.draftId || draftFragment?.draftId || draftFragment?.id;
      const param = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "?draft=true";
      window.open(`/api/projects/${projectId}/export${param}`, "_blank");
      return;
    }

    if (!activeFragment) {
      window.open(`/api/projects/${projectId}/export`, "_blank");
      return;
    }

    // 1. Assistant-generated fragment
    if (activeFragment.selectionType === "assistant-fragment") {
      if (!activeFragment.revisionId) {
        toast.error(
          "This preview fragment does not have a corresponding persisted revision to export. Please export a saved revision from Revision History."
        );
        return;
      }
      window.open(
        `/api/projects/${projectId}/export?revisionId=${encodeURIComponent(activeFragment.revisionId)}`,
        "_blank"
      );
      return;
    }

    // 2. Historical saved revision
    if (activeFragment.selectionType === "historical-revision") {
      const revId = activeFragment.revisionId || activeFragment.id;
      window.open(
        `/api/projects/${projectId}/export?revisionId=${encodeURIComponent(revId)}`,
        "_blank"
      );
      return;
    }

    // 3. Current saved revision
    const revParam = activeFragment.revisionId
      ? `?revisionId=${encodeURIComponent(activeFragment.revisionId)}`
      : project?.currentRevisionId
      ? `?revisionId=${encodeURIComponent(project.currentRevisionId)}`
      : "";
    window.open(`/api/projects/${projectId}/export${revParam}`, "_blank");
  };

  // 1. Loading State
  if (isPending) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-[#17201a] text-[#f7f6f1] p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-[#284938] text-white flex items-center justify-center font-serif text-2xl -rotate-6 shadow-md mb-4 animate-pulse">
          म
        </div>
        <h2 className="text-xl font-serif font-medium tracking-tight mb-2 text-[#eae8df]">
          Opening CodeMytra Studio
        </h2>
        <p className="text-xs text-[#8a9a8e] max-w-sm mb-4">
          Retrieving project workspace, multi-agent specifications, and latest revision...
        </p>
        <div className="w-32 h-1 rounded-full bg-[#28382b] overflow-hidden">
          <div className="w-1/2 h-full bg-[#c75c35] animate-pulse" />
        </div>
      </div>
    );
  }

  // 2. Error / Unauthorized State
  if (isError || !project) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-[#17201a] text-[#f7f6f1] p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-[#c75c35]/20 border border-[#c75c35]/40 text-[#c75c35] flex items-center justify-center font-serif text-2xl mb-4">
          !
        </div>
        <h2 className="text-xl font-serif font-medium tracking-tight mb-2 text-[#eae8df]">
          Project Workspace Unavailable
        </h2>
        <p className="text-xs text-[#8a9a8e] max-w-md mb-6 leading-relaxed">
          {error?.message || "You do not have permission to view this project, or the project does not exist."}
        </p>
        <div className="flex gap-3">
          <Button asChild variant="outline" size="sm" className="border-[#2e3e33] text-[#eae8df] hover:bg-[#202d24]">
            <Link href="/">Back to Home</Link>
          </Button>
          <Button asChild size="sm" className="bg-[#c75c35] hover:bg-[#b04f2c] text-white">
            <Link href="/builder">Create New Project</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#17201a] text-[#f7f6f1] overflow-hidden">
      {/* Generation Status & Agent Multi-Stage Progress */}
      <GenerationStatusBanner projectId={projectId} />
      <AgentTimeline projectId={projectId} />

      {/* Mobile view selector (screens < 768px) */}
      <div className="md:hidden flex items-center justify-between border-b border-[#28382b] bg-[#1c2820] px-3 py-2">
        <div className="flex rounded-lg border border-[#2e3e33] p-0.5 bg-[#17201a]">
          <button
            type="button"
            onClick={() => setMobileView("chat")}
            className={cn(
              "px-3 py-1 text-xs rounded-md font-medium transition-all",
              mobileView === "chat" ? "bg-[#284938] text-white" : "text-[#8a9a8e]"
            )}
          >
            Chat & Prompt
          </button>
          <button
            type="button"
            onClick={() => setMobileView("workspace")}
            className={cn(
              "px-3 py-1 text-xs rounded-md font-medium transition-all",
              mobileView === "workspace" ? "bg-[#284938] text-white" : "text-[#8a9a8e]"
            )}
          >
            Preview & Code
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
            onClick={handleExport}
          >
            <Download className="size-3 mr-1" />
            Export
          </Button>
        </div>
      </div>

      {/* Main Studio Work Area */}
      <div className="flex-1 min-h-0">
        {/* Desktop Split View */}
        <div className="hidden md:block h-full">
          <ResizablePanelGroup orientation="horizontal">
            {/* Left Column: AI Conversation Panel */}
            <ResizablePanel
              defaultSize="35%"
              minSize={320}
              maxSize="50%"
              className="flex min-h-0 flex-col border-r border-[#28382b] bg-[#19231c] shrink-0"
            >
              <ProjectHeader projectId={projectId} />
              <MessageContainer
                projectId={projectId}
                activeFragment={activeFragment}
                onManualSelectFragment={handleManualSelectFragment}
                onAutoSelectLatestFragment={handleAutoSelectLatestFragment}
                isManualSelection={isManualSelection}
              />
            </ResizablePanel>

            <ResizableHandle withHandle className="bg-[#28382b] hover:bg-[#c75c35]/60 transition-colors" />

            {/* Right Column: Studio Canvas (Tabs for Preview & Code) */}
            <ResizablePanel defaultSize="65%" minSize={420} className="min-w-0 bg-[#17201a]">
              <Tabs
                className="flex h-full flex-col"
                defaultValue="preview"
                value={tabState}
                onValueChange={(value) => setTabState(value as "preview" | "code")}
              >
                {/* Canvas Top Bar */}
                <div className="flex w-full items-center gap-x-2 border-b border-[#28382b] bg-[#1c2820]/90 px-3 py-2 backdrop-blur-xs">
                  <TabsList className="h-8 rounded-lg border border-[#2e3e33] bg-[#17201a] p-0.5">
                    <TabsTrigger
                      value="preview"
                      className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs data-[state=active]:bg-[#284938] data-[state=active]:text-white text-[#8a9a8e] transition-all"
                    >
                      <EyeIcon className="size-3.5" />
                      <span>Preview</span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="code"
                      className="flex items-center gap-1.5 rounded-md px-3 py-1 text-xs data-[state=active]:bg-[#284938] data-[state=active]:text-white text-[#8a9a8e] transition-all"
                    >
                      <Code className="size-3.5" />
                      <span>Code Explorer</span>
                    </TabsTrigger>
                  </TabsList>

                  {/* Active Historical Selection Indicator */}
                  {isManualSelection && activeFragment?.messageId === "historical" && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs">
                      <History className="size-3 shrink-0" />
                      <span className="font-mono text-[11px] truncate max-w-[130px]">
                        {activeFragment.title || "Historical"}
                      </span>
                      <button
                        type="button"
                        onClick={handleResetToLatest}
                        className="ml-1 text-[10px] text-blue-300 underline hover:text-white cursor-pointer font-medium"
                      >
                        View Latest
                      </button>
                    </div>
                  )}

                  <div className="ml-auto flex items-center gap-x-2">
                    {/* PRD & Multi-Agent Specifications Viewer */}
                    <PRDViewer projectId={projectId} />

                    {/* Revision History Drawer */}
                    <RevisionHistory
                      projectId={projectId}
                      currentRevisionId={project?.currentRevisionId}
                      onSelectRevision={handleSelectRevision}
                    />

                    {/* Export Project ZIP */}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b] hover:text-white"
                      onClick={handleExport}
                    >
                      <Download className="size-3.5" />
                      <span>Export ZIP</span>
                    </Button>

                    {/* Customer Deploy Button (Intentionally Disabled in MVP) */}
                    <Hint
                      text="Customer application deployment remains excluded in this release. Sandboxes are temporary; export to run locally or self-host."
                      side="bottom"
                      align="end"
                    >
                      <div className="relative group">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled
                          className="h-8 gap-1.5 text-xs border border-[#2e3e33] bg-[#202d24]/60 text-[#8a9a8e] opacity-60 cursor-not-allowed"
                        >
                          <Rocket className="size-3.5" />
                          <span>Deploy</span>
                          <span className="text-[9px] bg-[#17201a] text-[#8a9a8e] px-1.5 py-0.2 rounded border border-[#2e3e33] font-mono">
                            Soon
                          </span>
                        </Button>
                      </div>
                    </Hint>
                  </div>
                </div>

                {/* Tab: Preview Canvas */}
                <TabsContent
                  value="preview"
                  className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden bg-[#17201a]"
                >
                  {activeFragment && !activeFragment.isDraft && activeFragment.sandboxUrl ? (
                    <FragmentWeb
                      data={activeFragment}
                      onViewCode={() => setTabState("code")}
                      projectId={projectId}
                    />
                  ) : (isFailed && draftFragment) || activeFragment?.isDraft ? (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-4">
                      <div className="size-12 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
                        <AlertCircle className="size-6 text-amber-400" />
                      </div>
                      <div className="space-y-1 max-w-md">
                        <p className="text-sm font-medium text-amber-200">
                          Preview Unavailable — Verification Incomplete
                        </p>
                        <p className="text-xs text-[#8a9a8e] leading-relaxed">
                          The generated application did not pass all verification checks. Live preview is unavailable until the issues are resolved.
                        </p>
                        <p className="text-xs text-amber-300/80">
                          All generated source code was preserved as an unverified draft artifact.
                        </p>
                      </div>
                      <div className="flex items-center gap-3 pt-2">
                        <Button
                          onClick={() => setTabState("code")}
                          size="sm"
                          className="bg-[#284938] hover:bg-[#34624b] text-white text-xs gap-1.5"
                        >
                          <Code className="size-3.5" />
                          <span>Inspect Draft Code ({Object.keys(draftFragment?.files || activeFragment?.files || {}).length} files)</span>
                        </Button>
                        <Button
                          onClick={handleExport}
                          variant="outline"
                          size="sm"
                          className="border-amber-700/50 text-amber-200 hover:bg-amber-900/30 text-xs gap-1.5"
                        >
                          <Download className="size-3.5" />
                          <span>Download Draft ZIP</span>
                        </Button>
                      </div>
                    </div>
                  ) : isFailed ? (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
                      <div className="size-12 rounded-xl bg-destructive/15 border border-destructive/30 flex items-center justify-center text-red-400">
                        <AlertCircle className="size-6 text-red-400" />
                      </div>
                      <p className="text-sm font-medium text-red-300">
                        Generation Failed
                      </p>
                      <p className="text-xs max-w-sm text-[#8a9a8e] leading-relaxed">
                        We couldn’t complete this generation. No verified preview is available. Please review the project and try again.
                      </p>
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
                      <div className="size-12 rounded-xl bg-[#284938]/30 border border-[#284938]/60 flex items-center justify-center text-[#81aa80]">
                        {isGenerating ? (
                          <div className="w-5 h-5 border-2 border-[#81aa80] border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <EyeIcon className="size-6 text-[#81aa80]" />
                        )}
                      </div>
                      <p className="text-sm font-medium text-[#eae8df]">
                        {isGenerating
                          ? `Multi-Agent Pipeline Active: ${activeRun?.status || "Planning"}`
                          : "Preview Initializing"}
                      </p>
                      <p className="text-xs max-w-sm text-[#8a9a8e] leading-relaxed">
                        {isGenerating
                          ? "Agents are drafting specifications, generating full-stack source code, and executing sandbox tests. Real-time preview will render here upon validation."
                          : "The AI agent team is preparing code and initializing the execution environment."}
                      </p>
                    </div>
                  )}
                </TabsContent>

                {/* Tab: Code Explorer */}
                <TabsContent
                  value="code"
                  className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden bg-[#17201a]"
                >
                  {activeFragment?.files && Object.keys(activeFragment.files).length > 0 ? (
                    <div className="flex flex-col h-full min-h-0">
                      {activeFragment.isDraft && (
                        <div className="flex items-center justify-between px-3 py-2 bg-amber-950/40 border-b border-amber-800/40 text-amber-300 text-xs shrink-0">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="size-4 text-amber-400 shrink-0" />
                            <span>
                              <strong>Unverified Draft ({activeFragment.validationStatus || "UNVERIFIED"}):</strong> Automated verification failed or timed out, but generated source code is preserved.
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleExport}
                            className="h-6 text-[11px] border-amber-700/50 text-amber-200 hover:bg-amber-900/40 gap-1"
                          >
                            <Download className="size-3" />
                            Download Draft ZIP
                          </Button>
                        </div>
                      )}
                      <div className="flex-1 min-h-0">
                        <FileExplorer files={activeFragment.files} />
                      </div>
                    </div>
                  ) : isFailed ? (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
                      <div className="size-12 rounded-xl bg-destructive/15 border border-destructive/30 flex items-center justify-center text-red-400">
                        <AlertCircle className="size-6 text-red-400" />
                      </div>
                      <p className="text-sm font-medium text-red-300">No Code Available</p>
                      <p className="text-xs max-w-sm text-[#8a9a8e]">
                        The generation run failed before completing verification. Please submit a new message to retry generation.
                      </p>
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
                      <div className="size-12 rounded-xl bg-[#202d24] border border-[#2e3e33] flex items-center justify-center text-[#81aa80]">
                        <Code className="size-6" />
                      </div>
                      <p className="text-sm font-medium text-[#eae8df]">Files Assembling</p>
                      <p className="text-xs max-w-sm text-[#8a9a8e]">
                        Generated source code will appear here as agents complete implementation and QA passes.
                      </p>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        {/* Mobile View: Render either Chat or Workspace */}
        <div className="md:hidden h-full flex flex-col">
          {mobileView === "chat" ? (
            <div className="flex-1 flex flex-col min-h-0 bg-[#19231c]">
              <ProjectHeader projectId={projectId} />
              <MessageContainer
                projectId={projectId}
                activeFragment={activeFragment}
                onManualSelectFragment={handleManualSelectFragment}
                onAutoSelectLatestFragment={handleAutoSelectLatestFragment}
                isManualSelection={isManualSelection}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 bg-[#17201a]">
              <div className="flex items-center justify-between border-b border-[#28382b] bg-[#1c2820] px-3 py-1.5">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={tabState === "preview" ? "default" : "ghost"}
                    onClick={() => setTabState("preview")}
                    className={cn(
                      "h-7 text-xs px-2.5",
                      tabState === "preview" ? "bg-[#284938] text-white" : "text-[#8a9a8e]"
                    )}
                  >
                    Demo
                  </Button>
                  <Button
                    size="sm"
                    variant={tabState === "code" ? "default" : "ghost"}
                    onClick={() => setTabState("code")}
                    className={cn(
                      "h-7 text-xs px-2.5",
                      tabState === "code" ? "bg-[#284938] text-white" : "text-[#8a9a8e]"
                    )}
                  >
                    Code
                  </Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <PRDViewer projectId={projectId} />
                  <RevisionHistory
                    projectId={projectId}
                    currentRevisionId={project?.currentRevisionId}
                    onSelectRevision={handleSelectRevision}
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0">
                {tabState === "preview" ? (
                  activeFragment && !activeFragment.isDraft && activeFragment.sandboxUrl ? (
                    <FragmentWeb
                      data={activeFragment}
                      onViewCode={() => setTabState("code")}
                      projectId={projectId}
                    />
                  ) : (isFailed && draftFragment) || activeFragment?.isDraft ? (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-[#8a9a8e] gap-3">
                      <AlertCircle className="size-6 text-amber-400" />
                      <p className="text-xs font-medium text-amber-200">
                        Preview Unavailable (Draft Preserved)
                      </p>
                      <Button
                        onClick={() => setTabState("code")}
                        size="sm"
                        className="bg-[#284938] hover:bg-[#34624b] text-white text-xs"
                      >
                        Inspect Draft Code
                      </Button>
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-[#8a9a8e] p-6 text-center">
                      Preview Initializing
                    </div>
                  )
                ) : activeFragment?.files && Object.keys(activeFragment.files).length > 0 ? (
                  <div className="flex flex-col h-full min-h-0">
                    {activeFragment.isDraft && (
                      <div className="flex items-center justify-between px-2.5 py-1.5 bg-amber-950/40 border-b border-amber-800/40 text-amber-300 text-[11px] shrink-0">
                        <span>Unverified Draft</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleExport}
                          className="h-5 text-[10px] px-2 border-amber-700/50 text-amber-200"
                        >
                          Draft ZIP
                        </Button>
                      </div>
                    )}
                    <div className="flex-1 min-h-0">
                      <FileExplorer files={activeFragment.files} />
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-[#8a9a8e] p-6 text-center">
                    Files Assembling
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}