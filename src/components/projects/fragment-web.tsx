"use client";

import { useState } from "react";
import { ExternalLink, RefreshCcw, History, Code, Download, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import type { ProjectFragment } from "@/features/projects/fragment-types";

/**
 * Live preview of a generated fragment running in its E2B sandbox.
 *
 * Embeds the sandbox URL in a sandboxed `<iframe>` and provides controls to
 * refresh the preview, copy the URL, and open it in a new tab.
 *
 * For historical revisions, clearly informs the user that preview restoration
 * is not yet supported while keeping source code inspectable in the Code Explorer and exportable.
 *
 * @param data - The fragment to preview (provides `sandboxUrl`, `title`, `id`).
 * @param onViewCode - Optional callback to switch to the Code Explorer tab.
 * @param projectId - Optional project ID for revision exports.
 */
export default function FragmentWeb({
  data,
  onViewCode,
  projectId,
}: {
  data: ProjectFragment;
  onViewCode?: () => void;
  projectId?: string;
}) {
  const [fragmentKey, setFragmentKey] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  const isHistorical = data.messageId === "historical";

  /**
   * Force the preview iframe to reload by changing its `key`.
   */
  function onRefresh() {
    setFragmentKey((prev) => prev + 1);
  }

  /**
   * Copy the sandbox URL to the clipboard asynchronously.
   * Only displays success feedback after the promise resolves.
   * On failure, displays error feedback without losing or wiping the URL.
   */
  async function onCopy() {
    if (!data.sandboxUrl) return;

    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard API not available in current context");
      }
      await navigator.clipboard.writeText(data.sandboxUrl);
      setCopyStatus("copied");
      setTimeout(() => {
        setCopyStatus("idle");
      }, 2000);
    } catch (err) {
      console.error("[FragmentWeb] Failed to copy sandbox URL:", err);
      setCopyStatus("error");
      setTimeout(() => {
        setCopyStatus("idle");
      }, 3000);
    }
  }

  function handleExportRevision() {
    if (!projectId) {
      window.open(`/api/projects/export`, "_blank");
      return;
    }

    if (data.selectionType === "assistant-fragment") {
      if (!data.revisionId) {
        toast.error(
          "This preview fragment does not have a corresponding persisted revision to export. Please export a saved revision from Revision History."
        );
        return;
      }
      window.open(
        `/api/projects/${projectId}/export?revisionId=${encodeURIComponent(data.revisionId)}`,
        "_blank"
      );
      return;
    }

    if (data.selectionType === "historical-revision") {
      const revId = data.revisionId || data.id;
      window.open(
        `/api/projects/${projectId}/export?revisionId=${encodeURIComponent(revId)}`,
        "_blank"
      );
      return;
    }

    // Current revision or default
    const revParam = data.revisionId ? `?revisionId=${encodeURIComponent(data.revisionId)}` : "";
    window.open(`/api/projects/${projectId}/export${revParam}`, "_blank");
  }

  return (
    <div className="flex h-full w-full flex-col bg-[#17201a]">
      {/* Top Preview Utility Bar */}
      <div className="flex items-center gap-x-2 border-b border-[#28382b] bg-[#1c2820]/80 p-2 backdrop-blur-xs">
        <Hint text="Refresh sandbox iframe" side="bottom" align="start">
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={!data.sandboxUrl}
            className="h-7 w-7 p-0 border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
          >
            <RefreshCcw className="size-3" />
          </Button>
        </Hint>

        {isHistorical ? (
          <Hint
            text="Historical revision snapshot. Source code is preserved in Code Explorer."
            side="bottom"
            align="start"
          >
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[11px] font-medium cursor-help shrink-0">
              <History className="size-3 text-blue-400" />
              <span>Historical Snapshot</span>
            </div>
          </Hint>
        ) : (
          <Hint
            text="Ephemeral development sandbox hosted on E2B. Sandboxes expire after inactivity and are not permanent customer deployments. Use 'Export' to host permanently."
            side="bottom"
            align="start"
          >
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[11px] font-medium cursor-help shrink-0">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
              <span>Sandbox Preview (Temporary)</span>
            </div>
          </Hint>
        )}

        <Hint
          text={
            copyStatus === "copied"
              ? "Copied to clipboard!"
              : copyStatus === "error"
              ? "Failed to copy to clipboard (check permissions)"
              : data.sandboxUrl
              ? "Click to copy temporary sandbox URL"
              : isHistorical
              ? "No live preview for historical revisions"
              : "No live sandbox URL available"
          }
          side="bottom"
          align="start"
        >
          <Button
            size="sm"
            variant="outline"
            onClick={onCopy}
            disabled={!data.sandboxUrl || copyStatus === "copied"}
            className="flex-1 justify-start text-start font-normal text-xs h-7 border-[#2e3e33] bg-[#17201a] text-[#8a9a8e] hover:text-[#eae8df]"
          >
            <span className="truncate font-mono text-[11px]">
              {copyStatus === "copied"
                ? "Copied to clipboard!"
                : copyStatus === "error"
                ? `${data.sandboxUrl} (copy failed)`
                : data.sandboxUrl ||
                  (isHistorical
                    ? "Historical revision (preview restoration not supported)"
                    : "Sandbox URL pending or expired")}
            </span>
          </Button>
        </Hint>

        <Hint text="Open preview in new browser tab" side="bottom" align="start">
          <Button
            size="sm"
            variant="outline"
            disabled={!data.sandboxUrl}
            className="h-7 w-7 p-0 border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
            onClick={() => {
              if (!data.sandboxUrl) return;
              window.open(data.sandboxUrl, "_blank");
            }}
          >
            <ExternalLink className="size-3" />
          </Button>
        </Hint>
      </div>

      {/* Main Canvas Viewport */}
      {data.sandboxUrl ? (
        <iframe
          key={fragmentKey}
          className="h-full w-full bg-white border-0"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
          src={data.sandboxUrl}
          title={data.title}
        />
      ) : isHistorical ? (
        <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
          <div className="size-12 rounded-xl bg-[#202d24] border border-[#2e3e33] flex items-center justify-center text-blue-400">
            <History className="size-6" />
          </div>
          <h4 className="text-sm font-medium text-[#eae8df]">Historical Revision Preview Unavailable</h4>
          <p className="text-xs text-[#8a9a8e] max-w-md leading-relaxed">
            Preview restoration for historical revisions is not currently supported in this release.
            The complete source code for this saved revision remains permanently preserved and inspectable
            in the <strong>Code Explorer</strong>, and can be exported as a standalone full-stack ZIP.
          </p>
          <div className="flex items-center gap-2 mt-2">
            {onViewCode && (
              <Button
                size="sm"
                variant="outline"
                onClick={onViewCode}
                className="h-8 gap-1.5 text-xs border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
              >
                <Code className="size-3.5" />
                <span>Switch to Code Explorer</span>
              </Button>
            )}
            {projectId && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleExportRevision}
                className="h-8 gap-1.5 text-xs border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
              >
                <Download className="size-3.5" />
                <span>Export This Revision ZIP</span>
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
          <div className="size-12 rounded-xl bg-[#202d24] border border-[#2e3e33] flex items-center justify-center text-[#c75c35]">
            <AlertTriangle className="size-6" />
          </div>
          <h4 className="text-sm font-medium text-[#eae8df]">Temporary Sandbox Preview Expired or Offline</h4>
          <p className="text-xs text-[#8a9a8e] max-w-md leading-relaxed">
            Development sandbox containers on E2B spin down automatically after inactivity to optimize resources.
            Your complete project files remain permanently preserved in the <strong>Code Explorer</strong> and
            can be exported as a full-stack project archive.
          </p>
          <div className="flex items-center gap-2 mt-2">
            {onViewCode && (
              <Button
                size="sm"
                variant="outline"
                onClick={onViewCode}
                className="h-8 gap-1.5 text-xs border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
              >
                <Code className="size-3.5" />
                <span>View in Code Explorer</span>
              </Button>
            )}
            {projectId && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleExportRevision}
                className="h-8 gap-1.5 text-xs border-[#2e3e33] bg-[#202d24] text-[#eae8df] hover:bg-[#28382b]"
              >
                <Download className="size-3.5" />
                <span>Export Full-Stack ZIP</span>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
