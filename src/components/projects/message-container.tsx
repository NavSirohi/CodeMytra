"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/spinner";
import {
  parseFragmentFiles,
  type ProjectFragment,
} from "@/features/projects/fragment-types";
import {
  prefetchMessages,
  useGetMessages,
} from "@/features/messages/hooks/messages";
import { MessageRole } from "@/generated/prisma/enums";
import MessageCard from "./message-card";
import MessageForm from "./message-form";
import MessageLoading from "./message-loader";

/**
 * Scrollable list of a project's messages plus the composer.
 *
 * Loads (and polls) messages, prefetches them on mount, auto-selects the latest
 * assistant fragment, auto-scrolls to the newest message, and shows a loading
 * indicator while the assistant is responding to the last user message. Handles
 * loading, error, and empty states.
 *
 * @param projectId - The project whose conversation is shown.
 * @param activeFragment - The currently selected fragment (for preview/code).
 * @param setActiveFragment - Setter to change the active fragment.
 */
export default function MessageContainer({
  projectId,
  activeFragment,
  onManualSelectFragment,
  onAutoSelectLatestFragment,
  isManualSelection,
}: {
  projectId: string;
  activeFragment: ProjectFragment | null;
  onManualSelectFragment: (fragment: ProjectFragment) => void;
  onAutoSelectLatestFragment: (fragment: ProjectFragment) => void;
  isManualSelection: boolean;
}) {
  const queryClient = useQueryClient();
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastAutoSelectedMessageIdRef = useRef<string | null>(null);

  const {
    data: messages,
    isPending,
    isError,
    error,
  } = useGetMessages(projectId);

  useEffect(() => {
    if (projectId) {
      void prefetchMessages(queryClient, projectId);
    }
  }, [projectId, queryClient]);

  // Automatic selection: only select the latest generated fragment when the user
  // has NOT made an explicit manual selection of a historical revision or fragment.
  useEffect(() => {
    if (isManualSelection) {
      return;
    }

    const lastAssistantMessage = messages?.findLast(
      (message) => message.role === MessageRole.ASSISTANT && Boolean(message.fragments)
    );

    if (
      lastAssistantMessage?.fragments &&
      lastAssistantMessage.id !== lastAutoSelectedMessageIdRef.current
    ) {
      lastAutoSelectedMessageIdRef.current = lastAssistantMessage.id;
      const revId = (lastAssistantMessage as unknown as { generationRun?: { resultRevisionId?: string | null } }).generationRun?.resultRevisionId ?? null;
      onAutoSelectLatestFragment({
        ...lastAssistantMessage.fragments,
        files: parseFragmentFiles(lastAssistantMessage.fragments.files),
        selectionType: "assistant-fragment",
        revisionId: revId,
      });
    }
  }, [messages, isManualSelection, onAutoSelectLatestFragment]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  if (isPending) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Spinner className="text-[#c75c35] size-6" />
        <span className="text-xs text-[#8a9a8e] font-mono">Loading studio conversation...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-xs text-red-400">
        <span>Failed to load messages: {error?.message || "Internal error"}</span>
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center gap-2">
          <div className="w-9 h-9 rounded-full bg-[#284938]/20 border border-[#284938]/40 flex items-center justify-center text-[#81aa80] font-serif text-lg">
            म
          </div>
          <p className="text-xs font-medium text-[#eae8df]">Ready to assemble your application</p>
          <p className="text-[11px] text-[#8a9a8e] max-w-xs">
            Describe what you want to build or add features below. Multi-agent pipeline will generate specifications, code, and preview.
          </p>
        </div>
        <div className="relative p-3 pt-1">
          <div className="pointer-events-none absolute -top-6 left-0 right-0 h-6 bg-gradient-to-b from-transparent to-[#1a231c]" />
          <MessageForm projectId={projectId} />
        </div>
      </div>
    );
  }

  const lastMessage = messages[messages.length - 1];
  const isLastMessageUser = lastMessage.role === MessageRole.USER;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.map((message) => {
          const revId = (message as unknown as { generationRun?: { resultRevisionId?: string | null } }).generationRun?.resultRevisionId ?? null;
          return (
            <MessageCard
              key={message.id}
              content={message.content}
              role={message.role}
              fragment={message.fragments}
              revisionId={revId}
              createdAt={message.createdAt}
              isActiveFragment={activeFragment?.id === message.fragments?.id}
              onFragmentClick={onManualSelectFragment}
              type={message.type}
            />
          );
        })}
        {isLastMessageUser && <MessageLoading />}
        <div ref={bottomRef} />
      </div>

      <div className="relative p-2 pt-1">
        <div className="pointer-events-none absolute -top-6 left-0 right-0 h-6 bg-gradient-to-b from-transparent to-background" />
        <MessageForm projectId={projectId} />
      </div>
    </div>
  );
}
