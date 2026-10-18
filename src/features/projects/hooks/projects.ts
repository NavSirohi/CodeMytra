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

export const useGetActiveGenerationRun = (projectId: string) => {
  return useQuery({
    queryKey: ["active-generation-run", projectId],
    queryFn: async () => getActiveGenerationRun(projectId),
    enabled: Boolean(projectId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Poll every 2.5 seconds while a generation is in progress
      const isActive =
        status === "QUEUED" ||
        status === "PLANNING" ||
        status === "DESIGNING" ||
        status === "ARCHITECTING" ||
        status === "RUNNING" ||
        status === "VALIDATING";

      return isActive ? 2500 : false;
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