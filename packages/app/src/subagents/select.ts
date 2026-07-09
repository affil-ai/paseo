import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import { prIdentityKey, type SubagentPrTabInput } from "@/git/explorer-pr-tabs";
import { selectPrHintFromStatus } from "@/git/pr-hint";

export interface SubagentRow {
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  status: Agent["status"];
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
}

export interface SubagentHoverCardDetails extends SubagentRow {
  cwd: Agent["cwd"];
  model: Agent["model"];
  prHint: ReturnType<typeof selectPrHintFromStatus>;
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

// Subagent agents (full records) that belong to a workspace by the SAME
// parent-relationship scoping the Subagents tab uses. A subagent is scoped to a
// workspace by its PARENT RELATIONSHIP, not by its own workspaceId: when a
// parent (e.g. the office agent) delegates work, the child runs in its OWN
// fresh worktree, so the child's workspaceId is that worktree while
// parentAgentId points back at the parent. The user expects to open the
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
//
// Returns agents sorted by createdAt ascending (stable order for both the
// Subagents list and the derived PR tab strip).
function collectWorkspaceSubagentAgents(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): Agent[] {
  const session = state.sessions[params.serverId];
  const agents = session?.agents;
  if (!agents || agents.size === 0) {
    return [];
  }
  const workspaceId = normalizeWorkspaceOpaqueId(params.workspaceId);
  if (!workspaceId) {
    return [];
  }

  const agentDetails = session?.agentDetails;
  const resolveParentWorkspaceId = (parentAgentId: string): string | null => {
    const parent = agents.get(parentAgentId) ?? agentDetails?.get(parentAgentId) ?? null;
    return parent ? normalizeWorkspaceOpaqueId(parent.workspaceId) : null;
  };

  const matches: Agent[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt || pendingArchiveIds.has(agent.id) || !agent.parentAgentId) {
      continue;
    }
    const parentInWorkspace = resolveParentWorkspaceId(agent.parentAgentId) === workspaceId;
    const childInWorkspace = normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
    if (!parentInWorkspace && !childInWorkspace) {
      continue;
    }
    matches.push(agent);
  }

  matches.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return matches;
}

// Subagents surfaced by the workspace-level Subagents explorer tab. See
// `collectWorkspaceSubagentAgents` for the parent-relationship scoping.
export function selectSubagentsForWorkspace(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentRow[] {
  const agents = collectWorkspaceSubagentAgents(state, params, pendingArchiveIds);
  if (agents.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }
  return agents.map(toSubagentRow);
}

export function selectSubagentHoverCardDetailsForWorkspace(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentHoverCardDetails[] {
  const agents = collectWorkspaceSubagentAgents(state, params, pendingArchiveIds);
  if (agents.length === 0) {
    return [];
  }

  const workspaces = state.sessions[params.serverId]?.workspaces;
  return agents.map((agent) => {
    const workspaceKey = resolveWorkspaceMapKeyByIdentity({
      workspaces,
      workspaceId: agent.workspaceId,
    });
    const descriptor = workspaceKey ? workspaces?.get(workspaceKey) : null;
    return {
      id: agent.id,
      provider: agent.provider,
      title: agent.title,
      status: agent.status,
      requiresAttention: agent.requiresAttention,
      createdAt: agent.createdAt,
      cwd: agent.cwd,
      model: agent.model,
      prHint: selectPrHintFromStatus(descriptor?.githubRuntime?.pullRequest),
    };
  });
}

const EMPTY_SUBAGENT_PR_TABS: SubagentPrTabInput[] = [];

// PR tab inputs for a workspace's subagents: one entry per scoped subagent that
// ACTUALLY has a PR. PR identity is read from the subagent's OWN workspace
// descriptor (githubRuntime.pullRequest) already present in the session store,
// so this fires NO new requests — the live PR pane query only runs for the tab
// the user actually opens. Subagents without a PR contribute nothing.
export function selectSubagentPrTabsForWorkspace(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentPrTabInput[] {
  const agents = collectWorkspaceSubagentAgents(state, params, pendingArchiveIds);
  if (agents.length === 0) {
    return EMPTY_SUBAGENT_PR_TABS;
  }

  const workspaces = state.sessions[params.serverId]?.workspaces;
  const tabs: SubagentPrTabInput[] = [];
  for (const agent of agents) {
    const workspaceKey = resolveWorkspaceMapKeyByIdentity({
      workspaces,
      workspaceId: agent.workspaceId,
    });
    const descriptor = workspaceKey ? workspaces?.get(workspaceKey) : null;
    const pullRequest = descriptor?.githubRuntime?.pullRequest;
    if (!pullRequest) {
      continue;
    }
    const prHint = selectPrHintFromStatus(pullRequest);
    if (!prHint) {
      continue;
    }
    tabs.push({
      subagentId: agent.id,
      subagentTitle: agent.title,
      provider: agent.provider,
      cwd: agent.cwd,
      prNumber: prHint.number,
      repoOwner:
        pullRequest.repoOwner && pullRequest.repoOwner.length > 0 ? pullRequest.repoOwner : null,
      repoName:
        pullRequest.repoName && pullRequest.repoName.length > 0 ? pullRequest.repoName : null,
      prHint,
    });
  }

  if (tabs.length === 0) {
    return EMPTY_SUBAGENT_PR_TABS;
  }
  return tabs;
}

// PR identity for a workspace's OWN checkout, read from its descriptor's
// githubRuntime.pullRequest (same store source as the subagent PR tabs, so no
// new requests). Used to de-dupe the workspace's own PR tab against subagent
// PRs that point at the same PR.
export function selectWorkspaceOwnPrIdentity(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
): { prNumber: number; repoOwner: string | null; repoName: string | null } | null {
  const workspaces = state.sessions[params.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: params.workspaceId,
  });
  const descriptor = workspaceKey ? workspaces?.get(workspaceKey) : null;
  const pullRequest = descriptor?.githubRuntime?.pullRequest;
  if (!pullRequest) {
    return null;
  }
  const prNumber = resolvePrNumber(pullRequest);
  if (prNumber === null) {
    return null;
  }
  return {
    prNumber,
    repoOwner:
      pullRequest.repoOwner && pullRequest.repoOwner.length > 0 ? pullRequest.repoOwner : null,
    repoName: pullRequest.repoName && pullRequest.repoName.length > 0 ? pullRequest.repoName : null,
  };
}

export function useWorkspaceOwnPrIdentity(
  params: SelectWorkspaceSubagentsParams,
): { prNumber: number; repoOwner: string | null; repoName: string | null } | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceOwnPrIdentity(state, params),
    equal,
  );
}

