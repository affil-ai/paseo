import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { shouldAutoOpenAgentTab } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
}

function agentBelongsToWorkspace(agent: Agent, workspaceId: string): boolean {
  return normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
    };
  }

  // Resolve parents across the entire session (not just this workspace) so we
  // can tell whether a subagent's parent will ever open a root tab here.
  const allAgentsById = collectAllAgentsById(sessionAgents, agentDetails);

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  // Active subagents (agents with a parentAgentId) belonging to this workspace
  // whose parent will NOT open a root tab here. Used as a fallback so a
  // subagent-only workspace (e.g. the office agent delegating into a fresh
  // worktree) still opens a tab instead of showing an empty pane. Subagents
  // whose parent lives in this same workspace are excluded — the parent's tab
  // (and its track) is their home.
  const orphanedSubagents: Agent[] = [];
  for (const agent of sessionAgents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId)) {
      continue;
    }
    knownAgentIds.add(agent.id);
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      if (shouldAutoOpenAgentTab(agent)) {
        autoOpenAgentIds.add(agent.id);
      } else if (!parentOpensRootTabInWorkspace(agent, allAgentsById, workspaceId)) {
        orphanedSubagents.push(agent);
      }
    }
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId)) {
      continue;
    }
    knownAgentIds.add(agent.id);
  }

  // No auto-openable root agent, but the workspace has active subagents whose
  // parents live elsewhere: open the most recently active one so the pane isn't
  // empty.
  if (autoOpenAgentIds.size === 0 && orphanedSubagents.length > 0) {
    autoOpenAgentIds.add(pickMostRecentlyActive(orphanedSubagents).id);
  }

  return { activeAgentIds, autoOpenAgentIds, knownAgentIds };
}

function collectAllAgentsById(
  sessionAgents: Map<string, Agent> | undefined,
  agentDetails: Map<string, Agent> | undefined,
): Map<string, Agent> {
  const allAgentsById = new Map<string, Agent>();
  for (const agent of sessionAgents?.values() ?? []) {
    allAgentsById.set(agent.id, agent);
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (!allAgentsById.has(agent.id)) {
      allAgentsById.set(agent.id, agent);
    }
  }
  return allAgentsById;
}

function pickMostRecentlyActive(agents: Agent[]): Agent {
  return agents.reduce((newest, candidate) =>
    candidate.lastActivityAt.getTime() > newest.lastActivityAt.getTime() ? candidate : newest,
  );
}

// Whether a subagent's parent will open a root tab in this workspace. When the
// parent isn't loaded yet we assume it will arrive here (matches snapshot
// ingestion order where a child can precede its parent), so we hold off on the
// orphan fallback. When the parent is loaded but belongs to another workspace,
// it will never open a tab here and the subagent is genuinely orphaned.
function parentOpensRootTabInWorkspace(
  agent: Agent,
  allAgentsById: Map<string, Agent>,
  workspaceId: string,
): boolean {
  const parentAgentId = agent.parentAgentId;
  if (!parentAgentId) {
    return false;
  }
  const parent = allAgentsById.get(parentAgentId);
  if (!parent) {
    return true;
  }
  return agentBelongsToWorkspace(parent, workspaceId) && !parent.archivedAt;
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    knownAgentIds: input.agentVisibility.knownAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    setsEqual(a.knownAgentIds, b.knownAgentIds)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}
