import { getChatStartedByFromLabels, type ChatStartedBy } from "@getpaseo/protocol/agent-labels";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  chatStartedBy?: ChatStartedBy | null;
  workspaceOrigin?: "slack" | "support" | "schedule" | null;
}

interface WorkspaceOriginMetadata {
  chatStartedBy: ChatStartedBy | null;
  workspaceOrigin: "slack" | "support" | "schedule";
  createdAt: Date;
}

interface WorkspaceActivityAccumulator {
  rootActivityByWorkspaceId: Map<string, WorkspaceAgentActivity>;
  runningSubagentActivityByWorkspaceId: Map<string, WorkspaceAgentActivity>;
  originByWorkspaceId: Map<string, WorkspaceOriginMetadata>;
  latestActivityAtByWorkspaceId: Map<string, Date>;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const accumulator: WorkspaceActivityAccumulator = {
    rootActivityByWorkspaceId: new Map(),
    runningSubagentActivityByWorkspaceId: new Map(),
    originByWorkspaceId: new Map(),
    latestActivityAtByWorkspaceId: new Map(),
  };

  for (const agent of agents.values()) {
    if (agent.archivedAt || !agent.workspaceId) {
      continue;
    }

    if (agent.parentAgentId) {
      recordRunningSubagentActivity(agent, agents, accumulator);
      continue;
    }
    recordRootActivity(agent, accumulator);
  }

  const activityByWorkspaceId = buildCurrentActivityIndex(accumulator);
  reusePreviousActivityEntries(activityByWorkspaceId, previous);

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function recordRunningSubagentActivity(
  agent: Agent,
  agents: ReadonlyMap<string, Agent>,
  accumulator: WorkspaceActivityAccumulator,
): void {
  if (deriveSidebarStateBucket({ status: agent.status }) !== "running") {
    return;
  }
  const rootParent = getRootParentAgent(agent, agents);
  if (!rootParent?.workspaceId || rootParent.archivedAt) {
    return;
  }
  const currentActivity = accumulator.runningSubagentActivityByWorkspaceId.get(
    rootParent.workspaceId,
  );
  if (currentActivity?.enteredAt && agent.updatedAt <= currentActivity.enteredAt) {
    return;
  }
  accumulator.runningSubagentActivityByWorkspaceId.set(rootParent.workspaceId, {
    agentId: agent.id,
    status: "running",
    enteredAt: agent.updatedAt,
  });
}

function recordRootActivity(agent: Agent, accumulator: WorkspaceActivityAccumulator): void {
  const workspaceId = agent.workspaceId;
  if (!workspaceId) {
    return;
  }
  const origin = resolveWorkspaceOrigin(agent);
  const currentOrigin = accumulator.originByWorkspaceId.get(workspaceId);
  if (origin && (!currentOrigin || agent.createdAt > currentOrigin.createdAt)) {
    accumulator.originByWorkspaceId.set(workspaceId, origin);
  }

  const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
  const latestActivityAt = accumulator.latestActivityAtByWorkspaceId.get(workspaceId);
  if (latestActivityAt && enteredAt <= latestActivityAt) {
    return;
  }
  accumulator.latestActivityAtByWorkspaceId.set(workspaceId, enteredAt);
  accumulator.rootActivityByWorkspaceId.set(workspaceId, {
    agentId: agent.id,
    status: deriveSidebarStateBucket({
      status: agent.status,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    }),
    enteredAt,
  });
}

function resolveWorkspaceOrigin(agent: Agent): WorkspaceOriginMetadata | null {
  const chatStartedBy = getChatStartedByFromLabels(agent.labels);
  if (chatStartedBy) {
    return { chatStartedBy, workspaceOrigin: chatStartedBy.source, createdAt: agent.createdAt };
  }
  const scheduleId = agent.labels["paseo.schedule-id"];
  if (typeof scheduleId !== "string" || scheduleId.trim().length === 0) {
    return null;
  }
  return { chatStartedBy: null, workspaceOrigin: "schedule", createdAt: agent.createdAt };
}

function buildCurrentActivityIndex(
  accumulator: WorkspaceActivityAccumulator,
): Map<string, WorkspaceAgentActivity> {
  const workspaceIds = new Set([
    ...accumulator.rootActivityByWorkspaceId.keys(),
    ...accumulator.runningSubagentActivityByWorkspaceId.keys(),
  ]);
  const result = new Map<string, WorkspaceAgentActivity>();
  for (const workspaceId of workspaceIds) {
    const activity = selectWorkspaceActivity(
      accumulator.rootActivityByWorkspaceId.get(workspaceId),
      accumulator.runningSubagentActivityByWorkspaceId.get(workspaceId),
    );
    if (!activity) {
      continue;
    }
    const origin = accumulator.originByWorkspaceId.get(workspaceId);
    result.set(workspaceId, {
      ...activity,
      ...(origin
        ? {
            chatStartedBy: origin.chatStartedBy,
            workspaceOrigin: origin.workspaceOrigin,
          }
        : {}),
    });
  }
  return result;
}

function reusePreviousActivityEntries(
  next: Map<string, WorkspaceAgentActivity>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): void {
  for (const [workspaceId, activity] of next) {
    const previousActivity = previous?.get(workspaceId);
    if (previousActivity && areWorkspaceActivitiesEquivalent(previousActivity, activity)) {
      next.set(workspaceId, previousActivity);
    }
  }
}

function areWorkspaceActivitiesEquivalent(
  left: WorkspaceAgentActivity,
  right: WorkspaceAgentActivity,
): boolean {
  return (
    left.agentId === right.agentId &&
    left.status === right.status &&
    left.chatStartedBy?.source === right.chatStartedBy?.source &&
    left.chatStartedBy?.userId === right.chatStartedBy?.userId &&
    left.chatStartedBy?.name === right.chatStartedBy?.name &&
    left.chatStartedBy?.handle === right.chatStartedBy?.handle &&
    left.chatStartedBy?.avatarUrl === right.chatStartedBy?.avatarUrl &&
    left.workspaceOrigin === right.workspaceOrigin
  );
}

function selectWorkspaceActivity(
  rootActivity: WorkspaceAgentActivity | undefined,
  runningSubagentActivity: WorkspaceAgentActivity | undefined,
): WorkspaceAgentActivity | undefined {
  if (rootActivity?.status === "attention" && runningSubagentActivity) {
    return runningSubagentActivity;
  }
  if (rootActivity && rootActivity.status !== "done") {
    return rootActivity;
  }
  return runningSubagentActivity ?? rootActivity;
}

function getRootParentAgent(agent: Agent, agents: ReadonlyMap<string, Agent>): Agent | null {
  let current = agents.get(agent.parentAgentId ?? "") ?? null;
  const visited = new Set<string>([agent.id]);
  while (current?.parentAgentId) {
    if (visited.has(current.id)) {
      return null;
    }
    visited.add(current.id);
    current = agents.get(current.parentAgentId) ?? null;
  }
  return current;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
