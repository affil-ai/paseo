import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { fetchAgentHistoryPage } from "@/hooks/use-agent-history";

export function closedWorkspaceChatsQueryKey(serverId: string, workspaceId: string) {
  return ["closedWorkspaceChats", serverId, workspaceId] as const;
}

export interface ClosedWorkspaceChatsResult {
  chats: AggregatedAgent[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Closed (archived) chats that belong to a single workspace, newest first.
 *
 * Closing a root-agent tab is a soft delete: the agent record stays on disk
 * with `archivedAt` set (see docs/agent-lifecycle.md). This hook surfaces those
 * records so the tab bar can offer a "reopen" affordance scoped to the
 * workspace the user is looking at. `enabled` is wired to the dropdown's open
 * state so we only pay for the fetch when the menu is shown.
 */
export function useClosedWorkspaceChats(input: {
  serverId: string;
  workspaceId: string;
  enabled: boolean;
}): ClosedWorkspaceChatsResult {
  const { serverId, workspaceId, enabled } = input;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: closedWorkspaceChatsQueryKey(serverId, workspaceId),
    enabled: enabled && Boolean(client) && isConnected,
    staleTime: 10_000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      const page = await fetchAgentHistoryPage({ client, serverId, cursor: null });
      return page.agents;
    },
  });

  const chats = useMemo(() => {
    const agents = query.data ?? [];
    return agents
      .filter((agent) => agent.archivedAt != null && agent.workspaceId === workspaceId)
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }, [query.data, workspaceId]);

  return {
    chats,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
