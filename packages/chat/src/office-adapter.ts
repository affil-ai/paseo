import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { cardToFallbackText, extractCard, extractFiles } from "@chat-adapter/shared";
import {
  Message,
  markdownToPlainText,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchResult,
  type FormattedContent,
  type RawMessage,
  type ThreadInfo,
  type UserInfo,
  type WebhookOptions,
} from "chat";
import { z } from "zod";
import type { OfficeTurnFailureEvent, OfficeTurnRelayEvent } from "./bridge.js";

const inboundFileSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  downloadUrl: z.url(),
});

const inboundTurnSchema = z.object({
  version: z.literal(1),
  kind: z.literal("message"),
  bindingId: z.string().min(1),
  runId: z.string().min(1),
  receiptId: z.string().min(1),
  providerTurnId: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agentId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  actor: z.object({
    externalUserId: z.string().min(1),
    displayName: z.string().min(1),
    email: z.email().optional(),
  }),
  message: z.object({
    markdown: z.string(),
    files: z.array(inboundFileSchema).max(10),
  }),
  callbackUrl: z.url(),
});

const cancelTurnSchema = z.object({
  version: z.literal(1),
  kind: z.literal("cancel"),
  bindingId: z.string().min(1),
  runId: z.string().min(1),
  receiptId: z.string().min(1),
  agentId: z.string().min(1),
  providerTurnId: z.string().min(1),
});

export type OfficeInboundTurn = z.infer<typeof inboundTurnSchema>;

export interface OfficeTurnRegistration extends OfficeInboundTurn {
  threadId: string;
}

export interface OfficeAdapterConfig {
  inboundToken: string;
  callbackKeyId: string;
  callbackSecret: string;
  onTurnReceived(input: OfficeTurnRegistration): Promise<void>;
  onTurnBound?(input: OfficeTurnRegistration & { agentId: string }): Promise<void>;
  onTurnCompleted?(threadId: string, providerTurnId: string): Promise<void>;
  resolveAgentId(threadId: string): Promise<string | null>;
  resolveTurn?(threadId: string): Promise<OfficeInboundTurn | null>;
  cancelTurn?(input: z.infer<typeof cancelTurnSchema>): Promise<"accepted" | "alreadyCanceled">;
}

interface OfficeThreadId {
  bindingId: string;
}

interface OfficeRawMessage {
  turn: OfficeInboundTurn;
}

function asBuffer(value: Buffer | Blob | ArrayBuffer): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return Promise.resolve(value);
  if (value instanceof Blob) return value.arrayBuffer().then((bytes) => Buffer.from(bytes));
  return Promise.resolve(Buffer.from(value));
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function messageMarkdown(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message && typeof message.markdown === "string") return message.markdown;
  if ("ast" in message) return stringifyMarkdown(message.ast);
  if ("raw" in message && typeof message.raw === "string") return message.raw;
  const card = extractCard(message);
  return card ? cardToFallbackText(card) : "";
}

function fileKind(mimeType: string): "image" | "file" | "video" | "audio" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

export class OfficeAdapter implements Adapter<OfficeThreadId, OfficeRawMessage> {
  readonly name = "office";
  readonly userName = "Office";
  readonly botUserId = "office-agent";

  private chat: ChatInstance | null = null;
  private readonly turns = new Map<string, OfficeInboundTurn>();
  private readonly users = new Map<string, UserInfo>();

  constructor(private readonly config: OfficeAdapterConfig) {}

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  encodeThreadId(input: OfficeThreadId): string {
    return `office:${input.bindingId}`;
  }

  decodeThreadId(threadId: string): OfficeThreadId {
    if (!threadId.startsWith("office:") || threadId.length === "office:".length)
      throw new Error("INVALID_OFFICE_THREAD_ID");
    return { bindingId: threadId.slice("office:".length) };
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(): boolean {
    return true;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (!safeTokenEqual(token, this.config.inboundToken))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!this.chat) return Response.json({ error: "Adapter not initialized" }, { status: 503 });

    try {
      const payload: unknown = await request.json();
      return await this.handleAuthenticatedWebhook(payload, options);
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_OFFICE_EVENT";
      return Response.json({ error: code.slice(0, 100) }, { status: 409 });
    }
  }

