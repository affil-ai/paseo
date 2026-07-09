export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const CHAT_THREAD_ID_LABEL = "paseo.chat-thread-id";
export const CHAT_SOURCE_LABEL = "paseo.chat-source";
export const CHAT_STARTED_BY_SOURCE_LABEL = "paseo.chat-started-by-source";
export const CHAT_STARTED_BY_USER_ID_LABEL = "paseo.chat-started-by-user-id";
export const CHAT_STARTED_BY_NAME_LABEL = "paseo.chat-started-by-name";
export const CHAT_STARTED_BY_HANDLE_LABEL = "paseo.chat-started-by-handle";
export const CHAT_STARTED_BY_AVATAR_URL_LABEL = "paseo.chat-started-by-avatar-url";

export const CHAT_USER_MESSAGE_SOURCES = ["slack", "support"] as const;
export type ChatUserMessageSource = (typeof CHAT_USER_MESSAGE_SOURCES)[number];

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export interface ChatStartedBy {
  source: ChatUserMessageSource;
  userId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
}

function readLabelString(labels: Record<string, unknown> | null | undefined, key: string) {
  const value = labels?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  return readLabelString(labels, PARENT_AGENT_ID_LABEL);
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function getChatThreadIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  return readLabelString(labels, CHAT_THREAD_ID_LABEL);
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

export function getChatStartedByFromLabels(
  labels: Record<string, unknown> | null | undefined,
): ChatStartedBy | null {
  const source = readLabelString(labels, CHAT_STARTED_BY_SOURCE_LABEL);
  const userId = readLabelString(labels, CHAT_STARTED_BY_USER_ID_LABEL);
  const name = readLabelString(labels, CHAT_STARTED_BY_NAME_LABEL);
  const handle = readLabelString(labels, CHAT_STARTED_BY_HANDLE_LABEL);
  const avatarUrl = readLabelString(labels, CHAT_STARTED_BY_AVATAR_URL_LABEL);
  if (!userId || !name || !CHAT_USER_MESSAGE_SOURCES.includes(source as ChatUserMessageSource)) {
    return null;
  }

  return {
    source: source as ChatUserMessageSource,
    userId,
    name,
    ...(handle ? { handle } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}
