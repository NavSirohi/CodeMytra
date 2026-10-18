"use client";

import { useState } from "react";
import { format } from "date-fns";
import { History, RotateCcw, Check, FileCode, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  useGetProjectRevisions,
  useRestoreProjectRevision,
} from "@/features/projects/hooks/projects";
import { cn } from "@/lib/utils";

interface RevisionHistoryProps {
  projectId: string;
  currentRevisionId?: string | null;
  onSelectRevision?: (revisionId: string) => void;
}

export function RevisionHistory({
  projectId,
  currentRevisionId,
  onSelectRevision,
}: RevisionHistoryProps) {
  const [open, setOpen] = useState(false);
  const { data: revisions, isLoading } = useGetProjectRevisions(projectId);
  const restoreMutation = useRestoreProjectRevision(projectId);

  const handleRestore = async (revisionId: string, revisionNumber: number) => {
    if (confirm(`Restore project to Revision V${revisionNumber}? A new revision will be created without modifying your earlier history.`)) {
      await restoreMutation.mutateAsync(revisionId);
      setOpen(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 text-xs">
          <History className="size-3.5" />
          <span>Revisions ({revisions?.length || 0})</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4" />
            <span>Project Revision History</span>
          </SheetTitle>
          <SheetDescription>
            Browse, inspect, or restore earlier versions of your application. Restoring never overwrites your previous revisions.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 flex flex-col gap-3 overflow-y-auto max-h-[calc(100vh-140px)] pr-1">
          {isLoading && (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin mr-2" />
              <span>Loading revisions...</span>
            </div>
          )}

          {!isLoading && (!revisions || revisions.length === 0) && (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground text-center">
              No revisions saved yet. Successful generation runs automatically create durable revisions.
            </div>
          )}

          {revisions?.map((rev) => {
            const isCurrent = rev.id === currentRevisionId;
            const manifest = rev.manifest as { fileCount?: number } | null;
            const fileCount = manifest?.fileCount || 0;

            return (
              <div
                key={rev.id}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-3.5 transition-colors",
                  isCurrent
                    ? "border-primary bg-primary/5 dark:bg-primary/10"
                    : "border-border hover:bg-muted/50"
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">
                      V{rev.revisionNumber}
                    </span>
                    {isCurrent && (
                      <span className="rounded-full bg-primary/20 text-primary text-[10px] font-medium px-2 py-0.5 flex items-center gap-1">
                        <Check className="size-3" />
                        Active
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(rev.createdAt), "MMM d, h:mm a")}
                  </span>
                </div>

                <div className="text-xs text-foreground/80 line-clamp-2">
                  {rev.title || "Update"}
                </div>

                {rev.summary && (
                  <div className="text-[11px] text-muted-foreground line-clamp-2 italic">
                    {rev.summary}
                  </div>
                )}

                <div className="mt-1 flex items-center justify-between pt-2 border-t border-border/40 text-xs">
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <FileCode className="size-3" />
                    {fileCount} files
                  </span>

                  <div className="flex items-center gap-1.5">
                    {onSelectRevision && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          onSelectRevision(rev.id);
                          setOpen(false);
                        }}
                      >
                        View
                      </Button>
                    )}

                    {!isCurrent && (
                      <Button
                        size="xs"
                        variant="outline"
                        className="gap-1"
                        disabled={restoreMutation.isPending}
                        onClick={() => handleRestore(rev.id, rev.revisionNumber)}
                      >
                        <RotateCcw className="size-3" />
                        <span>Restore</span>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
