"use client";

import { useState } from "react";
import Link from "next/link";
import { Code, EyeIcon, Download, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Fragment } from "@/generated/prisma/client";
import ProjectHeader from "./project-header";
import MessageContainer from "./message-container";
import FragmentWeb from "./fragment-web";
import { FileExplorer } from "./file-explorer";
import { GenerationStatusBanner } from "./generation-status-banner";
import { AgentTimeline } from "./agent-timeline";
import { RevisionHistory } from "./revision-history";
import { PRDViewer } from "./prd-viewer";
import { useGetProjectById } from "@/features/projects/hooks/projects";

export type ProjectFragment = Fragment & {
  files: Record<string, string>;
};

export function ProjectView({ projectId }: { projectId: string }) {
  const [selectedFragment, setSelectedFragment] = useState<ProjectFragment | null>(null);
  const [tabState, setTabState] = useState<"preview" | "code">("preview");
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");

  const { data: project, isPending, isError, error } = useGetProjectById(projectId);

  // Derive active fragment: explicitly selected fragment or fallback to current revision
  const currentRev = project?.currentRevision;
  const activeFragment: ProjectFragment | null = selectedFragment
    ? selectedFragment
    : currentRev
    ? {
        id: currentRev.id,
        messageId: "current-revision",
        sandboxUrl: "",
        title: currentRev.title,
        files: (currentRev.files as Record<string, string>) || {},
        createdAt: new Date(currentRev.createdAt),
        updatedAt: new Date(currentRev.createdAt),
      }
    : null;

  const setActiveFragment = (fragment: ProjectFragment | null) => {
    setSelectedFragment(fragment);
  };

  const handleExport = () => {
    // Downloads project ZIP from the server-authenticated export endpoint
    window.open(`/api/projects/${projectId}/export`, "_blank");
  };

  const handleSelectRevision = (rev: { id: string; title: string; files: Record<string, string> }) => {
    setActiveFragment({
      id: rev.id,
      messageId: "historical",
      sandboxUrl: "",
      title: rev.title,
      files: rev.files,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    setTabState("code");
    setMobileView("workspace");
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
              defaultSize={32}
              minSize={25}
              maxSize={45}
              className="flex min-h-0 flex-col border-r border-[#28382b] bg-[#19231c]"
            >
              <ProjectHeader projectId={projectId} />
              <MessageContainer
                projectId={projectId}
                activeFragment={activeFragment}
                setActiveFragment={setActiveFragment}
              />
            </ResizablePanel>

            <ResizableHandle withHandle className="bg-[#28382b] hover:bg-[#c75c35]/60 transition-colors" />

            {/* Right Column: Studio Canvas (Tabs for Preview & Code) */}
            <ResizablePanel defaultSize={68} minSize={55} className="min-w-0 bg-[#17201a]">
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
                  {activeFragment ? (
                    <FragmentWeb data={activeFragment} />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
                      <div className="size-12 rounded-xl bg-[#202d24] border border-[#2e3e33] flex items-center justify-center text-[#c75c35]">
                        <EyeIcon className="size-6" />
                      </div>
                      <p className="text-sm font-medium text-[#eae8df]">Preview Initializing</p>
                      <p className="text-xs max-w-sm text-[#8a9a8e]">
                        The AI agent team is generating code and initializing the sandbox container. Preview will activate upon validation.
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
                    <FileExplorer files={activeFragment.files} />
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
                setActiveFragment={setActiveFragment}
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
                  activeFragment ? (
                    <FragmentWeb data={activeFragment} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-[#8a9a8e] p-6 text-center">
                      Preview Initializing
                    </div>
                  )
                ) : activeFragment?.files && Object.keys(activeFragment.files).length > 0 ? (
                  <FileExplorer files={activeFragment.files} />
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