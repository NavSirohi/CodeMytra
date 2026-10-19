import { useEffect, useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  useGetActiveGenerationRun,
  isGenerationActiveStatus,
} from "@/features/projects/hooks/projects";
import { createMessage, getMessages } from "../actions";

/**
 * Warm the React Query cache with a project's messages.
 *
 * Useful on navigation so the messages list renders instantly from cache.
 *
 * @param queryClient - The React Query client to prime.
 * @param projectId - The project whose messages should be prefetched.
 */
export const prefetchMessages = async (
  queryClient: QueryClient,
  projectId: string
) => {
  await queryClient.prefetchQuery({
    queryKey: ["messages", projectId],
    queryFn: () => getMessages(projectId),
    staleTime: 10_000,
  });
};

/**
 * React Query hook that loads and live-polls a project's messages based on the generation lifecycle.
 *
 * - Polls while generation is actively running or queued (every 2.5s) so new projects receive
 *   their initial assistant response and follow-ups stream in reliably.
 * - Detects transitions to terminal states (COMPLETED / FAILED) to immediately invalidate
 *   and refetch final messages and revisions.
 * - Stops polling once the generation run reaches a terminal state, preventing unnecessary continuous polling.
 *
 * @param projectId - The project whose messages to fetch.
 */
export const useGetMessages = (projectId: string) => {
  const queryClient = useQueryClient();
  const { data: activeRun, isPending: isActiveRunPending } = useGetActiveGenerationRun(projectId);
  const status = activeRun?.status;
  const isGenerating = isGenerationActiveStatus(status);
  const prevStatusRef = useRef<string | null>(null);

  // When active generation transitions from running to terminal (COMPLETED or FAILED),
  // immediately invalidate messages, project revision, and revisions list to surface changes instantly.
  useEffect(() => {
    const currentStatus = status ?? null;
    if (prevStatusRef.current && prevStatusRef.current !== currentStatus) {
      const wasActive = isGenerationActiveStatus(prevStatusRef.current);
      const isTerminal =
        currentStatus === "COMPLETED" ||
        currentStatus === "FAILED" ||
        currentStatus === "CANCELLED";

      if (wasActive && isTerminal) {
        void queryClient.invalidateQueries({ queryKey: ["messages", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["project-revisions", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["project-specification", projectId] });
      }
    }
    prevStatusRef.current = currentStatus;
  }, [status, projectId, queryClient]);

  return useQuery({
    queryKey: ["messages", projectId],
    queryFn: () => getMessages(projectId),
    staleTime: 5_000,
    refetchInterval: (query) => {
      // 1. While generation is queued or active, poll every 2.5s
      if (isGenerating) {
        return 2500;
      }

      // 2. Newly created project with no messages and activeRun pending: poll until settled
      const messagesCount = query.state.data?.length ?? 0;
      if (messagesCount === 0 && isActiveRunPending) {
        return 2500;
      }

      // 3. Terminal state (COMPLETED, FAILED, CANCELLED) or idle -> do not poll
      return false;
    },
    enabled: Boolean(projectId),
  });
};

/**
 * React Query mutation hook for sending a new message to a project.
 *
 * Invalidates messages, active generation run, and project queries on success
 * so the conversation, active timeline, and composer locks update immediately.
 *
 * @param projectId - The project the new message belongs to.
 */
export const useCreateMessage = (projectId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (value: string) => createMessage(value, projectId),
    onSuccess: () => {
      // Invalidate messages, active generation run, and project queries immediately
      void queryClient.invalidateQueries({ queryKey: ["messages", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["active-generation-run", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project-revisions", projectId] });
    },
  });
};