interface PullRequestLike {
  number?: number;
  url: string;
  repoOwner?: string;
  repoName?: string;
}

function resolvePrNumber(pullRequest: PullRequestLike): number | null {
  if (typeof pullRequest.number === "number" && Number.isFinite(pullRequest.number)) {
    return pullRequest.number;
  }
  return parsePrNumberFromUrl(pullRequest.url);
}

function parsePrNumberFromUrl(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function useSubagentsForWorkspace(params: SelectWorkspaceSubagentsParams): SubagentRow[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentsForWorkspace(state, params, pendingArchiveIds),
    equal,
  );
}

export function useSubagentHoverCardDetailsForWorkspace(
  params: SelectWorkspaceSubagentsParams,
): SubagentHoverCardDetails[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentHoverCardDetailsForWorkspace(state, params, pendingArchiveIds),
    equal,
  );
}

export function useSubagentPrTabsForWorkspace(
  params: SelectWorkspaceSubagentsParams,
): SubagentPrTabInput[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentPrTabsForWorkspace(state, params, pendingArchiveIds),
    equal,
  );
}

// Resolve a persisted/deep-linked PR identity to the checkout cwd it should open
// for a workspace, using the live PR set (workspace's own PR + subagent PRs).
// Returns:
//   - { prCwd: null } when the identity matches the workspace's own PR;
//   - { prCwd: <cwd> } when it matches a subagent PR;
//   - null when no live PR matches (caller decides the fallback).
// Pure over a session snapshot so it runs outside React (deep-link consumption).
export function resolveWorkspacePrCwdForIdentity(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams & { prIdentityKey: string },
  pendingArchiveIds: ReadonlySet<string>,
): { prCwd: string | null } | null {
  const workspaceCwd = selectWorkspaceCwd(state, params);
  const workspaceOwnPr = selectWorkspaceOwnPrIdentity(state, params);
  if (workspaceCwd && workspaceOwnPr) {
    const ownKey = prIdentityKey(workspaceOwnPr, workspaceCwd);
    if (ownKey === params.prIdentityKey) {
      return { prCwd: null };
    }
  }
  const subagentPrs = selectSubagentPrTabsForWorkspace(state, params, pendingArchiveIds);
  for (const pr of subagentPrs) {
    if (prIdentityKey(pr, pr.cwd) === params.prIdentityKey) {
      return { prCwd: pr.cwd };
    }
  }
  return null;
}

function selectWorkspaceCwd(
  state: SessionStoreSnapshot,
  params: SelectWorkspaceSubagentsParams,
): string | null {
  const workspaces = state.sessions[params.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: params.workspaceId,
  });
  const descriptor = workspaceKey ? workspaces?.get(workspaceKey) : null;
  return descriptor?.workspaceDirectory || null;
}
