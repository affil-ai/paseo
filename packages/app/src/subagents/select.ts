import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface SubagentRow {
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  status: Agent["status"];
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
}

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

interface SelectSubagentsParams {
  serverId: string;
  parentAgentId: string;
}

const EMPTY_SUBAGENT_ROWS: SubagentRow[] = [];

function toSubagentRow(agent: Agent): SubagentRow {
  return {
    id: agent.id,
    provider: agent.provider,
    title: agent.title,
    status: agent.status,
    requiresAttention: agent.requiresAttention,
    createdAt: agent.createdAt,
  };
}

export function selectSubagentsForParent(
  state: SessionStoreSnapshot,
  params: SelectSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentRow[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (
      agent.archivedAt ||
      pendingArchiveIds.has(agent.id) ||
      agent.parentAgentId !== params.parentAgentId
    ) {
      continue;
    }
    rows.push(toSubagentRow(agent));
  }

  if (rows.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

export function useSubagentsForParent(params: SelectSubagentsParams): SubagentRow[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentsForParent(state, params, pendingArchiveIds),
    equal,
  );
}

interface SelectWorkspaceSubagentsParams {
  serverId: string;
  workspaceId: string;
}

// Subagents (any agent with a parentAgentId) that belong to this workspace,
// regardless of which parent they hang off. Scoped by workspaceId the same way
// workspace-tabs/agent-visibility scopes agents. Used by the workspace-level
// Subagents explorer tab, which may span several parents.
export function selectSubagentsForWorkspace(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentRow[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }
  const workspaceId = normalizeWorkspaceOpaqueId(params.workspaceId);
  if (!workspaceId) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (
      agent.archivedAt ||
      pendingArchiveIds.has(agent.id) ||
      !agent.parentAgentId ||
      normalizeWorkspaceOpaqueId(agent.workspaceId) !== workspaceId
    ) {
      continue;
    }
    rows.push(toSubagentRow(agent));
  }

  if (rows.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

export function useSubagentsForWorkspace(params: SelectWorkspaceSubagentsParams): SubagentRow[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentsForWorkspace(state, params, pendingArchiveIds),
    equal,
  );
}
