export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const CHAT_THREAD_ID_LABEL = "paseo.chat-thread-id";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function getChatThreadIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const threadId = labels?.[CHAT_THREAD_ID_LABEL];
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

export function isChatOfficeAgent(agent: AgentLabelSource): boolean {
  return getChatThreadIdFromLabels(agent.labels) !== null && !isDelegatedAgent(agent);
}
