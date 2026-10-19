"use client";

import { useGetActiveGenerationRun } from "@/features/projects/hooks/projects";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function GenerationStatusBanner({ projectId }: { projectId: string }) {
  const { data: run } = useGetActiveGenerationRun(projectId);

  if (!run) return null;

  const status = run.status;

  if (status === "COMPLETED") return null;

  const isQueued = status === "QUEUED";
  const isPlanning = status === "PLANNING";
  const isDesigning = status === "DESIGNING";
  const isArchitecting = status === "ARCHITECTING";
  const isRunning = status === "RUNNING";
  const isValidating = status === "VALIDATING";
  const isFailed = status === "FAILED";

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs font-medium transition-colors backdrop-blur-xs",
        (isQueued || isPlanning) && "bg-[#202822] text-[#8a9a8e] border-[#2e3e33]",
        isDesigning && "bg-[#c75c35]/15 text-[#e4835d] border-[#c75c35]/30",
        isArchitecting && "bg-[#dcba69]/15 text-[#e2c77d] border-[#dcba69]/30",
        isRunning && "bg-[#284938]/30 text-[#81aa80] border-[#284938]/40",
        isValidating && "bg-amber-500/15 text-amber-400 border-amber-500/30",
        isFailed && "bg-destructive/15 text-red-400 border-destructive/30"
      )}
    >
      {isQueued && (
        <>
          <Loader2 className="size-3.5 animate-spin text-[#8a9a8e]" />
          <span>Planner Agent: Generation queued in durable runner...</span>
        </>
      )}

      {isPlanning && (
        <>
          <Loader2 className="size-3.5 animate-spin text-[#81aa80]" />
          <span>Planner Agent: Analyzing requirements and drafting PRD...</span>
        </>
      )}

      {isDesigning && (
        <>
          <Loader2 className="size-3.5 animate-spin text-purple-500" />
          <span>Design Agent: Configuring theme, color palette, and layout guidelines...</span>
        </>
      )}

      {isArchitecting && (
        <>
          <Loader2 className="size-3.5 animate-spin text-indigo-500" />
          <span>Architecture Agent: Defining route endpoints and component hierarchy...</span>
        </>
      )}

      {isRunning && (
        <>
          <Loader2 className="size-3.5 animate-spin text-blue-500" />
          <span>Implementation Agent: Building your Next.js application with Gemini...</span>
        </>
      )}

      {isValidating && (
        <>
          <Loader2 className="size-3.5 animate-spin text-amber-500" />
          <span>QA Agent: Validating project structure and code integrity...</span>
        </>
      )}

      {isFailed && (
        <>
          <AlertCircle className="size-3.5 text-destructive" />
          <span>
            Generation failed: {run.errorMessage || "Validation check failed"}. Your previous working version is preserved.
          </span>
        </>
      )}
    </div>
  );
}
