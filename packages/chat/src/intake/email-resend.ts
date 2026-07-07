import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { SenderIdentity } from "./slack.js";

const RESEND_API_BASE_URL = "https://api.resend.com";
const SLACK_PREVIEW_MAX_CHARS = 2800;
const MAX_INLINE_IMAGES = 4;

export interface ResendReceivedEmailWebhook {
  readonly type?: unknown;
  readonly data?: {
    readonly email_id?: unknown;
  };
}

export interface ResendReceivedEmail {
  readonly source?: "resend";
  readonly id: string;
  readonly to?: readonly string[];
  readonly from?: string;
  readonly created_at?: string;
  readonly subject?: string | null;
  readonly html?: string | null;
  readonly text?: string | null;
  readonly headers?: Record<string, string>;
  readonly bcc?: readonly string[];
  readonly cc?: readonly string[];
  readonly reply_to?: readonly string[];
  readonly message_id?: string | null;
  readonly attachments?: ReadonlyArray<{
    readonly id?: string;
    readonly filename?: string | null;
    readonly content_type?: string | null;
    readonly content_disposition?: string | null;
    readonly content_id?: string | null;
  }>;
}

export interface EmailIntakeContext {
  readonly supportAddress?: string | undefined;
}

export interface StoredEmailAttachment {
  readonly kind: "stored";
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly sizeBytes: number;
  readonly localPath: string;
}

export interface FailedEmailAttachment {
  readonly kind: "failed";
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly error: string;
}

export type ProcessedEmailAttachment = StoredEmailAttachment | FailedEmailAttachment;

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Webhook decoding & Svix signature verification -------------------------

export function decodeResendWebhook(payload: ResendReceivedEmailWebhook) {
  if (payload.type !== undefined && payload.type !== "email.received") {
    return { type: "ignored" as const, reason: `ignored_event_type:${String(payload.type)}` };
  }

  const emailId = payload.data?.email_id;
  if (typeof emailId !== "string" || emailId.trim().length === 0) {
    return { type: "ignored" as const, reason: "missing_email_id" };
  }

  return { type: "email.received" as const, emailId };
}

function getHeaderValue(
  headers: Readonly<Record<string, string | undefined>>,
  target: string,
): string | undefined {
  const normalizedTarget = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

function parseResendSignatures(signatureHeader: string): string[] {
  const tokens = signatureHeader
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const signatures: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token === "v1" && i + 1 < tokens.length) {
      signatures.push(tokens[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token.startsWith("v1=")) {
      signatures.push(token.slice("v1=".length));
      continue;
    }
    if (token.startsWith("v1,")) {
      signatures.push(token.slice("v1,".length));
    }
  }
  return signatures.filter(Boolean);
}

function secretBytes(secret: string): Buffer {
  return Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    "base64",
  );
}

export function verifyResendWebhookSignature(input: {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly secret: string;
}): void {
  const id = getHeaderValue(input.headers, "svix-id");
  const timestamp = getHeaderValue(input.headers, "svix-timestamp");
  const signatureHeader = getHeaderValue(input.headers, "svix-signature");
  if (id === undefined || timestamp === undefined || signatureHeader === undefined) {
    throw new Error("Missing Resend webhook signature headers.");
  }
  const expected = createHmac("sha256", secretBytes(input.secret))
    .update(`${id}.${timestamp}.${input.body}`)
    .digest();
  const signatures = parseResendSignatures(signatureHeader);
  for (const signature of signatures) {
    const actual = Buffer.from(signature, "base64");
    if (actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)) {
      return;
    }
  }
  throw new Error("Invalid Resend webhook signature.");
}

// --- Body & text handling ----------------------------------------------------

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function emailBody(email: ResendReceivedEmail): string {
  const text = email.text?.trim();
  if (text) return text;

  const html = email.html?.trim();
  if (html) return htmlToText(html);

  return "(empty email body)";
}

export function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const suffix = "\n...[truncated]";
  if (maxLength <= suffix.length) return suffix.slice(0, maxLength);
  return `${input.slice(0, maxLength - suffix.length)}${suffix}`;
}

