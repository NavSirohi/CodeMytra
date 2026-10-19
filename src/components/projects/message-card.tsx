"use client";

import { Response } from "@/components/ai-elements/response";
import { Card } from "@/components/ui/card";
import {
  parseFragmentFiles,
  type ProjectFragment,
} from "@/features/projects/fragment-types";
import { cn } from "@/lib/utils";
import type { Fragment } from "@/generated/prisma/client";
import { MessageRole, MessageType } from "@/generated/prisma/enums";
import { format } from "date-fns";
import { ChevronRightIcon, Code2Icon } from "lucide-react";
import { Chai0Mark } from "@/components/brand/chai0-logo";

/**
 * Clickable card representing a generated fragment inside an assistant message.
 *
 * Highlights itself when it is the active fragment and notifies the parent (with
 * the fragment's files parsed) when clicked.
 *
 * @param fragment - The fragment record to display.
 * @param isActiveFragment - Whether this fragment is currently selected.
 * @param onFragmentClick - Called with the parsed fragment when clicked.
 */
function FragmentCard({
  fragment,
  revisionId,
  isActiveFragment,
  onFragmentClick,
}: {
  fragment: Fragment;
  revisionId?: string | null;
  isActiveFragment: boolean;
  onFragmentClick: (fragment: ProjectFragment) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-fit items-start gap-2.5 rounded-xl border border-[#2e3e33] bg-[#243328]/80 p-2.5 text-start transition-all hover:border-[#c75c35]/60 hover:bg-[#28392d]",
        isActiveFragment &&
          "border-[#c75c35] bg-[#c75c35]/15 text-[#f7f6f1] ring-1 ring-[#c75c35]"
      )}
      onClick={() =>
        onFragmentClick({
          ...fragment,
          files: parseFragmentFiles(fragment.files),
          selectionType: "assistant-fragment",
          revisionId: revisionId ?? null,
        })
      }
    >
      <div className="p-1 rounded-md bg-[#284938]/40 text-[#81aa80]">
        <Code2Icon className="size-4" />
      </div>
      <div className="flex flex-1 flex-col">
        <span className="line-clamp-1 text-xs font-semibold text-[#f7f6f1]">{fragment.title}</span>
        <span className="text-[11px] text-[#8a9a8e] flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-[#388257]" />
          Preview Available
        </span>
      </div>
      <ChevronRightIcon className="mt-1 size-3.5 text-[#8a9a8e]" />
    </button>
  );
}

/**
 * A message bubble for content authored by the user (right-aligned).
 *
 * @param content - The user's message text.
 */
function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end pb-4 pl-8 pr-1">
      <Card className="max-w-[85%] break-words rounded-2xl border border-[#284938]/40 bg-[#284938]/25 text-[#f7f6f1] px-3.5 py-2.5 text-xs leading-relaxed shadow-none">
        {content}
      </Card>
    </div>
  );
}

/**
 * A message rendered by the assistant.
 *
 * Shows the chai0 mark, a hover-revealed timestamp, the markdown response, and —
 * for successful results — a {@link FragmentCard} linking to the generated app.
 * Error-type messages are styled in red.
 *
 * @param content - The assistant's message text (markdown).
 * @param fragment - Associated fragment, or `null` if none.
 * @param createdAt - When the message was created.
 * @param isActiveFragment - Whether this message's fragment is selected.
 * @param onFragmentClick - Called when the fragment card is clicked.
 * @param type - The message type (e.g. RESULT or ERROR).
 */
function AssistantMessage({
  content,
  fragment,
  revisionId,
  createdAt,
  isActiveFragment,
  onFragmentClick,
  type,
}: {
  content: string;
  fragment: Fragment | null;
  revisionId?: string | null;
  createdAt: Date;
  isActiveFragment: boolean;
  onFragmentClick: (fragment: ProjectFragment) => void;
  type: MessageType;
}) {
  return (
    <div
      className={cn(
        "group flex flex-col px-1 pb-4",
        type === MessageType.ERROR && "text-red-400"
      )}
    >
      <div className="mb-2 flex items-center gap-2 pl-1">
        <Chai0Mark className="h-5.5 w-5.5 shrink-0" />
        <span className="text-[11px] font-medium text-[#8a9a8e]">CodeMytra Assistant</span>
        <span className="text-[10px] text-[#617066] font-mono opacity-0 transition-opacity group-hover:opacity-100">
          {format(new Date(createdAt), "HH:mm 'on' MMM dd")}
        </span>
      </div>

      <div className="flex flex-col gap-y-3 pl-8 text-xs text-[#eae8df] leading-relaxed">
        <Response>{content}</Response>
        {fragment && type === MessageType.RESULT && (
          <FragmentCard
            fragment={fragment}
            revisionId={revisionId}
            isActiveFragment={isActiveFragment}
            onFragmentClick={onFragmentClick}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Renders a single chat message, dispatching to the assistant or user variant
 * based on `role`.
 *
 * @param content - The message text.
 * @param role - Who authored the message (USER or ASSISTANT).
 * @param fragment - Associated fragment, or `null`.
 * @param revisionId - Optional ProjectRevision ID from generation run.
 * @param createdAt - When the message was created.
 * @param isActiveFragment - Whether this message's fragment is selected.
 * @param onFragmentClick - Called when the fragment card is clicked.
 * @param type - The message type (e.g. RESULT or ERROR).
 */
export default function MessageCard({
  content,
  role,
  fragment,
  revisionId,
  createdAt,
  isActiveFragment,
  onFragmentClick,
  type,
}: {
  content: string;
  role: MessageRole;
  fragment: Fragment | null;
  revisionId?: string | null;
  createdAt: Date;
  isActiveFragment: boolean;
  onFragmentClick: (fragment: ProjectFragment) => void;
  type: MessageType;
}) {
  if (role === MessageRole.ASSISTANT) {
    return (
      <AssistantMessage
        content={content}
        fragment={fragment}
        revisionId={revisionId}
        createdAt={createdAt}
        isActiveFragment={isActiveFragment}
        onFragmentClick={onFragmentClick}
        type={type}
      />
    );
  }

  return (
    <div className="mt-5">
      <UserMessage content={content} />
    </div>
  );
}
