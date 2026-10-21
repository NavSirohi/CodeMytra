"use client";

import { useGetActiveGenerationRun } from "@/features/projects/hooks/projects";
import { Check, Loader2, Sparkles, Paintbrush, Layers, Code, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const STAGES = [
  { key: "PLANNING", label: "Planner", icon: Sparkles },
  { key: "DESIGNING", label: "Designer", icon: Paintbrush },
  { key: "ARCHITECTING", label: "Architect", icon: Layers },
  { key: "RUNNING", label: "Coder", icon: Code },
  { key: "VALIDATING", label: "QA Check", icon: ShieldCheck },
];

export function AgentTimeline({ projectId }: { projectId: string }) {
  const { data: run } = useGetActiveGenerationRun(projectId);

  if (!run) return null;

  const currentStatus = run.status;
  const isTerminal = currentStatus === "COMPLETED" || currentStatus === "FAILED" || currentStatus === "CANCELLED";

  if (isTerminal) return null;

  const currentStageIndex = STAGES.findIndex((s) => s.key === currentStatus);

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 bg-[#202822]/80 dark:bg-[#1a231c]/90 border-b border-[#2e3e33] overflow-x-auto text-xs backdrop-blur-xs">
      <span className="font-semibold text-[#8a9a8e] mr-1 text-[11px] shrink-0 uppercase tracking-wider font-mono">
        Multi-Agent Studio:
      </span>

      {STAGES.map((stage, idx) => {
        const Icon = stage.icon;
        const isCompleted = currentStageIndex > idx;
        const isCurrent = currentStageIndex === idx;

        return (
          <div
            key={stage.key}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition-all shrink-0 font-medium",
              isCompleted && "border-[#284938] bg-[#284938]/20 text-[#81aa80]",
              isCurrent && "border-[#c75c35] bg-[#c75c35]/15 text-[#e4835d] font-semibold shadow-xs animate-pulse",
              !isCompleted && !isCurrent && "border-[#2e3e33]/60 text-[#617066] opacity-60"
            )}
          >
            {isCompleted ? (
              <Check className="size-3 text-[#81aa80] stroke-[2.5]" />
            ) : isCurrent ? (
              <Loader2 className="size-3 animate-spin text-[#c75c35]" />
            ) : (
              <Icon className="size-3" />
            )}
            <span>{stage.label}</span>
          </div>
        );
      })}
    </div>
  );
}
