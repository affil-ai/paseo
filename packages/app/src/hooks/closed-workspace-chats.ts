import type { QueryClient } from "@tanstack/react-query";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { AgentHistoryPage } from "@/hooks/use-agent-history";

const CLOSED_WORKSPACE_CHATS_QUERY_ROOT = ["closedWorkspaceChats"] as const;

export function closedWorkspaceChatsQueryKey(serverId: string, workspaceId: string) {
  return [...CLOSED_WORKSPACE_CHATS_QUERY_ROOT, serverId, workspaceId] as const;
}

export async function collectClosedWorkspaceChats(input: {
  workspaceId: string;
  fetchPage: (cursor: string | null) => Promise<AgentHistoryPage>;
}): Promise<AggregatedAgent[]> {
  const chatsById = new Map<string, AggregatedAgent>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const page = await input.fetchPage(cursor);
    for (const agent of page.agents) {
      if (agent.archivedAt != null && agent.workspaceId === input.workspaceId) {
        chatsById.set(agent.id, agent);
      }
    }

    const nextCursor = page.pageInfo.nextCursor;
    if (!page.pageInfo.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return Array.from(chatsById.values()).sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
  );
}

export function invalidateClosedWorkspaceChatsQueries(
  queryClient: QueryClient,
  serverId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [...CLOSED_WORKSPACE_CHATS_QUERY_ROOT, serverId],
  });
}
