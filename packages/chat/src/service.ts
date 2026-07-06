import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterPostableMessage, FileUpload, SentMessage, Thread } from "chat";
import type { ChatBridgeConfig, ResolvedChatBridgeConfig } from "./config.js";
import { slackPostableMessagesFromMarkdown } from "./render.js";
import {
  ChatDestinationSchema,
  getBindingOwnerAgentId,
  type ChatAuditRecord,
  type ChatBinding,
  type ChatDestination,
  type OutboundConversationBinding,
  type PendingRequest,
  type ThreadSessionStore,
} from "./state/thread-session-store.js";

export interface ChatOutboundFile {
  bytesBase64: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface StartConversationInput {
  officeAgentId: string;
  destination: ChatDestination;
  message: string;
  subscribe?: boolean;
  idempotencyKey?: string;
}

export interface ReplyInput {
  officeAgentId: string;
  conversationId?: string;
  message: string;
  files?: ChatOutboundFile[];
  idempotencyKey?: string;
}

export interface SendFileInput {
  officeAgentId: string;
  conversationId?: string;
  destination?: ChatDestination;
  message?: string;
  file: ChatOutboundFile;
  idempotencyKey?: string;
}

export interface AskInput {
  officeAgentId: string;
  destination: ChatDestination;
  question: string;
  timeoutMinutes: number;
  scope: "person" | "channel";
  idempotencyKey?: string;
}

export interface ChatPostResult {
  conversationId: string;
  externalThreadId: string;
  requestId?: string;
  status?: "pending";
  fileId?: string;
}

interface PostableTarget {
  id: string;
  post(message: AdapterPostableMessage): Promise<SentMessage>;
}

interface ChatLike {
  openDM(userId: string): Promise<Thread>;
  channel(channelId: string): PostableTarget;
  thread(threadId: string): Thread;
}

interface ChatServiceDaemonClient {
  sendAgentMessage(agentId: string, message: string): Promise<unknown>;
}

export class ChatToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface ResolvedTarget {
  destination: ChatDestination;
  externalThreadId?: string;
  target: PostableTarget;
  mode: "thread" | "new-thread";
}

function withFilesOnFirstMessage(
  messages: AdapterPostableMessage[],
  files: FileUpload[] | undefined,
): AdapterPostableMessage[] {
  if (!files?.length) return messages;
  const [firstMessage, ...remaining] = messages;
  return [withFiles(firstMessage ?? { markdown: "" }, files), ...remaining];
}

function withFiles(message: AdapterPostableMessage, files: FileUpload[]): AdapterPostableMessage {
  if (typeof message === "string") return { raw: message, files };
  if ("type" in message && message.type === "card") return { card: message, files };
  return { ...message, files };
}

function nowIso(): string {
  return new Date().toISOString();
}

function messagePreview(message: string | undefined): string {
  return (message ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

export function normalizeSlackChannelId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("slack:")) return trimmed;
  return `slack:${trimmed.replace(/^#/, "")}`;
}

function normalizeSlackUserId(value: string): string {
  return value.trim().replace(/^slack:/, "");
}

export function threadIdFromPostedMessage(
  targetId: string,
  sent: Pick<SentMessage, "id" | "threadId">,
): string {
  if (sent.threadId.endsWith(":")) return `${sent.threadId}${sent.id}`;
  if (targetId.endsWith(":")) return `${targetId}${sent.id}`;
  return sent.threadId || targetId;
}

function parseSlackUrl(url: string): { channelId: string; threadId?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const archivesIndex = segments.indexOf("archives");
  const channel = archivesIndex >= 0 ? segments[archivesIndex + 1] : undefined;
  if (!channel) return null;
  const messageSegment = segments[archivesIndex + 2];
  const threadTs = parsed.searchParams.get("thread_ts") ?? undefined;
  if (threadTs)
    return {
      channelId: normalizeSlackChannelId(channel),
      threadId: `slack:${channel}:${threadTs}`,
    };
  if (!messageSegment?.startsWith("p")) return { channelId: normalizeSlackChannelId(channel) };
  const digits = messageSegment.slice(1);
  if (digits.length < 7) return { channelId: normalizeSlackChannelId(channel) };
  const ts = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
  return { channelId: normalizeSlackChannelId(channel), threadId: `slack:${channel}:${ts}` };
}

function auditMessage(
  input: StartConversationInput | ReplyInput | SendFileInput | AskInput,
): string | undefined {
  if ("message" in input) return input.message;
  if ("question" in input) return input.question;
  return undefined;
}

function auditFiles(
  input: StartConversationInput | ReplyInput | SendFileInput | AskInput,
): ChatOutboundFile[] | undefined {
  if ("file" in input) return [input.file];
  if ("files" in input) return input.files;
  return undefined;
}

function auditRecord(input: {
  officeAgentId: string;
  toolName: string;
  destination?: ChatDestination;
  resolvedExternalThreadId?: string;
  conversationId?: string;
  message?: string;
  files?: ChatOutboundFile[];
  result: ChatAuditRecord["result"];
  errorCode?: string;
}): ChatAuditRecord {
  return {
    id: `aud_${randomUUID()}`,
    timestamp: nowIso(),
    officeAgentId: input.officeAgentId,
    toolName: input.toolName,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.resolvedExternalThreadId
      ? { resolvedExternalThreadId: input.resolvedExternalThreadId }
      : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    messagePreview: messagePreview(input.message),
    ...(input.files
      ? {
          files: input.files.map((file) => ({
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
          })),
        }
      : {}),
    result: input.result,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}

export class ChatBridgeService {
  constructor(
    private readonly chat: ChatLike,
    private readonly client: ChatServiceDaemonClient,
    private readonly store: ThreadSessionStore,
    private readonly config: Pick<ChatBridgeConfig, "people" | "channels"> &
      Partial<Pick<ResolvedChatBridgeConfig, "officeRepoPath">>,
  ) {}

  async startConversation(input: StartConversationInput): Promise<ChatPostResult> {
    return this.withAudit("chat.startConversation", input, async () => {
      const cached = await this.getIdempotentResult(input.idempotencyKey);
      if (cached) return cached;
      const resolved = await this.resolveDestination(input.officeAgentId, input.destination, false);
      const existingResolvedBinding = resolved.externalThreadId
        ? await this.store.getBinding(resolved.externalThreadId)
        : null;
      this.assertBindingOwner(input.officeAgentId, existingResolvedBinding);

      const messages = slackPostableMessagesFromMarkdown(input.message);
      const sent = await resolved.target.post(messages[0] ?? { markdown: "" });
      const externalThreadId = threadIdFromPostedMessage(resolved.target.id, sent);
      const existingBinding =
        existingResolvedBinding ?? (await this.store.getBinding(externalThreadId));
      if (existingBinding) {
        this.assertBindingOwner(input.officeAgentId, existingBinding);
        if (input.subscribe ?? true) await this.chat.thread(externalThreadId).subscribe();
        await this.postRemainingMessages(existingBinding.externalThreadId, messages);
        await this.suppressActiveAutoRelay(existingBinding.externalThreadId);
        const result = this.resultFromBinding(existingBinding);
        await this.completeIdempotentResult(input.idempotencyKey, result);
        return result;
      }
      await this.postRemainingMessages(externalThreadId, messages);
      const conversationId = `conv_${randomUUID()}`;
      const binding = this.createOutboundBinding({
        conversationId,
        externalThreadId,
        officeAgentId: input.officeAgentId,
        destination: resolved.destination,
        subscribed: input.subscribe ?? true,
      });
      await this.store.upsertBinding(binding);
      if (binding.subscribed) await this.chat.thread(externalThreadId).subscribe();
      const result = { conversationId, externalThreadId };
      await this.completeIdempotentResult(input.idempotencyKey, result);
      return result;
    });
  }

  async reply(input: ReplyInput): Promise<ChatPostResult> {
    return this.withAudit("chat.reply", input, async () => {
      const cached = await this.getIdempotentResult(input.idempotencyKey);
      if (cached) return cached;
      const binding = await this.resolveCurrentBinding(input.officeAgentId, input.conversationId);
      const files = input.files?.map(toFileUpload);
      const messages = withFilesOnFirstMessage(
        slackPostableMessagesFromMarkdown(input.message),
        files,
      );
      await this.postMessages(binding.externalThreadId, messages);
      await this.suppressActiveAutoRelay(binding.externalThreadId);
      const result = this.resultFromBinding(binding);
      await this.completeIdempotentResult(input.idempotencyKey, result);
      return result;
    });
  }

  async sendFile(input: SendFileInput): Promise<ChatPostResult> {
    return this.withAudit("chat.sendFile", input, async () => {
      const cached = await this.getIdempotentResult(input.idempotencyKey);
      if (cached) return cached;
      const binding = input.destination
        ? await this.ensureDestinationBinding(input)
        : await this.resolveCurrentBinding(input.officeAgentId, input.conversationId);
      const messages = withFilesOnFirstMessage(
        slackPostableMessagesFromMarkdown(input.message ?? ""),
        [toFileUpload(input.file)],
      );
      await this.postMessages(binding.externalThreadId, messages);
      await this.suppressActiveAutoRelay(binding.externalThreadId);
      const result = { ...this.resultFromBinding(binding), fileId: input.file.filename };
      await this.completeIdempotentResult(input.idempotencyKey, result);
      return result;
    });
  }

  private async postMessages(
    externalThreadId: string,
    messages: AdapterPostableMessage[],
  ): Promise<void> {
    for (const message of messages) {
      await this.chat.thread(externalThreadId).post(message);
    }
  }

  private async postRemainingMessages(
    externalThreadId: string,
    messages: AdapterPostableMessage[],
  ): Promise<void> {
    await this.postMessages(externalThreadId, messages.slice(1));
  }

  async ask(input: AskInput): Promise<ChatPostResult> {
    return this.withAudit(
      input.scope === "person" ? "chat.askPerson" : "chat.askChannel",
      input,
      async () => {
        const cached = await this.getIdempotentResult(input.idempotencyKey);
        if (cached) return cached;
        const started = await this.startConversation({
          officeAgentId: input.officeAgentId,
          destination: input.destination,
          message: input.question,
          subscribe: true,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:post` : undefined,
        });
        const requestId = `ask_${randomUUID()}`;
        const createdAt = nowIso();
        const deadlineAt = new Date(
          Date.now() + Math.max(1, input.timeoutMinutes) * 60_000,
        ).toISOString();
        const request: PendingRequest = {
          requestId,
          officeAgentId: input.officeAgentId,
          conversationId: started.conversationId,
          externalThreadId: started.externalThreadId,
          question: input.question,
          deadlineAt,
          status: "pending",
          answer: null,
          answeredBy: null,
          createdAt,
          updatedAt: createdAt,
        };
        await this.store.createPendingRequest(request);
        const result = { ...started, requestId, status: "pending" as const };
        await this.completeIdempotentResult(input.idempotencyKey, result);
        return result;
      },
    );
  }

  async notifyPendingRequestAnswer(input: {
    officeAgentId: string;
    requestId: string;
    sender: string;
    answer: string;
  }): Promise<void> {
    await this.client.sendAgentMessage(
      input.officeAgentId,
      `Answer to chat ask ${input.requestId} from ${input.sender}:\n\n${input.answer}`,
    );
  }

  private assertBindingOwner(agentId: string, binding: ChatBinding | null): void {
    if (!binding || getBindingOwnerAgentId(binding) === agentId) {
      return;
    }
    throw new ChatToolError(
      "not_conversation_owner",
      "Only the office agent that owns a chat binding can use it.",
    );
  }

  private async suppressActiveAutoRelay(externalThreadId: string): Promise<void> {
    await this.store.updateBinding(externalThreadId, (binding) => {
      binding.activeRelayId = null;
    });
  }

  private async ensureDestinationBinding(input: SendFileInput): Promise<ChatBinding> {
    if (!input.destination) throw new ChatToolError("no_destination", "destination is required");
    const started = await this.startConversation({
      officeAgentId: input.officeAgentId,
      destination: input.destination,
      message: input.message ?? "",
      subscribe: true,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:conversation` : undefined,
    });
    const binding = await this.store.getConversation(started.conversationId);
    if (!binding)
      throw new ChatToolError("conversation_not_found", "created chat binding was not saved");
    return binding;
  }

  private createOutboundBinding(input: {
    conversationId: string;
    externalThreadId: string;
    officeAgentId: string;
    destination: ChatDestination;
    subscribed: boolean;
  }): OutboundConversationBinding {
    const timestamp = nowIso();
    return {
      kind: "outbound-conversation",
      conversationId: input.conversationId,
      externalThreadId: input.externalThreadId,
      officeAgentId: input.officeAgentId,
      destination: input.destination,
      subscribed: input.subscribed,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private async resolveDestination(
    officeAgentId: string,
    destination: ChatDestination,
    allowCurrent: boolean,
  ): Promise<ResolvedTarget> {
    const parsedDestination = ChatDestinationSchema.parse(destination);
    if (parsedDestination.kind === "current") {
      if (!allowCurrent)
        throw new ChatToolError("invalid_destination", "current is not valid here");
      const binding = await this.resolveCurrentBinding(officeAgentId);
      return {
        destination: parsedDestination,
        externalThreadId: binding.externalThreadId,
        target: this.chat.thread(binding.externalThreadId),
        mode: "thread",
      };
    }
    if (parsedDestination.kind === "conversation") {
      const binding = await this.resolveCurrentBinding(
        officeAgentId,
        parsedDestination.conversationId,
      );
      return {
        destination: parsedDestination,
        externalThreadId: binding.externalThreadId,
        target: this.chat.thread(binding.externalThreadId),
        mode: "thread",
      };
    }
    if (parsedDestination.kind === "person") {
      const mapped = this.config.people[parsedDestination.key.toLowerCase()];
      const userId = mapped ?? parsedDestination.key;
      if (!/^[UW][A-Z0-9]+$/.test(userId)) {
        throw new ChatToolError(
          "unknown_person",
          "Set PASEO_CHAT_PEOPLE_JSON or pass a Slack user id like U123.",
          { key: parsedDestination.key },
        );
      }
      return {
        destination: parsedDestination,
        target: await this.chat.openDM(normalizeSlackUserId(userId)),
        mode: "new-thread",
      };
    }

    const channelFromUrl = parsedDestination.url ? parseSlackUrl(parsedDestination.url) : null;
    if (channelFromUrl?.threadId) {
      return {
        destination: parsedDestination,
        externalThreadId: channelFromUrl.threadId,
        target: this.chat.thread(channelFromUrl.threadId),
        mode: "thread",
      };
    }
    const channelNameKey = parsedDestination.name?.toLowerCase().replace(/^#/, "");
    const configuredChannel = channelNameKey ? this.config.channels[channelNameKey] : undefined;
    const channelId =
      parsedDestination.id ??
      channelFromUrl?.channelId ??
      configuredChannel ??
      parsedDestination.name;
    if (!channelId) {
      throw new ChatToolError(
        "unknown_channel",
        "Pass a Slack channel id, channel name, or permalink from executor discovery.",
        { url: parsedDestination.url },
      );
    }
    return {
      destination: parsedDestination,
      target: this.chat.channel(normalizeSlackChannelId(channelId)),
      mode: "new-thread",
    };
  }

  private async resolveCurrentBinding(
    officeAgentId: string,
    conversationId?: string,
  ): Promise<ChatBinding> {
    if (conversationId) {
      const binding = await this.store.getConversation(conversationId);
      if (!binding)
        throw new ChatToolError(
          "conversation_not_found",
          "No chat conversation matches conversationId.",
        );
      if (getBindingOwnerAgentId(binding) !== officeAgentId) {
        throw new ChatToolError(
          "not_conversation_owner",
          "Only the office agent that owns a chat binding can use it.",
        );
      }
      return binding;
    }
    const bindings = await this.store.findBindingsByAgent(officeAgentId);
    if (bindings.length === 0) {
      throw new ChatToolError(
        "no_current_binding",
        "Call chat.startConversation first or pass conversationId.",
      );
    }
    if (bindings.length > 1) {
      throw new ChatToolError(
        "ambiguous_current_binding",
        "Pass conversationId to choose one of the current chat bindings.",
        {
          conversations: bindings.map((binding) => ({
            conversationId:
              binding.kind === "outbound-conversation" ? binding.conversationId : undefined,
            externalThreadId: binding.externalThreadId,
            kind: binding.kind,
          })),
        },
      );
    }
    return bindings[0];
  }

  private resultFromBinding(binding: ChatBinding): ChatPostResult {
    return {
      conversationId:
        binding.kind === "outbound-conversation"
          ? binding.conversationId
          : binding.externalThreadId,
      externalThreadId: binding.externalThreadId,
    };
  }

  private async getIdempotentResult(key: string | undefined): Promise<ChatPostResult | null> {
    if (!key) return null;
    return this.store.getCompletedDeliveryResult<ChatPostResult>(key);
  }

  private async completeIdempotentResult(
    key: string | undefined,
    result: ChatPostResult,
  ): Promise<void> {
    if (!key) return;
    await this.store.markDeliveryCompleted(key, result);
  }

  private async withAudit<T extends ChatPostResult>(
    toolName: string,
    input: StartConversationInput | ReplyInput | SendFileInput | AskInput,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      if (input.idempotencyKey && !(await this.store.markDeliveryStarted(input.idempotencyKey))) {
        const cached = await this.getIdempotentResult(input.idempotencyKey);
        if (cached) return cached as T;
      }
      const result = await run();
      await this.store.appendAuditRecord(
        auditRecord({
          officeAgentId: input.officeAgentId,
          toolName,
          destination: "destination" in input ? input.destination : undefined,
          resolvedExternalThreadId: result.externalThreadId,
          conversationId: result.conversationId,
          message: auditMessage(input),
          files: auditFiles(input),
          result: "file" in input ? "uploaded" : "posted",
        }),
      );
      return result;
    } catch (error) {
      const chatError = toChatToolError(error);
      await this.store.appendAuditRecord(
        auditRecord({
          officeAgentId: input.officeAgentId,
          toolName,
          destination: "destination" in input ? input.destination : undefined,
          conversationId: "conversationId" in input ? input.conversationId : undefined,
          message: auditMessage(input),
          files: auditFiles(input),
          result: "failed",
          errorCode: chatError.code,
        }),
      );
      throw chatError;
    }
  }
}

function toFileUpload(file: ChatOutboundFile): FileUpload {
  return {
    data: Buffer.from(file.bytesBase64, "base64"),
    filename: path.basename(file.filename),
    mimeType: file.mimeType,
  };
}

function toChatToolError(error: unknown): ChatToolError {
  if (error instanceof ChatToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ChatToolError("chat_post_failed", message);
}

export async function ensureServiceToken(tokenPath: string): Promise<string> {
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

export async function startChatServiceServer(input: {
  service: ChatBridgeService;
  host: string;
  port: number;
  tokenPath: string;
}): Promise<Server> {
  const token = await ensureServiceToken(input.tokenPath);
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/chat-bridge/rpc") {
      writeJson(response, 404, { ok: false, error: { code: "not_found" } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      writeJson(response, 401, { ok: false, error: { code: "unauthorized" } });
      return;
    }
    try {
      const body = readRpcBody(await readRequestJson(request));
      const payload = await callService(input.service, body);
      writeJson(response, 200, { ok: true, payload });
    } catch (error) {
      const chatError = toChatToolError(error);
      writeJson(response, 200, {
        ok: false,
        error: { code: chatError.code, message: chatError.message, details: chatError.details },
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

interface RpcBody {
  method: "startConversation" | "reply" | "sendFile" | "ask";
  input: unknown;
}

function readRpcBody(value: unknown): RpcBody {
  if (!value || typeof value !== "object")
    throw new ChatToolError("invalid_request", "RPC body must be an object.");
  const body = value as { method?: unknown; input?: unknown };
  if (
    body.method !== "startConversation" &&
    body.method !== "reply" &&
    body.method !== "sendFile" &&
    body.method !== "ask"
  ) {
    throw new ChatToolError("invalid_method", "Unknown chat bridge service method.");
  }
  return { method: body.method, input: body.input };
}

async function callService(service: ChatBridgeService, body: RpcBody): Promise<ChatPostResult> {
  if (body.method === "startConversation")
    return service.startConversation(body.input as StartConversationInput);
  if (body.method === "reply") return service.reply(body.input as ReplyInput);
  if (body.method === "sendFile") return service.sendFile(body.input as SendFileInput);
  return service.ask(body.input as AskInput);
}
