"use client";

import { useGetActiveGenerationRun } from "@/features/projects/hooks/projects";
import { Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function GenerationStatusBanner({ projectId }: { projectId: string }) {
  const { data: run } = useGetActiveGenerationRun(projectId);

  if (!run) return null;

  const status = run.status;

  if (status === "COMPLETED") return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b px-3 py-1.5 text-xs font-medium transition-colors",
        status === "QUEUED" && "bg-muted text-muted-foreground",
        status === "RUNNING" && "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
        status === "VALIDATING" && "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
        status === "FAILED" && "bg-destructive/10 text-destructive border-destructive/20"
      )}
    >
      {status === "QUEUED" && (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <span>Preparing your request...</span>
        </>
      )}

      {status === "RUNNING" && (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <span>Building your application with Google Gemini...</span>
        </>
      )}

      {status === "VALIDATING" && (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <span>Validating project files and build integrity...</span>
        </>
      )}

      {status === "FAILED" && (
        <>
          <AlertCircle className="size-3.5" />
          <span>
            Generation failed: {run.errorMessage || "Validation check failed"}. Your previous working version is preserved.
          </span>
        </>
      )}
    </div>
  );
}
