import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { projectsQueryKey } from "@/hooks/use-projects";
import { useSessionStore } from "@/stores/session-store";
import {
  cloneProjectDirectly,
  openProjectDirectly,
  type OpenProjectResult,
} from "@/hooks/open-project";

export function useOpenProject(
  serverId: string | null,
): (path: string) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const queryClient = useQueryClient();
  const canAddProject = useSessionStore((state) =>
    normalizedServerId
      ? state.sessions[normalizedServerId]?.serverInfo?.features?.projectAdd === true
      : false,
  );
  const addEmptyProject = useSessionStore((state) => state.addEmptyProject);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      const result = await openProjectDirectly({
        serverId: normalizedServerId,
        projectPath: path,
        isConnected,
        canAddProject,
        client,
        addEmptyProject,
        setHasHydratedWorkspaces,
      });
      // The aggregated projects query derives the project list from a fetch
      // that now includes empty projects; refetch so a freshly-added project
      // (no workspace yet) is immediately editable instead of only after a
      // restart.
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      }
      return result;
    },
    [
      addEmptyProject,
      canAddProject,
      client,
      isConnected,
      normalizedServerId,
      queryClient,
      setHasHydratedWorkspaces,
    ],
  );
}

export function useCloneProject(
  serverId: string | null,
): (input: {
  repoUrl: string;
  destinationParent: string;
  directoryName?: string;
}) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const queryClient = useQueryClient();
  const canCloneProject = useSessionStore((state) =>
    normalizedServerId
      ? state.sessions[normalizedServerId]?.serverInfo?.features?.projectClone === true
      : false,
  );
  const addEmptyProject = useSessionStore((state) => state.addEmptyProject);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (input: { repoUrl: string; destinationParent: string; directoryName?: string }) => {
      const result = await cloneProjectDirectly({
        serverId: normalizedServerId,
        repoUrl: input.repoUrl,
        destinationParent: input.destinationParent,
        ...(input.directoryName ? { directoryName: input.directoryName } : {}),
        isConnected,
        canCloneProject,
        client,
        addEmptyProject,
        setHasHydratedWorkspaces,
      });
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
      }
      return result;
    },
    [
      addEmptyProject,
      canCloneProject,
      client,
      isConnected,
      normalizedServerId,
      queryClient,
      setHasHydratedWorkspaces,
    ],
  );
}
