"use client";

import { useGetActiveGenerationRun } from "@/features/projects/hooks/projects";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function GenerationStatusBanner({ projectId }: { projectId: string }) {
  const { data: run } = useGetActiveGenerationRun(projectId);

  if (!run) return null;

  const status = run.status;

  if (status === "COMPLETED") return null;

  const isPlanning = status === "PLANNING" || status === "QUEUED";
  const isDesigning = status === "DESIGNING";
  const isArchitecting = status === "ARCHITECTING";
  const isRunning = status === "RUNNING";
  const isValidating = status === "VALIDATING";
  const isFailed = status === "FAILED";

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs font-medium transition-colors",
        isPlanning && "bg-muted text-muted-foreground",
        isDesigning && "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
        isArchitecting && "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
        isRunning && "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
        isValidating && "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
        isFailed && "bg-destructive/10 text-destructive border-destructive/20"
      )}
    >
      {isPlanning && (
        <>
          <Loader2 className="size-3.5 animate-spin" />
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
