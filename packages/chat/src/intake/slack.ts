import type { Attachment, Message, Thread } from "chat";

export interface SenderIdentity {
  userId: string;
  name: string;
  handle?: string;
}

export type ThreadCommand = "mute" | "unmute" | "done" | "escape" | "aside" | null;

export interface NormalizedMessage {
  externalThreadId: string;
  eventId: string;
  cleanedText: string;
  command: ThreadCommand;
  sender: SenderIdentity;
  images: Array<{ data: string; mimeType: string }>;
  attachmentText: string;
}

function slackMessageThreadTs(message: Message): string | null {
  const raw = message.raw;
  if (!raw || typeof raw !== "object") return null;
  const threadTs = (raw as { thread_ts?: unknown }).thread_ts;
  return typeof threadTs === "string" && threadTs ? threadTs : null;
}

function encodeThreadId(thread: Thread, message: Message): string {
  if (thread.isDM && thread.id.endsWith(":")) {
    return `${thread.id}${slackMessageThreadTs(message) ?? message.id}`;
  }
  return thread.id;
}

export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/g, "")
    .replace(/(^|\s)@[UW][A-Z0-9]+\b/g, "$1")
    .replace(/Sent from my .+$/gim, "")
    .trim();
}

async function getSlackUserName(
  thread: Thread,
  userId: string,
  fallback?: string,
): Promise<string> {
  const adapter = thread.adapter as {
    getUser?: (userId: string) => Promise<{ userName?: string; fullName?: string } | null>;
  };
  const user = await adapter.getUser?.(userId).catch(() => null);
  return user?.userName || user?.fullName || fallback || userId;
}

async function normalizeMentionsForPrompt(thread: Thread, message: Message): Promise<string> {
  let text = message.text;
  const raw = message.raw as { text?: unknown } | undefined;
  const rawText = typeof raw?.text === "string" ? raw.text : "";
  const botUserId = (thread.adapter as { botUserId?: string }).botUserId;
  const mentions = [...rawText.matchAll(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g)];

  for (const [, userId, label] of mentions) {
    if (!userId) continue;
    const rawMentionPattern = new RegExp(`<@${userId}(?:\\|[^>]+)?>`, "g");
    const plainMentionPattern = new RegExp(`(^|\\s)@${userId}\\b`, "g");
    if (userId === botUserId) {
      text = text.replace(rawMentionPattern, "").replace(plainMentionPattern, "$1");
      continue;
    }
    const name = await getSlackUserName(thread, userId, label);
    const mention = name.startsWith("@") ? name : `@${name}`;
    text = text.replace(rawMentionPattern, mention).replace(plainMentionPattern, `$1${mention}`);
  }

  return cleanSlackText(text);
}

export function parseCommand(text: string): ThreadCommand {
  const cleaned = cleanSlackText(text).toLowerCase();
  if (/^(mute|quiet)\b/.test(cleaned)) return "mute";
  if (/^(unmute|resume replies)\b/.test(cleaned)) return "unmute";
  if (/^(done|archive)\b/.test(cleaned)) return "done";
  if (/^↑\s*$/.test(cleaned) || /^up\s*$/.test(cleaned)) return "escape";
  if (/^aside\s*-/.test(cleaned)) return "aside";
  return null;
}

export function titleFromText(text: string): string {
  const first = cleanSlackText(text).split("\n").find(Boolean) ?? "Slack task";
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

export async function resolveSender(message: Message): Promise<SenderIdentity> {
  const author = message.author;
  const handle = author.userName || author.userId;
  return {
    userId: author.userId,
    name: author.fullName || handle,
    handle,
  };
}

async function attachmentToImage(
  attachment: Attachment,
): Promise<{ data: string; mimeType: string } | null> {
  if (attachment.type !== "image") return null;
  const mimeType = attachment.mimeType ?? "image/png";
  let data: Buffer | Blob | null = null;
  if (attachment.data instanceof Buffer) {
    data = attachment.data;
  } else if (attachment.fetchData) {
    data = await attachment.fetchData();
  }
  if (!data || !(data instanceof Buffer)) return null;
  return { data: data.toString("base64"), mimeType };
}

export async function normalizeMessage(
  thread: Thread,
  message: Message,
): Promise<NormalizedMessage> {
  const images: Array<{ data: string; mimeType: string }> = [];
  const attachmentLines: string[] = [];
  for (const attachment of message.attachments) {
    const image = await attachmentToImage(attachment);
    if (image) {
      images.push(image);
      continue;
    }
    attachmentLines.push(
      `- ${attachment.name ?? attachment.url ?? "attachment"}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}${attachment.url ? `: ${attachment.url}` : ""}`,
    );
  }
  const attachmentText =
    attachmentLines.length > 0 ? `Attachments:\n${attachmentLines.join("\n")}` : "";
  const cleanedText = [await normalizeMentionsForPrompt(thread, message), attachmentText]
    .filter(Boolean)
    .join("\n\n");
  const externalThreadId = encodeThreadId(thread, message);
  return {
    externalThreadId,
    eventId: `slack:${externalThreadId}:${message.id}`,
    cleanedText,
    command: parseCommand(message.text),
    sender: await resolveSender(message),
    images,
    attachmentText,
  };
}

export async function captureThreadContext(
  thread: Thread,
  triggeringMessageId: string,
): Promise<string> {
  const lines: string[] = [];
  let count = 0;
  for await (const message of thread.allMessages) {
    if (message.id === triggeringMessageId) continue;
    if (message.author.isBot || message.author.isMe) continue;
    const text = cleanSlackText(message.text);
    if (!text) continue;
    lines.push(`${message.author.fullName || message.author.userName}: ${text}`);
    count += 1;
    if (count >= 30 || lines.join("\n").length > 8_000) break;
  }
  return lines.join("\n").slice(0, 8_000);
}

export function shouldIgnoreAmbient(
  thread: Thread,
  message: Message,
  hasSession: boolean,
): boolean {
  return !thread.isDM && !hasSession && !message.isMention;
}
