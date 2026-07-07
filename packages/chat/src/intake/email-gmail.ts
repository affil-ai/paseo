import { auth, gmail_v1 } from "@googleapis/gmail";
import type { GmailChatEmailConfig } from "../config.js";
import type { ThreadSessionStore } from "../state/thread-session-store.js";
import type { EmailWebhookResult } from "./email-bridge.js";
import type { EmailAttachmentDownloader, ResendReceivedEmail } from "./email-resend.js";

const GMAIL_USER_ID = "me";
const WATCH_RENEWAL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_RECENT_MESSAGE_COUNT = 10;

export interface GmailWatchResult {
  historyId: string;
  expiration: string | null;
}

export interface GmailPubSubNotification {
  emailAddress: string;
  historyId: string;
  messageId?: string;
}

export class GmailHistoryExpiredError extends Error {
  constructor(message = "Gmail history is expired or unavailable.") {
    super(message);
    this.name = "GmailHistoryExpiredError";
  }
}

export interface GmailEmailClientLike {
  watch(): Promise<GmailWatchResult>;
  listHistoryMessageIds(startHistoryId: string): Promise<string[]>;
  listRecentMessageIds(maxResults?: number): Promise<string[]>;
  getReceivedEmail(messageId: string): Promise<ResendReceivedEmail>;
  downloadAttachment: EmailAttachmentDownloader;
}

function headerValue(
  headers: readonly gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  return (
    headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
  );
}

function headersRecord(
  headers: readonly gmail_v1.Schema$MessagePartHeader[] | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (!header.name || header.value === undefined || header.value === null) continue;
    output[header.name] = header.value;
  }
  return output;
}

function splitAddressHeader(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function decodeBase64UrlText(value: string | null | undefined): string {
  if (!value) return "";
  return Buffer.from(value, "base64url").toString("utf8");
}

function walkMessageParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  visitor: (part: gmail_v1.Schema$MessagePart) => void,
): void {
  if (!part) return;
  visitor(part);
  for (const child of part.parts ?? []) {
    walkMessageParts(child, visitor);
  }
}

function messageText(
  message: gmail_v1.Schema$Message,
  mimeType: "text/plain" | "text/html",
): string | null {
  const chunks: string[] = [];
  walkMessageParts(message.payload ?? undefined, (part) => {
    if (part.mimeType !== mimeType) return;
    const text = decodeBase64UrlText(part.body?.data);
    if (text.trim()) chunks.push(text);
  });
  return chunks.length > 0 ? chunks.join("\n\n") : null;
}

function messageAttachments(message: gmail_v1.Schema$Message): ResendReceivedEmail["attachments"] {
  const attachments: Array<NonNullable<ResendReceivedEmail["attachments"]>[number]> = [];
  walkMessageParts(message.payload ?? undefined, (part) => {
    const attachmentId = part.body?.attachmentId;
    if (!attachmentId) return;
    const filename = part.filename?.trim();
    const contentId = headerValue(part.headers, "content-id");
    attachments.push({
      id: attachmentId,
      filename: filename || contentId || `gmail-attachment-${attachments.length + 1}`,
      content_type: part.mimeType ?? null,
      content_disposition: headerValue(part.headers, "content-disposition") ?? null,
      content_id: contentId ?? null,
    });
  });
  return attachments;
}

function normalizeGmailMessage(message: gmail_v1.Schema$Message): ResendReceivedEmail {
  if (!message.id) throw new Error("Gmail message did not include an id.");
  const headers = message.payload?.headers ?? [];
  const createdAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : undefined;
  return {
    source: "gmail",
    id: message.id,
    gmailThreadId: message.threadId ?? null,
    from: headerValue(headers, "from"),
    to: splitAddressHeader(headerValue(headers, "to")),
    cc: splitAddressHeader(headerValue(headers, "cc")),
    reply_to: splitAddressHeader(headerValue(headers, "reply-to")),
    subject: headerValue(headers, "subject") ?? null,
    text: messageText(message, "text/plain"),
    html: messageText(message, "text/html"),
    headers: headersRecord(headers),
    message_id: headerValue(headers, "message-id") ?? null,
    attachments: messageAttachments(message),
    ...(createdAt ? { created_at: createdAt } : {}),
  };
}

