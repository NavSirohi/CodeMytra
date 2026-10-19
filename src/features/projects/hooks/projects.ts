import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProject,
  getProjects,
  getProjectById,
  getProjectRevisions,
  restoreProjectRevision,
  getActiveGenerationRun,
  getProjectSpecification,
} from "../actions";

export type ActionError = {
  error: string;
};

function isActionError(value: unknown): value is ActionError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ActionError).error === "string"
  );
}

async function unwrapActionResult<T>(result: T | { error: string }): Promise<T> {
  if (isActionError(result)) {
    throw new Error(result.error);
  }

  return result;
}

export const useCreateProject = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (value: string) =>
      unwrapActionResult(await createProject(value)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
};

export const useGetProjects = () => {
  return useQuery({
    queryKey: ["projects"],
    queryFn: async () => unwrapActionResult(await getProjects()),
  });
};

export const useGetProjectById = (id: string) => {
  return useQuery({
    queryKey: ["project", id],
    queryFn: async () => unwrapActionResult(await getProjectById(id)),
    enabled: Boolean(id),
  });
};

export const useGetProjectRevisions = (projectId: string) => {
  return useQuery({
    queryKey: ["project-revisions", projectId],
    queryFn: async () => getProjectRevisions(projectId),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
};

export const useRestoreProjectRevision = (projectId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (revisionId: string) =>
      restoreProjectRevision(projectId, revisionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-revisions", projectId] });
      queryClient.invalidateQueries({ queryKey: ["messages", projectId] });
    },
  });
};

export const isGenerationActiveStatus = (status?: string | null): boolean => {
  return (
    status === "QUEUED" ||
    status === "PLANNING" ||
    status === "AWAITING_APPROVAL" ||
    status === "DESIGNING" ||
    status === "ARCHITECTING" ||
    status === "RUNNING" ||
    status === "VALIDATING"
  );
};

export interface ActiveRunPollOptions {
  status?: string | null;
  dataUpdateCount?: number;
  maxFastDiscoveryAttempts?: number;
  maxExtendedDiscoveryAttempts?: number;
}

export const DEFAULT_MAX_FAST_DISCOVERY_ATTEMPTS = 5;
export const DEFAULT_MAX_EXTENDED_DISCOVERY_ATTEMPTS = 12; // 5 * 1.5s + 7 * 5s = ~42.5s total discovery window
export const ACTIVE_RUN_POLL_INTERVAL_MS = 2000;
export const INITIAL_DISCOVERY_POLL_INTERVAL_MS = 1500;
export const EXTENDED_DISCOVERY_POLL_INTERVAL_MS = 5000;

export const getActiveRunPollInterval = (
  statusOrOptions?: string | null | ActiveRunPollOptions,
  legacyDataUpdateCount?: number
): number | false => {
  let status: string | null | undefined;
  let dataUpdateCount = 0;
  let maxFast = DEFAULT_MAX_FAST_DISCOVERY_ATTEMPTS;
  let maxExtended = DEFAULT_MAX_EXTENDED_DISCOVERY_ATTEMPTS;

  if (typeof statusOrOptions === "object" && statusOrOptions !== null) {
    status = statusOrOptions.status;
    dataUpdateCount = statusOrOptions.dataUpdateCount ?? 0;
    maxFast = statusOrOptions.maxFastDiscoveryAttempts ?? DEFAULT_MAX_FAST_DISCOVERY_ATTEMPTS;
    maxExtended = statusOrOptions.maxExtendedDiscoveryAttempts ?? DEFAULT_MAX_EXTENDED_DISCOVERY_ATTEMPTS;
  } else {
    status = statusOrOptions;
    dataUpdateCount = legacyDataUpdateCount ?? 0;
  }

  // 1. Explicit terminal states -> STOP polling immediately
  if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
    return false;
  }

  // 2. Active generation run -> poll every 2000ms
  if (isGenerationActiveStatus(status)) {
    return ACTIVE_RUN_POLL_INTERVAL_MS;
  }

  // 3. Initial discovery window when status is null or undefined:
  // Studio may initially receive null if the generation run record is being created, queued in outbox,
  // or delayed by database connection pool/cold start.
  // Stage 1 (Fast Discovery): Poll every 1500ms for first 5 attempts (~7.5s).
  // Stage 2 (Extended Recovery): Back off to 5000ms for attempts 5-11 (up to ~42.5s) to discover legitimately
  // delayed runs without flooding the database.
  // Stage 3 (Cessation): After 12 attempts without discovering a run, stop polling to prevent indefinite loops.
  if (status === null || status === undefined) {
    if (dataUpdateCount < maxFast) {
      return INITIAL_DISCOVERY_POLL_INTERVAL_MS;
    }
    if (dataUpdateCount < maxExtended) {
      return EXTENDED_DISCOVERY_POLL_INTERVAL_MS;
    }
    return false;
  }

  return false;
};

export const useGetActiveGenerationRun = (projectId: string) => {
  return useQuery({
    queryKey: ["active-generation-run", projectId],
    queryFn: async () => {
      const run = await getActiveGenerationRun(projectId);
      return run;
    },
    enabled: Boolean(projectId),
    refetchInterval: (query) => {
      return getActiveRunPollInterval({
        status: query.state.data?.status ?? null,
        dataUpdateCount: query.state.dataUpdateCount,
      });
    },
  });
};

export const useGetProjectSpecification = (projectId: string) => {
  return useQuery({
    queryKey: ["project-specification", projectId],
    queryFn: async () => getProjectSpecification(projectId),
    enabled: Boolean(projectId),
  });
};