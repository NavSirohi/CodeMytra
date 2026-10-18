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
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-background/80 border-b overflow-x-auto text-xs">
      <span className="font-semibold text-muted-foreground mr-1 text-[11px] shrink-0 uppercase tracking-wider">
        Agents:
      </span>

      {STAGES.map((stage, idx) => {
        const Icon = stage.icon;
        const isCompleted = currentStageIndex > idx;
        const isCurrent = currentStageIndex === idx;

        return (
          <div
            key={stage.key}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] transition-all shrink-0",
              isCompleted && "border-primary/40 bg-primary/10 text-primary font-medium",
              isCurrent && "border-blue-500 bg-blue-500/15 text-blue-500 font-semibold shadow-xs animate-pulse",
              !isCompleted && !isCurrent && "border-border/40 text-muted-foreground/60 opacity-60"
            )}
          >
            {isCompleted ? (
              <Check className="size-3 text-primary stroke-[2.5]" />
            ) : isCurrent ? (
              <Loader2 className="size-3 animate-spin text-blue-500" />
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
