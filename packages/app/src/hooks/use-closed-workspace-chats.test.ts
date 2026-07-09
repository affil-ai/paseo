import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { AgentHistoryPage } from "@/hooks/use-agent-history";
import {
  closedWorkspaceChatsQueryKey,
  collectClosedWorkspaceChats,
  invalidateClosedWorkspaceChatsQueries,
} from "./closed-workspace-chats";

function makeAgent(input: {
  id: string;
  workspaceId: string;
  archivedAt?: Date | null;
  lastActivityAt: Date;
}): AggregatedAgent {
  return {
    id: input.id,
    serverId: "server-a",
    serverLabel: "server-a",
    title: input.id,
    status: "closed",
    lastActivityAt: input.lastActivityAt,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    provider: "codex",
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.lastActivityAt,
    labels: {},
    projectPlacement: null,
  };
}

describe("collectClosedWorkspaceChats", () => {
  it("loads every history page and returns all archived agents from the exact workspace", async () => {
    const workspaceId = "workspace-office-thread";
    const firstPage: AgentHistoryPage = {
      agents: [
        makeAgent({
          id: "newest-closed",
          workspaceId,
          archivedAt: new Date("2026-07-09T16:00:00.000Z"),
          lastActivityAt: new Date("2026-07-09T16:00:00.000Z"),
        }),
        makeAgent({
          id: "other-workspace",
          workspaceId: "workspace-sibling",
          archivedAt: new Date("2026-07-09T15:00:00.000Z"),
          lastActivityAt: new Date("2026-07-09T15:00:00.000Z"),
        }),
      ],
      pageInfo: { hasMore: true, nextCursor: "page-2", prevCursor: null },
    };
    const secondPage: AgentHistoryPage = {
      agents: [
        makeAgent({
          id: "older-closed",
          workspaceId,
          archivedAt: new Date("2026-07-08T16:00:00.000Z"),
          lastActivityAt: new Date("2026-07-08T16:00:00.000Z"),
        }),
        makeAgent({
          id: "still-active",
          workspaceId,
          lastActivityAt: new Date("2026-07-09T17:00:00.000Z"),
        }),
      ],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: "page-2" },
    };
    const fetchPage = vi
      .fn<(cursor: string | null) => Promise<AgentHistoryPage>>()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const chats = await collectClosedWorkspaceChats({ workspaceId, fetchPage });

    expect(fetchPage.mock.calls).toEqual([[null], ["page-2"]]);
    expect(chats.map((chat) => chat.id)).toEqual(["newest-closed", "older-closed"]);
  });

  it("stops if a malformed host repeats the same cursor", async () => {
    const page: AgentHistoryPage = {
      agents: [],
      pageInfo: { hasMore: true, nextCursor: "same-cursor", prevCursor: null },
    };
    const fetchPage = vi.fn(async () => page);

    await collectClosedWorkspaceChats({ workspaceId: "workspace-a", fetchPage });

    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateClosedWorkspaceChatsQueries", () => {
  it("invalidates every workspace history query for the archived agent's host", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(closedWorkspaceChatsQueryKey("server-a", "workspace-1"), []);
    queryClient.setQueryData(closedWorkspaceChatsQueryKey("server-a", "workspace-2"), []);
    queryClient.setQueryData(closedWorkspaceChatsQueryKey("server-b", "workspace-3"), []);

    await invalidateClosedWorkspaceChatsQueries(queryClient, "server-a");

    expect(
      queryClient.getQueryState(closedWorkspaceChatsQueryKey("server-a", "workspace-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(closedWorkspaceChatsQueryKey("server-a", "workspace-2"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(closedWorkspaceChatsQueryKey("server-b", "workspace-3"))
        ?.isInvalidated,
    ).toBe(false);
  });
});
