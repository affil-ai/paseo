import { useQuery } from "@tanstack/react-query";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { fetchAgentHistoryPage } from "@/hooks/use-agent-history";
import {
  closedWorkspaceChatsQueryKey,
  collectClosedWorkspaceChats,
} from "./closed-workspace-chats";

export { closedWorkspaceChatsQueryKey } from "./closed-workspace-chats";

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
 * workspace the user is looking at. Every history page is consumed so older
 * agents cannot fall out of the recovery list behind unrelated global history.
 * `enabled` is wired to the dropdown's open state so we only pay for the fetch
 * when the menu is shown.
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
    staleTime: 0,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      return collectClosedWorkspaceChats({
        workspaceId,
        fetchPage: (cursor) => fetchAgentHistoryPage({ client, serverId, cursor }),
      });
    },
  });

  return {
    chats: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
