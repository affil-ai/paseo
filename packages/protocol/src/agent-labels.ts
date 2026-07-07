export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const CHAT_THREAD_ID_LABEL = "paseo.chat-thread-id";
export const CHAT_SOURCE_LABEL = "paseo.chat-source";

export const CHAT_USER_MESSAGE_SOURCES = ["slack", "support"] as const;
export type ChatUserMessageSource = (typeof CHAT_USER_MESSAGE_SOURCES)[number];

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

export function getChatUserMessageSourceFromLabels(
  labels: Record<string, unknown> | null | undefined,
): ChatUserMessageSource | null {
  const source = labels?.[CHAT_SOURCE_LABEL];
  if (CHAT_USER_MESSAGE_SOURCES.includes(source as ChatUserMessageSource)) {
    return source as ChatUserMessageSource;
  }

  const threadId = getChatThreadIdFromLabels(labels);
  return threadId?.startsWith("slack:") === true ? "slack" : null;
}

export function isChatOfficeAgent(agent: AgentLabelSource): boolean {
  return getChatThreadIdFromLabels(agent.labels) !== null && !isDelegatedAgent(agent);
}
