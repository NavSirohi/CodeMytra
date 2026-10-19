"use client";

import { useState } from "react";
import { ExternalLink, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import type { ProjectFragment } from "@/features/projects/fragment-types";

/**
 * Live preview of a generated fragment running in its E2B sandbox.
 *
 * Embeds the sandbox URL in a sandboxed `<iframe>` and provides controls to
 * refresh the preview, copy the URL, and open it in a new tab.
 *
 * @param data - The fragment to preview (provides `sandboxUrl` and `title`).
 */
export default function FragmentWeb({ data }: { data: ProjectFragment }) {
  const [fragmentKey, setFragmentKey] = useState(0);
  const [copied, setCopied] = useState(false);

  /**
   * Force the preview iframe to reload by changing its `key`.
   */
  function onRefresh() {
    setFragmentKey((prev) => prev + 1);
  }

  /**
   * Copy the sandbox URL to the clipboard and briefly show a "Copied" state.
   */
  function onCopy() {
    navigator.clipboard.writeText(data.sandboxUrl);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  }

  return (
    <div className="flex h-full w-full flex-col bg-[#17201a]">
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

        <Hint
          text="Ephemeral development sandbox hosted on E2B. Sandboxes expire after inactivity and are not permanent production deployments. Use 'Export' to host permanently."
          side="bottom"
          align="start"
        >
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[11px] font-medium cursor-help shrink-0">
            <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span>Sandbox Preview (Temporary)</span>
          </div>
        </Hint>

        <Hint
          text={copied ? "Copied to clipboard!" : data.sandboxUrl ? "Click to copy temporary sandbox URL" : "No live URL"}
          side="bottom"
          align="start"
        >
          <Button
            size="sm"
            variant="outline"
            onClick={onCopy}
            disabled={!data.sandboxUrl || copied}
            className="flex-1 justify-start text-start font-normal text-xs h-7 border-[#2e3e33] bg-[#17201a] text-[#8a9a8e] hover:text-[#eae8df]"
          >
            <span className="truncate font-mono text-[11px]">
              {data.sandboxUrl || "Sandbox URL pending or expired"}
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

      {data.sandboxUrl ? (
        <iframe
          key={fragmentKey}
          className="h-full w-full bg-white border-0"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
          src={data.sandboxUrl}
          title={data.title}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center p-8 text-center text-[#8a9a8e] gap-3">
          <div className="size-12 rounded-xl bg-[#202d24] border border-[#2e3e33] flex items-center justify-center text-[#c75c35]">
            <ExternalLink className="size-5" />
          </div>
          <h4 className="text-sm font-medium text-[#eae8df]">Temporary Sandbox Preview Offline</h4>
          <p className="text-xs text-[#8a9a8e] max-w-sm leading-relaxed">
            Live preview sandboxes on E2B spin down automatically after inactivity, or when live sandbox credentials are unconfigured in the deployment environment.
            Your complete code is safely preserved in the <strong>Code Explorer</strong> tab and can be exported as a full-stack ZIP.
          </p>
        </div>
      )}
    </div>
  );
}