function isHistoryExpiredError(error: unknown): boolean {
  if (error instanceof GmailHistoryExpiredError) return true;
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; response?: { status?: unknown } };
  return record.code === 404 || record.response?.status === 404;
}

function historyMessageIds(history: readonly gmail_v1.Schema$History[]): string[] {
  const ids: string[] = [];
  for (const item of history) {
    for (const added of item.messagesAdded ?? []) {
      const id = added.message?.id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

export class GmailSupportEmailClient implements GmailEmailClientLike {
  private readonly gmail: gmail_v1.Gmail;

  constructor(private readonly config: GmailChatEmailConfig) {
    const oauth = new auth.OAuth2(config.oauthClientId, config.oauthClientSecret);
    oauth.setCredentials({ refresh_token: config.refreshToken });
    this.gmail = new gmail_v1.Gmail({ auth: oauth });
  }

  async watch(): Promise<GmailWatchResult> {
    const response = await this.gmail.users.watch({
      userId: GMAIL_USER_ID,
      requestBody: {
        topicName: this.config.pubsubTopic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
    const historyId = response.data.historyId;
    if (!historyId) throw new Error("Gmail watch response did not include historyId.");
    return {
      historyId,
      expiration: response.data.expiration ? String(response.data.expiration) : null,
    };
  }

  async listHistoryMessageIds(startHistoryId: string): Promise<string[]> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    try {
      do {
        const response = await this.gmail.users.history.list({
          userId: GMAIL_USER_ID,
          startHistoryId,
          historyTypes: ["messageAdded"],
          pageToken,
        });
        for (const id of historyMessageIds(response.data.history ?? [])) ids.add(id);
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      if (isHistoryExpiredError(error)) throw new GmailHistoryExpiredError();
      throw error;
    }
    return [...ids];
  }

  async listRecentMessageIds(maxResults = FALLBACK_RECENT_MESSAGE_COUNT): Promise<string[]> {
    const response = await this.gmail.users.messages.list({
      userId: GMAIL_USER_ID,
      labelIds: ["INBOX"],
      maxResults,
    });
    return (response.data.messages ?? []).flatMap((message) => (message.id ? [message.id] : []));
  }

  async getReceivedEmail(messageId: string): Promise<ResendReceivedEmail> {
    const response = await this.gmail.users.messages.get({
      userId: GMAIL_USER_ID,
      id: messageId,
      format: "full",
    });
    return normalizeGmailMessage(response.data);
  }

  downloadAttachment: EmailAttachmentDownloader = async (input) => {
    const response = await this.gmail.users.messages.attachments.get({
      userId: GMAIL_USER_ID,
      messageId: input.email.id,
      id: input.attachmentId,
    });
    const data = response.data.data;
    if (!data) throw new Error("Gmail attachment response did not include data.");
    return {
      bytes: Buffer.from(data, "base64url"),
      filename: input.attachment.filename?.trim() || input.fallbackName,
      contentType: input.attachment.content_type?.trim() || input.fallbackMimeType,
    };
  };
}

export function decodeGmailPubSubWebhook(rawBody: string): GmailPubSubNotification {
  const body = JSON.parse(rawBody) as {
    message?: { data?: unknown; messageId?: unknown; message_id?: unknown };
  };
  const encoded = body.message?.data;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("Gmail Pub/Sub payload is missing message.data.");
  }
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    emailAddress?: unknown;
    historyId?: unknown;
  };
  if (typeof decoded.emailAddress !== "string" || typeof decoded.historyId !== "string") {
    throw new Error("Gmail Pub/Sub payload is missing emailAddress or historyId.");
  }
  const pubsubMessageId = body.message?.messageId ?? body.message?.message_id;
  return {
    emailAddress: decoded.emailAddress.toLowerCase(),
    historyId: decoded.historyId,
    ...(typeof pubsubMessageId === "string" ? { messageId: pubsubMessageId } : {}),
  };
}

export function verifyGmailWebhookToken(input: {
  requestUrl: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  expectedToken: string;
}): boolean {
  const headerValueRaw = input.headers["x-paseo-webhook-token"];
  const headerToken = Array.isArray(headerValueRaw) ? headerValueRaw[0] : headerValueRaw;
  if (headerToken === input.expectedToken) return true;
  const url = new URL(input.requestUrl ?? "/", "http://localhost");
  return url.searchParams.get("token") === input.expectedToken;
}

export class GmailEmailIntake {
  private renewalTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly input: {
      config: GmailChatEmailConfig;
      store: ThreadSessionStore;
      client: GmailEmailClientLike;
      handleEmail: (email: ResendReceivedEmail, eventId: string) => Promise<EmailWebhookResult>;
    },
  ) {}

  async start(): Promise<void> {
    this.renewalTimer = setInterval(() => {
      void this.renewWatch().catch((error) => {
        console.error("Gmail watch renewal failed", error);
      });
    }, WATCH_RENEWAL_MS);
    this.renewalTimer.unref?.();
    await this.renewWatch();
  }

  stop(): void {
    if (!this.renewalTimer) return;
    clearInterval(this.renewalTimer);
    this.renewalTimer = null;
  }

  async renewWatch(): Promise<GmailWatchResult> {
    const previous = await this.input.store.getGmailWatch(this.input.config.inboxEmail);
    const watch = await this.input.client.watch();
    if (previous?.historyId && previous.historyId !== watch.historyId) {
      await this.processRange(previous.historyId).catch(async (error) => {
        if (!isHistoryExpiredError(error)) throw error;
        await this.processRecentFallback();
      });
    }
    await this.input.store.putGmailWatch({
      inboxEmail: this.input.config.inboxEmail,
      historyId: watch.historyId,
      expiration: watch.expiration,
    });
    return watch;
  }

  async handleWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    requestUrl?: string,
  ): Promise<EmailWebhookResult> {
    if (
      !verifyGmailWebhookToken({
        requestUrl,
        headers,
        expectedToken: this.input.config.webhookToken,
      })
    ) {
      return { status: 401, body: { error: "Invalid Gmail webhook token" } };
    }

    let notification: GmailPubSubNotification;
    try {
      notification = decodeGmailPubSubWebhook(rawBody);
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    if (notification.emailAddress !== this.input.config.inboxEmail.toLowerCase()) {
      return { status: 200, body: { accepted: true, ignored: true, reason: "wrong_inbox" } };
    }

    const eventId = `gmail:notification:${notification.historyId}`;
    if (await this.input.store.hasEventReceipt(eventId)) {
      return { status: 200, body: { accepted: true, duplicate: true } };
    }

    try {
      const previous = await this.input.store.getGmailWatch(this.input.config.inboxEmail);
      if (previous?.historyId) {
        await this.processRange(previous.historyId).catch(async (error) => {
          if (!isHistoryExpiredError(error)) throw error;
          await this.processRecentFallback();
        });
      } else {
        await this.processRecentFallback();
      }
      await this.input.store.putGmailWatch({
        inboxEmail: this.input.config.inboxEmail,
        historyId: notification.historyId,
        expiration: previous?.expiration ?? null,
      });
      await this.input.store.markEventProcessed(eventId);
      return { status: 200, body: { accepted: true } };
    } catch (error) {
      console.warn("Gmail intake failed", error);
      return {
        status: 500,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private async processRange(startHistoryId: string): Promise<void> {
    await this.processMessageIds(await this.input.client.listHistoryMessageIds(startHistoryId));
  }

  private async processRecentFallback(): Promise<void> {
    await this.processMessageIds(
      await this.input.client.listRecentMessageIds(FALLBACK_RECENT_MESSAGE_COUNT),
    );
  }

  private async processMessageIds(messageIds: readonly string[]): Promise<void> {
    for (const messageId of new Set(messageIds)) {
      const email = await this.input.client.getReceivedEmail(messageId);
      await this.input.handleEmail(email, `email:gmail:${messageId}`);
    }
  }
}

export const gmailTestInternals = {
  normalizeGmailMessage,
};