function shouldCutAtForwardHeader(lines: readonly string[], index: number): boolean {
  const line = lines[index]?.trim() ?? "";
  if (!/^from:\s+/i.test(line)) return false;
  const window = lines.slice(index, index + 8).join("\n");
  return /\n(?:sent|date|to|subject):\s+/i.test(window);
}

export function stripQuotedEmailChain(body: string): string {
  const lines = body.split(/\r?\n/);
  let lastMeaningfulLine = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const hasPriorBody = lastMeaningfulLine >= 0;
    const quoteMarker =
      /^on .+ wrote:$/i.test(trimmed) ||
      /^[-_ ]*original message[-_ ]*$/i.test(trimmed) ||
      /^[-_ ]*forwarded message[-_ ]*$/i.test(trimmed) ||
      /^begin forwarded message:?$/i.test(trimmed) ||
      (trimmed.startsWith(">") && hasPriorBody) ||
      (hasPriorBody && shouldCutAtForwardHeader(lines, index));

    if (quoteMarker && hasPriorBody) {
      return lines.slice(0, index).join("\n").trim();
    }

    if (trimmed.length > 0 && !trimmed.startsWith(">")) {
      lastMeaningfulLine = index;
    }
  }

  return body.trim();
}

// --- Addresses & identities --------------------------------------------------

export function normalizeEmailAddress(value: string): string | undefined {
  const match = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i.exec(value);
  return match?.[1]?.toLowerCase();
}

function emailAddressesFromText(value: string | undefined): string[] {
  if (value === undefined) return [];

  const addresses = new Set<string>();
  for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const normalized = normalizeEmailAddress(match[0]);
    if (normalized !== undefined) addresses.add(normalized);
  }
  return [...addresses];
}

function emailHeaderValue(email: ResendReceivedEmail, name: string): string | undefined {
  const headers = email.headers ?? {};
  const header = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  );
  return header?.[1];
}

function emailHeaderValues(email: ResendReceivedEmail, names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const value = emailHeaderValue(email, name)?.trim();
    return value && value.length > 0 ? [value] : [];
  });
}

function isSupportAddress(address: string, context: EmailIntakeContext): boolean {
  const supportAddress = context.supportAddress?.toLowerCase();
  return supportAddress !== undefined && address === supportAddress;
}

function internalDomain(context: EmailIntakeContext): string | undefined {
  const [, domain] = (context.supportAddress ?? "").split("@");
  return domain ? domain.toLowerCase() : undefined;
}

function isInternalEmailAddress(address: string, context: EmailIntakeContext): boolean {
  const domain = internalDomain(context);
  const [, addressDomain] = address.split("@");
  return domain !== undefined && addressDomain?.toLowerCase() === domain;
}

export function emailSenderIdentity(email: ResendReceivedEmail): SenderIdentity {
  return emailSenderIdentityForContext(email);
}

