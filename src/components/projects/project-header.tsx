"use client";

import Link from "next/link";
import { ChevronDownIcon, ChevronLeftIcon, SunMoonIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Chai0Mark } from "@/components/brand/chai0-logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useGetProjectById } from "@/features/projects/hooks/projects";

/**
 * Turn a kebab-case project slug into a human-friendly, spaced name.
 *
 * @param name - The raw project name (e.g. `"sunny-otter"`).
 * @returns The same name with hyphens replaced by spaces.
 */
function formatProjectName(name: string) {
  return name.replace(/-/g, " ");
}

/**
 * Header bar for the project workspace.
 *
 * Shows the project name (loading spinner while fetching) inside a dropdown that
 * offers navigation back to the dashboard and a light/dark/system theme picker.
 *
 * @param projectId - The project whose name/menu is rendered.
 */
export default function ProjectHeader({ projectId }: { projectId: string }) {
  const { data: project, isPending } = useGetProjectById(projectId);
  const { setTheme, theme } = useTheme();

  return (
    <header className="flex items-center justify-between border-b border-border/40 bg-sidebar/50 px-3 py-2 backdrop-blur-xs">
      <div className="flex items-center gap-2.5 min-w-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-2 px-2 transition-opacity hover:bg-muted/50 focus-visible:ring-0"
            >
              <Chai0Mark className="h-6 w-6" />
              <div className="flex items-center gap-1.5 min-w-0 text-left">
                <span className="text-xs font-semibold text-foreground/80 tracking-tight">Code<em className="text-[#c75c35] not-italic">Mytra</em></span>
                <span className="text-muted-foreground/40 font-mono text-xs">/</span>
                <span className="text-xs font-medium text-foreground capitalize truncate max-w-[140px] sm:max-w-[200px]">
                  {isPending ? (
                    <Spinner className="size-3" />
                  ) : (
                    formatProjectName(project?.name || "Untitled Project")
                  )}
                </span>
              </div>
              <ChevronDownIcon className="size-3.5 text-muted-foreground shrink-0" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent side="bottom" align="start" className="w-56">
            <DropdownMenuItem asChild>
              <Link href="/" className="gap-2 cursor-pointer">
                <ChevronLeftIcon className="size-4 text-muted-foreground" />
                <span>Marketing & Home</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/builder" className="gap-2 cursor-pointer">
                <span className="font-serif text-[#c75c35] text-sm">✦</span>
                <span>New Project Brief</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2">
                <SunMoonIcon className="size-4 text-muted-foreground" />
                <span>Appearance</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent sideOffset={5}>
                  <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                    <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        {project?.currentRevisionId ? (
          <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-[#284938]/15 text-[#388257] dark:text-[#81aa80] border border-[#284938]/25">
            <span className="size-1.5 rounded-full bg-[#388257] animate-pulse" />
            Active Revision
          </span>
        ) : null}
      </div>
    </header>
  );
}
