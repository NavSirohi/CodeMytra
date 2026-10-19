"use client";

import { useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { ArrowUpIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCreateMessage } from "@/features/messages/hooks/messages";
import { useGetActiveGenerationRun } from "@/features/projects/hooks/projects";
import { cn } from "@/lib/utils";

/** Maximum allowed length for a single message. */
const MAX_LENGTH = 1000;

/**
 * Auto-growing composer for sending a new message to a project.
 *
 * Validates that the message is non-empty and within {@link MAX_LENGTH},
 * sends it, clears the field on success, and reports outcomes via toasts.
 * Cmd/Ctrl+Enter submits.
 * Prevents duplicate submissions while a run is in progress.
 *
 * @param projectId - The project the message is sent to.
 */
export default function MessageForm({ projectId }: { projectId: string }) {
  const [content, setContent] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const { mutateAsync, isPending } = useCreateMessage(projectId);
  const { data: run } = useGetActiveGenerationRun(projectId);

  const isRunActive = Boolean(
    run &&
      run.status !== "COMPLETED" &&
      run.status !== "FAILED" &&
      run.status !== "CANCELLED"
  );

  const isDisabled = isPending || isRunActive;

  /**
   * Validate and send the current message, then reset the input on success.
   */
  async function onSubmit() {
    if (isRunActive) {
      toast.error("A generation run is currently in progress. Please wait for completion.");
      return;
    }

    const trimmed = content.trim();

    if (!trimmed) {
      toast.error("Message description is required");
      return;
    }

    if (trimmed.length > MAX_LENGTH) {
      toast.error("Description is too long");
      return;
    }

    try {
      await mutateAsync(trimmed);
      setContent("");
      toast.success("Follow-up instructions sent to agent pipeline");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send message");
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
      className={cn(
        "relative rounded-xl border border-[#2e3e33] bg-[#202822]/90 dark:bg-[#1a231c]/95 p-3.5 transition-all shadow-xs",
        isFocused && "border-[#c75c35]/60 ring-2 ring-[#c75c35]/20",
        isRunActive && "opacity-80"
      )}
    >
      <TextareaAutosize
        value={content}
        onChange={(event) => setContent(event.target.value)}
        disabled={isDisabled}
        placeholder={
          isRunActive
            ? "Agents are currently executing... please wait for completion to follow up."
            : "Refine or add features (e.g. 'Add a filter bar and dark mode toggle')..."
        }
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        minRows={2}
        maxRows={6}
        className={cn(
          "w-full resize-none border-none bg-transparent text-sm text-[#f7f6f1] placeholder:text-[#617066] outline-none leading-relaxed",
          isDisabled && "cursor-not-allowed opacity-60"
        )}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void onSubmit();
          }
        }}
      />

      <div className="flex items-center justify-between gap-x-2 pt-2 border-t border-[#2e3e33]/50 mt-1">
        <div className="flex items-center gap-2">
          {isRunActive ? (
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#e4835d]">
              <Loader2 className="size-3 animate-spin" />
              <span>Agents executing...</span>
            </div>
          ) : (
            <div className="font-mono text-[10px] text-[#8a9a8e]">
              <kbd className="pointer-events-none inline-flex h-4.5 select-none items-center gap-0.5 rounded border border-[#2e3e33] bg-[#17201a] px-1.5 font-mono text-[10px] font-medium text-[#8a9a8e]">
                <span>⌘</span>Enter
              </kbd>
              &nbsp; to send
            </div>
          )}
        </div>

        <Button
          className={cn(
            "size-7 rounded-lg bg-[#c75c35] text-white hover:bg-[#b04f2c] transition-all",
            isDisabled && "opacity-50 cursor-not-allowed bg-[#2e3e33]"
          )}
          disabled={isDisabled || !content.trim()}
          type="submit"
          size="icon"
        >
          {isPending ? (
            <Spinner className="size-3.5 text-white" />
          ) : (
            <ArrowUpIcon className="size-3.5" />
          )}
        </Button>
      </div>
    </form>
  );
}
