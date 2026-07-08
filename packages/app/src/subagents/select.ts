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

// Subagents surfaced by the workspace-level Subagents explorer tab. A subagent
// is scoped to a workspace by its PARENT RELATIONSHIP, not by its own
// workspaceId: when a parent (e.g. the office agent) delegates work, the child
// runs in its OWN fresh worktree, so the child's workspaceId is that worktree,
// while parentAgentId points back at the parent. The user expects to open the
// PARENT's workspace and see the children it spawned there.
//
// Membership is the union of:
//   (a) the child's parent agent belongs to this workspace
//       (parent.workspaceId === workspaceId) — the primary, cross-workspace
//       case; mirrors how SubagentsTrack groups children under their parent;
//   (b) the child's own workspaceId === this workspace — a locally-run subagent,
//       kept so the child's own worktree still lists it and nothing regresses.
//
// Multi-level delegation: we only match against the DIRECT parent. A grandchild
// surfaces in the workspace whose agent is its direct parent (case a) or in its
// own worktree (case b); we deliberately do not walk the whole delegation chain
// to attribute deep descendants to a top-level ancestor's workspace.
export function selectSubagentsForWorkspace(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentRow[] {
  const session = state.sessions[params.serverId];
  const agents = session?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }
  const workspaceId = normalizeWorkspaceOpaqueId(params.workspaceId);
  if (!workspaceId) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const agentDetails = session?.agentDetails;
  const resolveParentWorkspaceId = (parentAgentId: string): string | null => {
    const parent = agents.get(parentAgentId) ?? agentDetails?.get(parentAgentId) ?? null;
    return parent ? normalizeWorkspaceOpaqueId(parent.workspaceId) : null;
  };

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt || pendingArchiveIds.has(agent.id) || !agent.parentAgentId) {
      continue;
    }
    const parentInWorkspace = resolveParentWorkspaceId(agent.parentAgentId) === workspaceId;
    const childInWorkspace = normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
    if (!parentInWorkspace && !childInWorkspace) {
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
