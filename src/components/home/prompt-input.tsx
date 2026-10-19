"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronDown, RefreshCw, Sparkles, Check, Zap, Cpu } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import {
  getRandomPromptTemplate,
  promptTemplateCategories,
} from "@/components/home/prompt-templates";
import { useCreateProject } from "@/features/projects/hooks/projects";

const AVAILABLE_MODELS = [
  {
    id: "auto",
    name: "CodeMytra Auto",
    badge: "Recommended",
    icon: Sparkles,
    description: "Adaptive multi-agent routing (Flash for fast specs & code, Pro for complex architecture)",
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    badge: "Reasoning",
    icon: Cpu,
    description: "Deep reasoning for complex fullstack apps, relational models, and business logic",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    badge: "Ultra-Fast",
    icon: Zap,
    description: "Low-latency generation for rapid prototypes, components, and quick iterations",
  },
] as const;

export function PromptInput() {
  const [prompt, setPrompt] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string>("auto");
  const router = useRouter();
  const { mutate: createProject, isPending } = useCreateProject();

  const currentModel =
    AVAILABLE_MODELS.find((m) => m.id === selectedModelId) || AVAILABLE_MODELS[0];

  function handleSubmit() {
    createProject(prompt, {
      onSuccess: (project) => {
        router.push(`/projects/${project.id}`);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    });
  }

  function applySuggestion(nextPrompt: string) {
    setPrompt(nextPrompt);
  }

  function shuffleSuggestions() {
    setPrompt(getRandomPromptTemplate().prompt);
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <InputGroup className="h-auto min-h-32 flex-col rounded-2xl border-border/80 bg-card/70 shadow-sm backdrop-blur-sm has-[>textarea]:h-auto focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary/60 transition-all">
        <InputGroupTextarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the web application, SaaS dashboard, or tool you want to build with CodeMytra..."
          rows={4}
          className="min-h-24 px-4 pt-4 text-sm text-foreground placeholder:text-muted-foreground/80 focus:outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
        />
        <InputGroupAddon
          align="block-end"
          className="w-full justify-between border-t border-border/60 px-3 py-2 bg-muted/20"
        >
          {/* Functional Model Selector Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full gap-1.5 border-border/80 bg-background/80 text-foreground hover:bg-accent/15 hover:text-foreground font-medium text-xs h-7 px-3"
              >
                <currentModel.icon className="size-3.5 text-[#c75c35]" />
                <span>{currentModel.name}</span>
                <span className="text-[10px] text-muted-foreground hidden sm:inline">
                  ({currentModel.badge})
                </span>
                <ChevronDown className="size-3 opacity-60 ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80 p-2 border-border/80 bg-card text-foreground">
              <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1">
                Generation Model Registry
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {AVAILABLE_MODELS.map((model) => {
                const Icon = model.icon;
                const isSelected = model.id === selectedModelId;
                return (
                  <DropdownMenuItem
                    key={model.id}
                    onClick={() => setSelectedModelId(model.id)}
                    className="flex items-start gap-2.5 p-2 rounded-xl cursor-pointer hover:bg-accent/15 focus:bg-accent/15"
                  >
                    <Icon className="size-4 mt-0.5 text-[#c75c35] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-foreground">
                          {model.name}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded-full font-mono bg-primary/10 text-primary border border-primary/20">
                          {model.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                        {model.description}
                      </p>
                    </div>
                    {isSelected && (
                      <Check className="size-3.5 text-primary shrink-0 mt-1" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          <InputGroupButton
            size="icon-sm"
            variant="default"
            onClick={handleSubmit}
            disabled={!prompt.trim() || isPending}
            aria-label="Submit prompt"
            className="bg-[#c75c35] hover:bg-[#b04f2c] text-white disabled:opacity-40"
          >
            {isPending ? <Spinner className="size-4" /> : <ArrowUp className="size-4" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>

      {/* Suggestion categories with high WCAG AA contrast */}
      <div className="flex w-full flex-col gap-5 text-left">
        {promptTemplateCategories.map((category) => (
          <div key={category.name} className="flex flex-col gap-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground/85 dark:text-foreground/90">
              {category.name}
            </p>
            <div className="flex flex-wrap gap-2">
              {category.templates.map(({ label, icon: Icon, prompt: templatePrompt }) => (
                <Button
                  key={label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full border-border/80 bg-card/60 hover:bg-accent/20 hover:border-foreground/40 text-foreground font-medium text-xs transition-colors shadow-xs"
                  disabled={isPending}
                  onClick={() => applySuggestion(templatePrompt)}
                >
                  <Icon className="size-3.5 text-primary shrink-0 mr-1" />
                  {label}
                </Button>
              ))}
            </div>
          </div>
        ))}

        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full text-foreground/80 hover:text-foreground hover:bg-accent/15 text-xs font-medium"
            disabled={isPending}
            onClick={shuffleSuggestions}
          >
            <RefreshCw className="size-3.5 mr-1 text-[#c75c35]" />
            Shuffle random idea
          </Button>
        </div>
      </div>
    </div>
  );
}
