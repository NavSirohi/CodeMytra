"use client";

import { useState } from "react";
import Link from "next/link";
import { Code, CrownIcon, EyeIcon, Download, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const [activeFragment, setActiveFragment] = useState<ProjectFragment | null>(
    null
  );
  const [tabState, setTabState] = useState<"preview" | "code">("preview");
  const { data: project } = useGetProjectById(projectId);

  const handleExport = () => {
    // Downloads project ZIP from the server-authenticated export endpoint
    window.open(`/api/projects/${projectId}/export`, "_blank");
  };

  return (
    <div className="h-screen flex flex-col">
      <GenerationStatusBanner projectId={projectId} />
      <AgentTimeline projectId={projectId} />

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            defaultSize={28}
            minSize={20}
            className="flex min-h-0 flex-col"
          >
            <ProjectHeader projectId={projectId} />
            <MessageContainer
              projectId={projectId}
              activeFragment={activeFragment}
              setActiveFragment={setActiveFragment}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={72} minSize={45} className="min-w-0">
            <Tabs
              className="flex h-full flex-col"
              defaultValue="preview"
              value={tabState}
              onValueChange={(value) => setTabState(value as "preview" | "code")}
            >
              <div className="flex w-full items-center gap-x-2 border-b p-2">
                <TabsList className="h-8 rounded-md border p-0">
                  <TabsTrigger
                    value="preview"
                    className="flex items-center gap-x-2 rounded-md px-3"
                  >
                    <EyeIcon className="size-4" />
                    <span>Demo</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="code"
                    className="flex items-center gap-x-2 rounded-md px-3"
                  >
                    <Code className="size-4" />
                    <span>Code</span>
                  </TabsTrigger>
                </TabsList>

                <div className="ml-auto flex items-center gap-x-2">
                  {/* PRD & Multi-Agent Specifications Viewer */}
                  <PRDViewer projectId={projectId} />

                  {/* Revision History Drawer */}
                  <RevisionHistory
                    projectId={projectId}
                    currentRevisionId={project?.currentRevisionId}
                  />

                  {/* Export Project ZIP */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs"
                    onClick={handleExport}
                  >
                    <Download className="size-3.5" />
                    <span>Export</span>
                  </Button>

                  {/* Customer Deploy Button (Intentionally Disabled in MVP) */}
                  <div className="relative group">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled
                      className="gap-1.5 text-xs opacity-60 cursor-not-allowed"
                    >
                      <Rocket className="size-3.5" />
                      <span>Deploy</span>
                      <span className="text-[10px] bg-muted px-1.5 py-0.2 rounded border font-mono">
                        Soon
                      </span>
                    </Button>
                  </div>

                  <Button asChild size="sm" variant="outline">
                    <Link href="/">
                      <CrownIcon className="mr-2 size-4" />
                      Upgrade
                    </Link>
                  </Button>
                </div>
              </div>

              <TabsContent
                value="preview"
                className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
              >
                {activeFragment ? (
                  <FragmentWeb data={activeFragment} />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    Select a fragment to preview
                  </div>
                )}
              </TabsContent>

              <TabsContent
                value="code"
                className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
              >
                {activeFragment?.files &&
                Object.keys(activeFragment.files).length > 0 ? (
                  <FileExplorer files={activeFragment.files} />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    Select a fragment to view code
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}