export function emailSenderIdentityForContext(
  email: ResendReceivedEmail,
  context: EmailIntakeContext = {},
): SenderIdentity {
  const from = email.from?.trim() ?? "";
  const fromAddress = normalizeEmailAddress(from);
  const originalSender = [
    ...emailHeaderValues(email, [
      "x-original-from",
      "x-original-sender",
      "x-forwarded-for",
      "resent-from",
      "reply-to",
      "from",
    ]),
    ...(email.reply_to ?? []),
  ].find((value) => {
    const address = normalizeEmailAddress(value);
    return (
      address !== undefined &&
      !isSupportAddress(address, context) &&
      !isInternalEmailAddress(address, context)
    );
  });
  const selected =
    fromAddress !== undefined &&
    (isSupportAddress(fromAddress, context) || isInternalEmailAddress(fromAddress, context)) &&
    originalSender
      ? originalSender
      : from;
  const address =
    normalizeEmailAddress(selected) ?? normalizeEmailAddress(from) ?? "unknown-sender";
  const name =
    selected
      .replace(/<[^>]*>/g, "")
      .replace(/["']/g, "")
      .trim() || address;
  return { userId: address, name };
}

// --- Thread-linking external ids ----------------------------------------------

function externalParticipantAddresses(
  email: ResendReceivedEmail,
  context: EmailIntakeContext,
): string[] {
  const values = [
    email.from,
    ...(email.to ?? []),
    ...(email.cc ?? []),
    ...(email.reply_to ?? []),
    ...emailHeaderValues(email, [
      "from",
      "reply-to",
      "x-original-from",
      "x-original-sender",
      "x-forwarded-for",
      "resent-from",
      "return-path",
    ]),
    ...emailAddressesFromText(email.text ?? undefined),
    ...emailAddressesFromText(email.html ?? undefined),
  ];
  const addresses = new Set<string>();
  for (const value of values) {
    for (const address of emailAddressesFromText(value ?? undefined)) {
      if (!isSupportAddress(address, context) && !isInternalEmailAddress(address, context)) {
        addresses.add(address);
      }
    }
  }
  return [...addresses].sort();
}

function normalizedConversationSubject(email: ResendReceivedEmail): string | undefined {
  const subject = email.subject?.trim();
  if (!subject) return undefined;

  const normalized = subject
    .replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function isForwardLikeEmail(email: ResendReceivedEmail): boolean {
  const subject = email.subject ?? "";
  if (/^\s*(?:fw|fwd)\s*:/i.test(subject)) return true;

  const body = `${email.text ?? ""}\n${email.html ?? ""}`;
  return /forwarded message|begin forwarded message|original message/i.test(body);
}

function hasReplyLikeSubject(email: ResendReceivedEmail): boolean {
  return /^\s*re\s*:/i.test(email.subject ?? "");
}

export function isFromInternalSender(
  email: ResendReceivedEmail,
  context: EmailIntakeContext,
): boolean {
  const sender = normalizeEmailAddress(email.from ?? "");
  return sender !== undefined && isInternalEmailAddress(sender, context);
}

function conversationExternalIds(
  email: ResendReceivedEmail,
  context: EmailIntakeContext,
): string[] {
  const subject = normalizedConversationSubject(email);
  if (subject === undefined) return [];

  return externalParticipantAddresses(email, context).map(
    (address) => `conversation:${address}:${subject}`,
  );
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
}

function messageIdExternalId(messageId: string): string {
  return `message:${normalizeMessageId(messageId)}`;
}

function messageIdsFromHeader(value: string | undefined): string[] {
  if (value === undefined) return [];

  const ids = new Set<string>();
  for (const match of value.matchAll(/<([^>]+)>/g)) {
    const normalized = normalizeMessageId(match[1] ?? "");
    if (normalized.length > 0) ids.add(messageIdExternalId(normalized));
  }

  if (ids.size === 0) {
    for (const part of value.split(/\s+/)) {
      const normalized = normalizeMessageId(part);
      if (normalized.includes("@")) ids.add(messageIdExternalId(normalized));
    }
  }

  return [...ids];
}

function ownExternalIds(email: ResendReceivedEmail): string[] {
  const ids = new Set<string>();
  const messageIds = [
    email.message_id ?? emailHeaderValue(email, "message-id"),
    ...emailHeaderValues(email, [
      "x-original-message-id",
      "x-forwarded-message-id",
      "resent-message-id",
    ]),
  ];
  for (const messageId of messageIds) {
    if (messageId === undefined) continue;
    for (const id of messageIdsFromHeader(messageId)) {
      ids.add(id);
    }
  }
  ids.add(`resend:${email.id}`);
  return [...ids];
}

export function supportEmailDuplicateExternalIds(email: ResendReceivedEmail): string[] {
  return ownExternalIds(email);
}

export function supportEmailStoredExternalIds(
  email: ResendReceivedEmail,
  context: EmailIntakeContext,
): string[] {
  return [...new Set([...ownExternalIds(email), ...conversationExternalIds(email, context)])];
}

export function supportEmailReferencedExternalIds(email: ResendReceivedEmail): string[] {
  const ids = new Set<string>();
  for (const headerName of ["in-reply-to", "references"]) {
    for (const id of messageIdsFromHeader(emailHeaderValue(email, headerName))) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function supportEmailLookupExternalIds(
  email: ResendReceivedEmail,
  context: EmailIntakeContext,
): string[] {
  const shouldUseConversationFallback =
    hasReplyLikeSubject(email) ||
    (isFromInternalSender(email, context) && isForwardLikeEmail(email));
  return [
    ...new Set([
      ...supportEmailReferencedExternalIds(email),
      ...ownExternalIds(email),
      ...(shouldUseConversationFallback ? conversationExternalIds(email, context) : []),
    ]),
  ];
}

export function formatFollowupEmailForAgent(
  email: ResendReceivedEmail,
  attachments: readonly ProcessedEmailAttachment[] = [],
): string {
  return [
    `Subject: ${email.subject ?? "(no subject)"}`,
    ...(email.created_at !== undefined ? [`Date: ${email.created_at}`] : []),
    "",
    stripQuotedEmailChain(emailBody(email)),
    ...attachmentLines(attachments),
  ].join("\n");
}

// --- Formatting for the agent & Slack -----------------------------------------

function identityHeaderLines(email: ResendReceivedEmail): string[] {
  const lines = [
    ["Header-From", emailHeaderValue(email, "from")],
    ["Header-Reply-To", emailHeaderValue(email, "reply-to")],
    ["Header-X-Original-From", emailHeaderValue(email, "x-original-from")],
    ["Header-X-Original-Sender", emailHeaderValue(email, "x-original-sender")],
  ].flatMap(([label, value]) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? [`${label}: ${trimmed}`] : [];
  });

  return lines.length > 0 ? ["", "Email identity headers:", ...lines] : [];
}

function attachmentLines(attachments: readonly ProcessedEmailAttachment[]): string[] {
  if (attachments.length === 0) return [];

  return [
    "",
    "Attachments:",
    ...attachments.map((attachment) => {
      const type = attachment.mimeType?.trim();
      if (attachment.kind === "failed") {
        return type
          ? `- ${attachment.name} (${type}): failed to download (${attachment.error})`
          : `- ${attachment.name}: failed to download (${attachment.error})`;
      }

      const size = Number.isFinite(attachment.sizeBytes) ? `, ${attachment.sizeBytes} bytes` : "";
      return type
        ? `- ${attachment.name} (${type}${size}): ${attachment.localPath}`
        : `- ${attachment.name}${size}: ${attachment.localPath}`;
    }),
  ];
}

export function formatSupportEmailForAgent(
  email: ResendReceivedEmail,
  attachments: readonly ProcessedEmailAttachment[] = [],
  context: EmailIntakeContext = {},
): string {
  return [
    `From: ${email.from ?? "(unknown sender)"}`,
    ...(email.reply_to !== undefined && email.reply_to.length > 0
      ? [`Reply-To: ${email.reply_to.join(", ")}`]
      : []),
    `To: ${(email.to ?? [context.supportAddress ?? "(unknown recipient)"]).join(", ")}`,
    ...(email.cc !== undefined && email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    ...(email.created_at !== undefined ? [`Date: ${email.created_at}`] : []),
    `Subject: ${email.subject ?? "(no subject)"}`,
    ...identityHeaderLines(email),
    "",
    emailBody(email),
    ...attachmentLines(attachments),
  ].join("\n");
}

export function supportEmailTitle(email: ResendReceivedEmail): string {
  const subject = email.subject?.trim();
  return subject && subject.length > 0 ? `Support: ${subject}` : "Support email triage";
}

export function supportEmailSlackTitle(
  email: ResendReceivedEmail,
  context: EmailIntakeContext = {},
): string {
  const sender = emailSenderIdentityForContext(email, context).userId;
  return `New support email from ${sender}: ${email.subject ?? "(no subject)"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function slackAttachmentSummary(attachments: readonly ProcessedEmailAttachment[]): string[] {
  if (attachments.length === 0) return [];
  const visible = attachments.slice(0, 5).map((attachment) => {
    const type = attachment.mimeType?.trim();
    if (attachment.kind === "failed") {
      return type
        ? `- ${attachment.name} (${type}): failed to download`
        : `- ${attachment.name}: failed to download`;
    }
    return type
      ? `- ${attachment.name} (${type}, ${formatBytes(attachment.sizeBytes)})`
      : `- ${attachment.name} (${formatBytes(attachment.sizeBytes)})`;
  });
  const remaining = attachments.length - visible.length;
  return ["", "Attachments:", ...visible, ...(remaining > 0 ? [`- and ${remaining} more`] : [])];
}

export function supportEmailSlackPreview(input: {
  readonly email: ResendReceivedEmail;
  readonly attachments?: readonly ProcessedEmailAttachment[] | undefined;
  readonly context?: EmailIntakeContext | undefined;
}): string {
  const email = input.email;
  const body = stripQuotedEmailChain(emailBody(email));
  const preview = [
    `From: ${email.from ?? "(unknown sender)"}`,
    `To: ${(email.to ?? [input.context?.supportAddress ?? "(unknown recipient)"]).join(", ")}`,
    ...(email.cc !== undefined && email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    ...(email.created_at !== undefined ? [`Date: ${email.created_at}`] : []),
    `Subject: ${email.subject ?? "(no subject)"}`,
    "",
    body,
    ...slackAttachmentSummary(input.attachments ?? []),
  ].join("\n");
  return truncateText(preview, SLACK_PREVIEW_MAX_CHARS);
}

// --- Resend API ---------------------------------------------------------------

async function fetchJson(input: {
  readonly url: string;
  readonly apiKey: string;
}): Promise<unknown> {
  const response = await fetch(input.url, {
    headers: { authorization: `Bearer ${input.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as unknown;
}

function unwrapResendData(body: unknown): unknown {
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as { readonly data?: unknown }).data;
  }
  return body;
}

export async function fetchResendReceivedEmail(input: {
  readonly emailId: string;
  readonly apiKey: string;
}): Promise<ResendReceivedEmail> {
  const body = await fetchJson({
    url: `${RESEND_API_BASE_URL}/emails/receiving/${encodeURIComponent(input.emailId)}`,
    apiKey: input.apiKey,
  });
  const email = unwrapResendData(body);
  if (
    email === null ||
    typeof email !== "object" ||
    typeof (email as { readonly id?: unknown }).id !== "string"
  ) {
    throw new Error("Resend received email response did not include an email id.");
  }
  return email as ResendReceivedEmail;
}

async function fetchResendReceivedEmailAttachment(input: {
  readonly emailId: string;
  readonly attachmentId: string;
  readonly apiKey: string;
}) {
  const body = await fetchJson({
    url: `${RESEND_API_BASE_URL}/emails/receiving/${encodeURIComponent(input.emailId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
    apiKey: input.apiKey,
  });
  const attachment = unwrapResendData(body);
  if (
    attachment === null ||
    typeof attachment !== "object" ||
    typeof (attachment as { readonly download_url?: unknown }).download_url !== "string"
  ) {
    throw new Error("Resend attachment response did not include download_url.");
  }
  return attachment as {
    readonly id?: string;
    readonly filename?: string | null;
    readonly size?: number;
    readonly content_type?: string | null;
    readonly download_url: string;
  };
}

async function downloadAttachmentBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment download failed (${response.status}): ${response.statusText}`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function safePathSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[/\\:*?"<>|]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160);
  return sanitized.length > 0 && sanitized !== "." && sanitized !== ".." ? sanitized : fallback;
}

export interface ProcessedEmailAttachments {
  attachments: ProcessedEmailAttachment[];
  images: Array<{ data: string; mimeType: string }>;
  agentAttachments: AgentAttachment[];
}

export type EmailAttachmentDownloader = (input: {
  readonly email: ResendReceivedEmail;
  readonly attachment: NonNullable<ResendReceivedEmail["attachments"]>[number];
  readonly attachmentId: string;
  readonly fallbackName: string;
  readonly fallbackMimeType: string | undefined;
}) => Promise<{
  readonly bytes: Buffer;
  readonly filename?: string | undefined;
  readonly contentType?: string | undefined;
}>;

async function downloadAndStoreAttachment(input: {
  readonly email: ResendReceivedEmail;
  readonly attachment: NonNullable<ResendReceivedEmail["attachments"]>[number];
  readonly attachmentId: string;
  readonly fallbackName: string;
  readonly fallbackMimeType: string | undefined;
  readonly index: number;
  readonly apiKey?: string | undefined;
  readonly downloader?: EmailAttachmentDownloader | undefined;
  readonly storageDir: string;
  readonly maxUploadBytes: number;
}): Promise<{ stored: StoredEmailAttachment; bytes: Buffer }> {
  const detail = input.downloader
    ? await input.downloader({
        email: input.email,
        attachment: input.attachment,
        attachmentId: input.attachmentId,
        fallbackName: input.fallbackName,
        fallbackMimeType: input.fallbackMimeType,
      })
    : await (async () => {
        if (!input.apiKey) throw new Error("missing Resend API key");
        const resendDetail = await fetchResendReceivedEmailAttachment({
          emailId: input.email.id,
          attachmentId: input.attachmentId,
          apiKey: input.apiKey,
        });
        const downloaded = await downloadAttachmentBytes(resendDetail.download_url);
        return {
          bytes: downloaded.bytes,
          filename: resendDetail.filename?.trim() || undefined,
          contentType:
            resendDetail.content_type?.trim() || downloaded.contentType?.trim() || undefined,
        };
      })();
  const downloaded = { bytes: detail.bytes, contentType: detail.contentType };
  if (downloaded.bytes.byteLength > input.maxUploadBytes) {
    throw new Error(
      `attachment is ${downloaded.bytes.byteLength} bytes (limit ${input.maxUploadBytes})`,
    );
  }
  const mimeType = detail.contentType?.trim() || input.fallbackMimeType;
  const storedName = detail.filename?.trim() || input.fallbackName;
  const emailDir = join(input.storageDir, safePathSegment(input.email.id, "email"));
  const localPath = join(
    emailDir,
    `${String(input.index + 1).padStart(2, "0")}-${safePathSegment(storedName, "attachment")}`,
  );
  await mkdir(emailDir, { recursive: true });
  await writeFile(localPath, downloaded.bytes);

  return {
    stored: {
      kind: "stored",
      id: input.attachmentId,
      name: storedName,
      ...(mimeType !== undefined ? { mimeType } : {}),
      sizeBytes: downloaded.bytes.byteLength,
      localPath,
    },
    bytes: downloaded.bytes,
  };
}

export async function processEmailAttachments(input: {
  readonly email: ResendReceivedEmail;
  readonly apiKey?: string | undefined;
  readonly downloader?: EmailAttachmentDownloader | undefined;
  readonly storageDir: string;
  readonly maxUploadBytes: number;
}): Promise<ProcessedEmailAttachments> {
  const attachments: ProcessedEmailAttachment[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  const agentAttachments: AgentAttachment[] = [];

  for (const [index, attachment] of (input.email.attachments ?? []).entries()) {
    const attachmentId = attachment.id?.trim();
    if (!attachmentId) continue;

    const name =
      attachment.filename?.trim() || attachment.content_id?.trim() || `Attachment ${index + 1}`;
    const fallbackMimeType = attachment.content_type?.trim() || undefined;

    try {
      const { stored, bytes } = await downloadAndStoreAttachment({
        email: input.email,
        attachment,
        attachmentId,
        fallbackName: name,
        fallbackMimeType,
        index,
        apiKey: input.apiKey,
        downloader: input.downloader,
        storageDir: input.storageDir,
        maxUploadBytes: input.maxUploadBytes,
      });
      attachments.push(stored);
      agentAttachments.push({
        type: "uploaded_file",
        id: `email_${randomUUID()}`,
        fileName: safePathSegment(stored.name, "attachment"),
        mimeType: stored.mimeType ?? "application/octet-stream",
        size: stored.sizeBytes,
        path: stored.localPath,
      });
      if (
        images.length < MAX_INLINE_IMAGES &&
        stored.mimeType?.toLowerCase().startsWith("image/") === true
      ) {
        images.push({ data: bytes.toString("base64"), mimeType: stored.mimeType });
      }
    } catch (error) {
      attachments.push({
        kind: "failed",
        id: attachmentId,
        name,
        ...(fallbackMimeType !== undefined ? { mimeType: fallbackMimeType } : {}),
        error: errorSummary(error),
      });
    }
  }

  return { attachments, images, agentAttachments };
}
