import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  cloneProjectDirectly,
  openGithubRepoDirectly,
  openProjectDirectly,
  type OpenProjectResult,
  type WorkspaceGithubCloneProtocol,
} from "@/hooks/open-project";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

export function useOpenProject(
  serverId: string | null,
): (path: string) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
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
      return result;
    },
    [
      addEmptyProject,
      canAddProject,
      client,
      isConnected,
      normalizedServerId,
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
      return result;
    },
    [
      addEmptyProject,
      canCloneProject,
      client,
      isConnected,
      normalizedServerId,
      setHasHydratedWorkspaces,
    ],
  );
}

export function useOpenGithubRepo(
  serverId: string | null,
): (
  repo: string,
  targetDirectory: string,
  cloneProtocol?: WorkspaceGithubCloneProtocol,
) => Promise<boolean> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (repo: string, targetDirectory: string, cloneProtocol?: WorkspaceGithubCloneProtocol) => {
      return openGithubRepoDirectly({
        serverId: normalizedServerId,
        repo,
        targetDirectory,
        ...(cloneProtocol ? { cloneProtocol } : {}),
        isConnected,
        client,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
        navigateToWorkspace,
      });
    },
    [client, isConnected, mergeWorkspaces, normalizedServerId, setHasHydratedWorkspaces],
  );
}