  private async handleAuthenticatedWebhook(
    payload: unknown,
    options: WebhookOptions | undefined,
  ): Promise<Response> {
    if (
      payload &&
      typeof payload === "object" &&
      (payload as { kind?: unknown }).kind === "cancel"
    ) {
      const cancellation = cancelTurnSchema.parse(payload);
      if (!this.config.cancelTurn) throw new Error("OFFICE_CANCEL_NOT_CONFIGURED");
      const outcome = await this.config.cancelTurn(cancellation);
      return Response.json({ outcome });
    }
    return this.handleInboundTurn(inboundTurnSchema.parse(payload), options);
  }

  private async handleInboundTurn(
    turn: OfficeInboundTurn,
    options: WebhookOptions | undefined,
  ): Promise<Response> {
    const threadId = this.encodeThreadId({ bindingId: turn.bindingId });
    const activeTurn = this.turns.get(threadId) ?? (await this.config.resolveTurn?.(threadId));
    if (activeTurn?.receiptId === turn.receiptId && activeTurn.payloadDigest !== turn.payloadDigest)
      throw new Error("OFFICE_RECEIPT_CONFLICT");
    const duplicateReceipt = activeTurn?.receiptId === turn.receiptId;
    this.turns.set(threadId, turn);
    this.users.set(turn.actor.externalUserId, {
      userId: turn.actor.externalUserId,
      userName: turn.actor.email ?? turn.actor.displayName,
      fullName: turn.actor.displayName,
      email: turn.actor.email,
      isBot: false,
    });
    await this.config.onTurnReceived({ ...turn, threadId });
    await this.chat!.processMessage(
      this,
      threadId,
      () => Promise.resolve(this.parseMessage({ turn })),
      options,
    );
    const agentId = await this.config.resolveAgentId(threadId);
    if (!agentId) throw new Error("OFFICE_AGENT_NOT_BOUND");
    this.turns.set(threadId, { ...turn, agentId });
    await this.config.onTurnBound?.({ ...turn, threadId, agentId });
    return Response.json({
      outcome: duplicateReceipt ? "alreadyAccepted" : "accepted",
      agentId,
      providerTurnId: turn.providerTurnId,
    });
  }

