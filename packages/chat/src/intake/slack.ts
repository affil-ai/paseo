import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { Attachment, Message, Thread } from "chat";

export interface SenderIdentity {
  userId: string;
  name: string;
  handle?: string;
}

export type ThreadCommand = "mute" | "unmute" | "archive" | "escape" | "aside" | null;

export interface NormalizedMessage {
  externalThreadId: string;
  eventId: string;
  cleanedText: string;
  command: ThreadCommand;
  sender: SenderIdentity;
  images: Array<{ data: string; mimeType: string }>;
  attachments: AgentAttachment[];
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
  if (/^(mute|quiet|stop|shut up|silence)\b/.test(cleaned)) return "mute";
  if (/\b(mute|shut up|stop replying|be quiet)\b/.test(cleaned)) return "mute";
  if (/^(unmute|resume replies)\b/.test(cleaned)) return "unmute";
  if (cleaned === "/archive") return "archive";
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

interface NormalizeMessageOptions {
  attachmentDir: string;
}

async function attachmentDataToBuffer(attachment: Attachment): Promise<Buffer | null> {
  const data: unknown =
    attachment.data ?? (attachment.fetchData ? await attachment.fetchData() : null);
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function isImageAttachment(attachment: Attachment): boolean {
  return attachment.type === "image" || Boolean(attachment.mimeType?.startsWith("image/"));
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name : "attachment";
}

function attachmentLabel(attachment: Attachment): string {
  return `${attachment.name ?? attachment.url ?? "attachment"}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}${attachment.url ? `: ${attachment.url}` : ""}`;
}

function appendPreservedLinks(text: string, links: Message["links"]): string {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const link of links ?? []) {
    const url = link.url.trim();
    if (!url || seen.has(url) || text.includes(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  if (urls.length === 0) return text;
  return [text, `Links:\n${urls.map((url) => `- ${url}`).join("\n")}`].filter(Boolean).join("\n\n");
}

async function attachmentToImage(
  attachment: Attachment,
): Promise<{ data: string; mimeType: string } | null> {
  if (!isImageAttachment(attachment)) return null;
  const data = await attachmentDataToBuffer(attachment);
  if (!data) return null;
  return { data: data.toString("base64"), mimeType: attachment.mimeType ?? "image/png" };
}

async function attachmentToUploadedFile(
  attachment: Attachment,
  options: NormalizeMessageOptions,
): Promise<AgentAttachment | null> {
  const data = await attachmentDataToBuffer(attachment);
  if (!data) return null;

  const fileName = sanitizeFileName(attachment.name ?? "attachment");
  const id = `slack_${randomUUID()}`;
  const attachmentDir = join(options.attachmentDir, id);
  const path = join(attachmentDir, fileName);
  await mkdir(attachmentDir, { recursive: true });
  await writeFile(path, data);

  return {
    type: "uploaded_file",
    id,
    fileName,
    mimeType: attachment.mimeType ?? "application/octet-stream",
    size: data.byteLength,
    path,
  };
}

export async function normalizeMessage(
  thread: Thread,
  message: Message,
  options: NormalizeMessageOptions,
): Promise<NormalizedMessage> {
  const images: Array<{ data: string; mimeType: string }> = [];
  const attachments: AgentAttachment[] = [];
  const attachmentLines: string[] = [];
  for (const attachment of message.attachments ?? []) {
    const image = await attachmentToImage(attachment);
    if (image) {
      images.push(image);
      const uploadedImage = await attachmentToUploadedFile(attachment, options);
      if (uploadedImage) {
        attachments.push(uploadedImage);
      }
      continue;
    }

    const uploadedFile = await attachmentToUploadedFile(attachment, options);
    if (uploadedFile) {
      attachments.push(uploadedFile);
      continue;
    }

    attachmentLines.push(`- ${attachmentLabel(attachment)}`);
  }
  const attachmentText =
    attachmentLines.length > 0 ? `Attachments:\n${attachmentLines.join("\n")}` : "";
  const visibleText = [await normalizeMentionsForPrompt(thread, message), attachmentText]
    .filter(Boolean)
    .join("\n\n");
  const cleanedText = appendPreservedLinks(visibleText, message.links);
  const externalThreadId = encodeThreadId(thread, message);
  return {
    externalThreadId,
    eventId: `slack:${externalThreadId}:${message.id}`,
    cleanedText,
    command: parseCommand(message.text),
    sender: await resolveSender(message),
    images,
    attachments,
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

export function shouldIgnoreAuthor(message: Message): boolean {
  return Boolean(message.author.isBot || message.author.isMe);
}