  parseMessage(raw: OfficeRawMessage): Message<OfficeRawMessage> {
    const { turn } = raw;
    const threadId = this.encodeThreadId({ bindingId: turn.bindingId });
    return new Message({
      id: turn.receiptId,
      threadId,
      text: markdownToPlainText(turn.message.markdown),
      formatted: parseMarkdown(turn.message.markdown),
      raw,
      author: {
        userId: turn.actor.externalUserId,
        userName: turn.actor.email ?? turn.actor.displayName,
        fullName: turn.actor.displayName,
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(), edited: false },
      attachments: turn.message.files.map((file) => ({
        type: fileKind(file.mimeType),
        name: file.filename,
        mimeType: file.mimeType,
        url: file.downloadUrl,
        fetchMetadata: { downloadUrl: file.downloadUrl },
        fetchData: async () => {
          const response = await fetch(file.downloadUrl);
          if (!response.ok) throw new Error(`OFFICE_ATTACHMENT_HTTP_${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        },
      })),
      links: [],
      isMention: !turn.agentId,
    });
  }

  async postTurnEvent(event: OfficeTurnRelayEvent): Promise<RawMessage<OfficeRawMessage>> {
    const turn = await this.requireTurn(event.externalThreadId);
    if (turn.agentId && turn.agentId !== event.agentId) throw new Error("OFFICE_AGENT_MISMATCH");
    const eventId = `${turn.providerTurnId}:auto:${event.phase}:${event.sequence}`;
    await this.sendCallback(turn, {
      version: 1,
      eventId,
      kind: "assistant",
      bindingId: turn.bindingId,
      runId: turn.runId,
      receiptId: turn.receiptId,
      agentId: event.agentId,
      providerTurnId: turn.providerTurnId,
      phase: event.phase,
      sequence: event.sequence,
      message: { markdown: event.text, files: [] },
      terminal: event.terminal,
    });
    if (event.terminal) {
      this.turns.delete(event.externalThreadId);
      await this.config.onTurnCompleted?.(event.externalThreadId, turn.providerTurnId);
    }
    return { id: eventId, threadId: event.externalThreadId, raw: { turn } };
  }

  async postTurnFailure(event: OfficeTurnFailureEvent): Promise<RawMessage<OfficeRawMessage>> {
    const turn = await this.requireTurn(event.externalThreadId);
    if (turn.agentId && turn.agentId !== event.agentId) throw new Error("OFFICE_AGENT_MISMATCH");
    const eventId = `${turn.providerTurnId}:auto:failed`;
    await this.sendCallback(turn, {
      version: 1,
      eventId,
      kind: "failed",
      bindingId: turn.bindingId,
      runId: turn.runId,
      receiptId: turn.receiptId,
      agentId: event.agentId,
      providerTurnId: turn.providerTurnId,
      errorCode: event.errorCode.slice(0, 100) || "OFFICE_RELAY_FAILED",
    });
    this.turns.delete(event.externalThreadId);
    await this.config.onTurnCompleted?.(event.externalThreadId, turn.providerTurnId);
    return { id: eventId, threadId: event.externalThreadId, raw: { turn } };
  }

  async hasActiveTurn(threadId: string): Promise<boolean> {
    return Boolean(this.turns.get(threadId) ?? (await this.config.resolveTurn?.(threadId)));
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<OfficeRawMessage>> {
    const turn = await this.requireTurn(threadId);
    if (!turn.agentId)
      return {
        id: `${turn.providerTurnId}:bridge-notice`,
        threadId,
        raw: { turn },
      };
    const files = await Promise.all(
      extractFiles(message).map(async (file, index) => {
        const bytes = await asBuffer(file.data);
        return {
          id: `chat-send-${index}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`,
          filename: file.filename,
          mimeType: file.mimeType ?? "application/octet-stream",
          size: bytes.byteLength,
          bytesBase64: bytes.toString("base64"),
        };
      }),
    );
    const markdown = messageMarkdown(message);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({ markdown, files: files.map(({ bytesBase64: _bytes, ...file }) => file) }),
      )
      .digest("hex")
      .slice(0, 24);
    const eventId = `${turn.providerTurnId}:chat-send:${digest}`;
    const agentId = turn.agentId ?? (await this.config.resolveAgentId(threadId));
    if (!agentId) throw new Error("OFFICE_AGENT_NOT_BOUND");
    await this.sendCallback(turn, {
      version: 1,
      eventId,
      kind: "assistant",
      bindingId: turn.bindingId,
      runId: turn.runId,
      receiptId: turn.receiptId,
      agentId,
      providerTurnId: turn.providerTurnId,
      phase: "chatSend",
      message: { markdown, files },
      terminal: false,
    });
    return { id: eventId, threadId, raw: { turn } };
  }

  async fetchMessages(): Promise<FetchResult<OfficeRawMessage>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: threadId,
      channelName: this.turns.get(threadId)?.title,
      channelVisibility: "private",
      isDM: true,
      metadata: {},
    };
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    return this.users.get(userId) ?? null;
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async startTyping(): Promise<void> {}
  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {}
  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {}
  async deleteMessage(): Promise<void> {}

  async editMessage(
    threadId: string,
    _messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<OfficeRawMessage>> {
    return this.postMessage(threadId, message);
  }

  private async requireTurn(threadId: string): Promise<OfficeInboundTurn> {
    const turn = this.turns.get(threadId) ?? (await this.config.resolveTurn?.(threadId));
    if (!turn) throw new Error("OFFICE_TURN_NOT_REGISTERED");
    this.turns.set(threadId, turn);
    return turn;
  }

  private async sendCallback(turn: OfficeInboundTurn, event: unknown): Promise<void> {
    const body = JSON.stringify(event);
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", this.config.callbackSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(turn.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-paseo-key-id": this.config.callbackKeyId,
          "x-paseo-timestamp": timestamp,
          "x-paseo-signature": `v1=${signature}`,
        },
        body,
      });
      if (response.ok) return;
      const retryable =
        response.status === 409 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 7) throw new Error(`OFFICE_CALLBACK_HTTP_${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 100 * 2 ** attempt)));
    }
  }
}
