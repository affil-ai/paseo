import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  DaemonClient,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import {
  emoji,
  LinkButton,
  Actions,
  Card,
  type Adapter,
  type AdapterPostableMessage,
  type Message,
  type Thread,
} from "chat";
import type { ResolvedChatBridgeConfig } from "./config.js";
import type { FocusRelay } from "./focus.js";
import {
  captureThreadContext,
  normalizeMessage,
  shouldIgnoreAuthor,
  shouldIgnoreAmbient,
  titleFromText,
} from "./intake/slack.js";
import {
  assembleContextOnlySlackPrompt,
  assembleExternalIntakeSystemPrompt,
  assembleFollowupPrompt,
  assembleInitialPrompt,
  externalIntakeAgentPrompt,
  loadOfficePrompt,
} from "./prompt.js";
import { slackPostableMessagesFromMarkdown } from "./render.js";
import type { PermissionBridge } from "./permissions.js";
import {
  CHAT_SOURCE_LABEL_KEY,
  CHAT_THREAD_LABEL,
  getBindingOwnerAgentId,
  ThreadSessionStore,
  type ChatBinding,
} from "./state/thread-session-store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimNonEmpty(value: string): string {
  return value.trim();
}

function isSystemErrorAssistantText(text: string): boolean {
  return text.trimStart().startsWith("[System Error]");
}

function isRelayableAssistantText(text: string): boolean {
  return text.trim().length > 0 && !isSystemErrorAssistantText(text);
}

function toBase64UrlNoPad(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function isUrlSafeWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(value);
}

function encodeWorkspaceIdForPathSegment(workspaceId: string): string {
  const id = trimNonEmpty(workspaceId);
  if (isUrlSafeWorkspaceId(id)) {
    return id;
  }
  return `b64_${toBase64UrlNoPad(id)}`;
}

export function buildStartedCardUrl(input: {
  baseUrl: string;
  serverId: string;
  workspaceId: string;
  agentId: string;
}): string {
  const baseUrl = trimNonEmpty(input.baseUrl).replace(/\/+$/g, "");
  const serverId = encodeURIComponent(trimNonEmpty(input.serverId));
  const workspaceId = encodeURIComponent(encodeWorkspaceIdForPathSegment(input.workspaceId));
  const openIntent = encodeURIComponent(`agent:${trimNonEmpty(input.agentId)}`);
  return `${baseUrl}/h/${serverId}/workspace/${workspaceId}?open=${openIntent}`;
}

type AgentTimelineEntry = FetchAgentTimelinePayload["entries"][number];

interface AssistantTextBlock {
  text: string;
  lastEntryIndex: number;
}

function collectAssistantTextBlocksSince(
  entries: readonly AgentTimelineEntry[],
  sinceSeq: number,
): AssistantTextBlock[] {
  const blocks: AssistantTextBlock[] = [];
  let current: AssistantTextBlock | null = null;

  entries.forEach((entry, index) => {
    if (entry.seqEnd < sinceSeq) return;

    if (entry.item.type !== "assistant_message") {
      current = null;
      return;
    }

    if (!current) {
      current = { text: "", lastEntryIndex: index };
      blocks.push(current);
    }

    current.text += entry.item.text;
    current.lastEntryIndex = index;
  });

  for (const block of blocks) {
    block.text = block.text.trim();
  }
  return blocks;
}

export class ChatBridge {
  private customOfficePrompt: Promise<string>;

  constructor(
    private readonly config: ResolvedChatBridgeConfig,
    private readonly client: DaemonClient,
    private readonly store: ThreadSessionStore,
    private readonly permissions: PermissionBridge,
    private readonly focus: FocusRelay,
    private readonly fallbackAdapter?: Pick<Adapter, "postMessage">,
  ) {
    this.customOfficePrompt = loadOfficePrompt(config);
  }

  private readonly threads = new Map<string, Thread>();

  getThread(externalThreadId: string): Thread | null {
    return this.threads.get(externalThreadId) ?? null;
  }

  async recoverRelaysAfterRestart(): Promise<void> {
    const sessions = Object.values((await this.store.load()).sessions);
    if (this.config.relayMode === "manual") {
      await Promise.all(
        sessions.map((session) =>
          this.store.updateSession(session.externalThreadId, (current) => {
            current.activeRelayId = null;
          }),
        ),
      );
      return;
    }

    for (const session of sessions) {
      const agentId = getBindingOwnerAgentId(session);
      const timeline = await this.client
        .fetchAgentTimeline(agentId, {
          direction: "tail",
          projection: "canonical",
          limit: 200,
        })
        .catch((error) => {
          console.warn("Failed to inspect linked agent for Slack relay recovery", {
            agentId,
            externalThreadId: session.externalThreadId,
            error,
          });
          return null;
        });
      if (!timeline) continue;

      const status = timeline.agent?.status;
      const staleRelayWasActive = Boolean(session.activeRelayId);
      const agentIsRunning = status === "initializing" || status === "running";
      if (!staleRelayWasActive && !agentIsRunning) continue;

      const relayId = `recovery:${agentId}:${Date.now()}`;
      await this.store.updateSession(session.externalThreadId, (current) => {
        current.activeRelayId = relayId;
      });
      if (!(await this.isRelayCurrent(session.externalThreadId, relayId))) continue;

      this.startBackgroundRelay({
        thread: this.getThread(session.externalThreadId),
        externalThreadId: session.externalThreadId,
        agentId,
        messageId: relayId,
        source: "recovery",
        sinceSeq: 0,
        relayId,
        postFirstReply: false,
      });
    }
  }

  async expirePendingRequests(now = new Date()): Promise<void> {
    const expired = await this.store.expirePendingRequests(now);
    for (const request of expired) {
      await this.client
        .sendAgentMessage(
          request.officeAgentId,
          `Chat ask ${request.requestId} timed out without an answer.`,
        )
        .catch((error) => {
          console.warn("Failed to notify office agent of chat ask timeout", {
            requestId: request.requestId,
            officeAgentId: request.officeAgentId,
            error,
          });
        });
    }
  }

  async handleAgentTurnStarted(agentId: string, eventSeq?: number): Promise<void> {
    if (this.config.relayMode === "manual") return;
    const session = await this.findLinkedSessionForAgent(agentId);
    if (!session) return;
    const thread = this.getThread(session.externalThreadId);
    if (!thread && !this.fallbackAdapter) return;
    if (session.activeRelayId) return;

    const relayId = `ui:${agentId}:${eventSeq ?? Date.now()}`;
    const sinceSeq = await this.getTimelineNextSeq(agentId);
    await this.store.updateSession(session.externalThreadId, (current) => {
      if (current.activeRelayId) return current;
      current.activeRelayId = relayId;
    });
    if (!(await this.isRelayCurrent(session.externalThreadId, relayId))) return;

    this.startBackgroundRelay({
      thread,
      externalThreadId: session.externalThreadId,
      agentId,
      messageId: relayId,
      source: "ui",
      sinceSeq,
      relayId,
      postFirstReply: true,
    });
  }

  private async findLinkedSessionForAgent(agentId: string): Promise<ChatBinding | null> {
    const directSession = await this.store.findSessionByAgent(agentId);
    if (directSession) return directSession;

    const result = await this.client.fetchAgent(agentId).catch(() => null);
    const labels = result?.agent.labels ?? {};
    const externalThreadId = labels[CHAT_THREAD_LABEL];
    if (!externalThreadId) return null;

    const binding = await this.store.getSession(externalThreadId);
    return binding && getBindingOwnerAgentId(binding) === agentId ? binding : null;
  }

  private async handleCommand(
    thread: Thread,
    message: Message,
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
    existing: ChatBinding | null,
  ): Promise<boolean> {
    if (normalized.command === "aside") {
      if (existing) {
        await this.dispatchContextOnlyMessage({ normalized, session: existing });
      }
      return true;
    }
    if (normalized.command === "mute" || normalized.command === "unmute") {
      if (existing?.kind === "inbound-session") {
        await this.store.updateSession(normalized.externalThreadId, (binding) => {
          if (binding.kind === "inbound-session") {
            binding.muted = normalized.command === "mute";
            if (normalized.command === "mute") binding.activeRelayId = null;
          }
        });
        if (normalized.command === "mute") {
          await this.dispatchContextOnlyMessage({ normalized, session: existing });
        }
      }
      await this.reactToMuteCommand(thread, message, normalized.command);
      return true;
    }
    if (normalized.command === "escape" && existing) {
      await this.focus.escapeToRoot(normalized.externalThreadId);
      await this.postMessage(
        thread,
        normalized.externalThreadId,
        "Chat already belongs to the office agent. Coding children keep reporting through it.",
      );
      return true;
    }
    if (normalized.command === "archive" && existing) {
      await this.client.archiveAgent(getBindingOwnerAgentId(existing));
      await this.store.deleteSession(normalized.externalThreadId);
      await this.postMessage(
        thread,
        normalized.externalThreadId,
        "Archived the office agent for this thread.",
      );
      return true;
    }
    return false;
  }

  private async answerPendingAsk(
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
  ): Promise<boolean> {
    const pendingAsk = await this.store.takePendingRequestForThread(normalized.externalThreadId);
    if (!pendingAsk) return false;
    await this.store.finishPendingRequest(
      pendingAsk.requestId,
      "answered",
      normalized.cleanedText,
      normalized.sender.handle ?? normalized.sender.name,
    );
    await this.client.sendAgentMessage(
      pendingAsk.officeAgentId,
      `Answer to chat ask ${pendingAsk.requestId} from ${normalized.sender.name}:\n\n${normalized.cleanedText}`,
    );
    return true;
  }

  async handleMessage(
    thread: Thread,
    message: Message,
    source: "mention" | "dm" | "subscribed",
  ): Promise<void> {
    if (shouldIgnoreAuthor(message)) return;
    const normalized = await normalizeMessage(thread, message, {
      attachmentDir: join(this.config.stateDir, "inbound-attachments"),
    });
    this.threads.set(normalized.externalThreadId, thread);
    const existing = await this.store.getSession(normalized.externalThreadId);
    if (shouldIgnoreAmbient(thread, message, Boolean(existing))) return;
    if (await this.store.hasEventReceipt(normalized.eventId)) return;
    await thread.subscribe();
    if (await this.handleCommand(thread, message, normalized, existing)) return;
    if (existing?.kind === "inbound-session" && existing.muted) {
      await this.dispatchContextOnlyMessage({ normalized, session: existing });
      return;
    }

    try {
      const session = existing ?? (await this.startNewSession(thread, message, normalized));
      if (!existing && !(await this.store.markEventProcessed(normalized.eventId))) return;
      if (await this.handleChatAnswer(normalized, Boolean(existing))) return;
      await this.dispatchAgentTurn({ thread, message, source, normalized, existing, session });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.postMessage(
        thread,
        normalized.externalThreadId,
        `I couldn't start a task from this message. Reason: ${reason}`,
      );
    }
  }

  private async dispatchContextOnlyMessage(input: {
    normalized: Awaited<ReturnType<typeof normalizeMessage>>;
    session: ChatBinding;
  }): Promise<void> {
    const ownerAgentId = getBindingOwnerAgentId(input.session);
    await this.store.updateSession(input.normalized.externalThreadId, (current) => {
      current.activeRelayId = null;
    });
    await this.client
      .sendAgentMessage(
        ownerAgentId,
        assembleContextOnlySlackPrompt(input.normalized.sender, input.normalized.cleanedText),
        {
          images: input.normalized.images,
          attachments: input.normalized.attachments,
        },
      )
      .catch((error) => {
        console.warn("Failed to send context-only Slack message to agent", {
          agentId: ownerAgentId,
          externalThreadId: input.normalized.externalThreadId,
          error,
        });
      });
    await this.store.markEventProcessed(input.normalized.eventId);
  }

  private async dispatchAgentTurn(input: {
    thread: Thread;
    message: Message;
    source: "mention" | "dm" | "subscribed";
    normalized: Awaited<ReturnType<typeof normalizeMessage>>;
    existing: ChatBinding | null;
    session: ChatBinding;
  }): Promise<void> {
    const relayId = input.message.id;
    const ownerAgentId = getBindingOwnerAgentId(input.session);
    const sinceSeq = input.existing ? await this.getTimelineNextSeq(ownerAgentId) : 0;
    if (this.config.relayMode === "auto") {
      await this.store.updateSession(input.normalized.externalThreadId, (current) => {
        current.activeRelayId = relayId;
      });
    }
    if (input.existing) {
      await this.client.sendAgentMessage(
        ownerAgentId,
        assembleFollowupPrompt(
          input.normalized.sender,
          input.normalized.cleanedText,
          this.config.relayMode,
        ),
        {
          images: input.normalized.images,
          attachments: input.normalized.attachments,
        },
      );
      await this.store.markEventProcessed(input.normalized.eventId);
    }
    if (this.config.relayMode === "auto") {
      this.startBackgroundRelay({
        thread: input.thread,
        externalThreadId: input.normalized.externalThreadId,
        agentId: ownerAgentId,
        messageId: input.message.id,
        source: input.source,
        sinceSeq,
        relayId,
        postFirstReply: true,
      });
    }
  }

  private async handleChatAnswer(
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
    shouldMarkEventProcessed: boolean,
  ): Promise<boolean> {
    const handled =
      (await this.answerPendingAsk(normalized)) ||
      (await this.permissions.answerPendingQuestion(
        normalized.externalThreadId,
        normalized.cleanedText,
      ));
    if (handled && shouldMarkEventProcessed) {
      await this.store.markEventProcessed(normalized.eventId);
    }
    return handled;
  }

  async createExternalSession(input: {
    externalThreadId: string;
    source: "slack" | "support";
    title: string;
    systemPrompt?: string;
    initialPrompt: string;
    images?: Array<{ data: string; mimeType: string }>;
    attachments?: AgentAttachment[];
    thread?: Thread | null;
    initialRelayId?: string;
  }) {
    const workspaceResult = await this.client.createWorkspace({
      source: { kind: "directory", path: this.config.officeRepoPath },
      title: input.title,
    });
    if (!workspaceResult.workspace)
      throw new Error(workspaceResult.error ?? "Failed to create workspace");

    const agent = await this.client.createAgent({
      provider: this.config.provider as never,
      cwd: this.config.officeRepoPath,
      workspaceId: workspaceResult.workspace.id,
      title: input.title,
      model: this.config.model,
      thinkingOptionId: this.config.thinkingOptionId,
      ...(this.config.modeId ? { modeId: this.config.modeId } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      initialPrompt: input.initialPrompt,
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      labels: {
        [CHAT_THREAD_LABEL]: input.externalThreadId,
        [CHAT_SOURCE_LABEL_KEY]: input.source,
      },
    });

    const now = new Date().toISOString();
    const session = {
      kind: "inbound-session" as const,
      externalThreadId: input.externalThreadId,
      rootAgentId: agent.id,
      activeRelayId: input.initialRelayId ?? null,
      muted: false,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertSession(session);
    await this.postStartedCard(
      input.thread ?? null,
      input.externalThreadId,
      workspaceResult.workspace.id,
      agent.id,
    );
    return session;
  }

  async startRelay(input: {
    externalThreadId: string;
    agentId: string;
    relayId: string;
    sinceSeq: number;
    source?: string;
    postFirstReply?: boolean;
  }): Promise<void> {
    if (this.config.relayMode !== "auto") return;
    await this.store.updateSession(input.externalThreadId, (current) => {
      current.activeRelayId = input.relayId;
    });
    this.startBackgroundRelay({
      thread: this.getThread(input.externalThreadId),
      externalThreadId: input.externalThreadId,
      agentId: input.agentId,
      messageId: input.relayId,
      source: input.source ?? "email",
      sinceSeq: input.sinceSeq,
      relayId: input.relayId,
      postFirstReply: input.postFirstReply ?? true,
    });
  }

  private async startNewSession(
    thread: Thread,
    message: Message,
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
  ) {
    const title = titleFromText(normalized.cleanedText);
    const session = await this.createExternalSession({
      externalThreadId: normalized.externalThreadId,
      source: "slack",
      title,
      systemPrompt: assembleExternalIntakeSystemPrompt({
        basePrompt: externalIntakeAgentPrompt(this.config.relayMode),
        customPrompt: await this.customOfficePrompt,
      }),
      initialPrompt: assembleInitialPrompt({
        sender: normalized.sender,
        text: normalized.cleanedText,
        threadContext: thread.isDM ? "" : await captureThreadContext(thread, message.id),
        relayMode: this.config.relayMode,
      }),
      images: normalized.images,
      attachments: normalized.attachments,
      thread,
    });
    await thread
      .createSentMessageFromMessage(message)
      .addReaction(emoji.eyes)
      .catch(() => {});
    if (this.config.ackEmoji)
      await thread
        .createSentMessageFromMessage(message)
        .addReaction(this.config.ackEmoji)
        .catch(() => {});
    return session;
  }

  private async reactToMuteCommand(
    thread: Thread,
    message: Message,
    command: "mute" | "unmute",
  ): Promise<void> {
    const reactionNames = command === "mute" ? ["mute", "no_bell"] : ["sound", "bell"];
    for (const reaction of reactionNames) {
      try {
        await thread.createSentMessageFromMessage(message).addReaction(reaction);
        return;
      } catch {
        // Try the next likely Slack emoji name; workspaces can differ on aliases.
      }
    }
  }

  private async postStartedCard(
    thread: Thread | null,
    externalThreadId: string,
    workspaceId: string,
    agentId: string,
  ): Promise<void> {
    const serverId = this.client.getLastServerInfoMessage()?.serverId ?? "local";
    const url = buildStartedCardUrl({
      baseUrl: this.config.deepLinkBaseUrl,
      serverId,
      workspaceId,
      agentId,
    });
    await this.postMessage(
      thread,
      externalThreadId,
      Card({
        title: "Working on it",
        children: [Actions([LinkButton({ url, style: "primary", label: "View chat" })])],
      }),
    );
  }

  private async clearActiveRelayIfCurrent(
    externalThreadId: string,
    relayId: string,
  ): Promise<void> {
    await this.store.updateSession(externalThreadId, (current) => {
      if (current.activeRelayId === relayId) current.activeRelayId = null;
    });
  }

  private startBackgroundRelay(input: {
    thread: Thread | null;
    externalThreadId: string;
    agentId: string;
    messageId: string;
    source: string;
    sinceSeq: number;
    relayId: string;
    postFirstReply: boolean;
  }): void {
    if (this.config.relayMode === "manual") return;
    void this.relayTurn(input).catch(async (error) => {
      console.warn("Slack relay failed", error);
      const wasCurrent = await this.isRelayCurrent(input.externalThreadId, input.relayId);
      await this.clearActiveRelayIfCurrent(input.externalThreadId, input.relayId);
      if (!wasCurrent) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.postMessage(
        input.thread,
        input.externalThreadId,
        `I couldn't relay the agent response. Reason: ${reason}`,
      ).catch(() => {});
    });
  }

  private async relayTurn(input: {
    thread: Thread | null;
    externalThreadId: string;
    agentId: string;
    messageId: string;
    source: string;
    sinceSeq: number;
    relayId: string;
    postFirstReply: boolean;
  }): Promise<void> {
    const receipt = `slack:${input.externalThreadId}:${input.messageId}:${input.source}:turn`;
    if (!(await this.store.markDeliveryStarted(receipt))) return;

    const firstReply = { text: null as string | null };
    const relayResult = await this.waitForAssistantTextBlocks({
      agentId: input.agentId,
      sinceSeq: input.sinceSeq,
      externalThreadId: input.externalThreadId,
      relayId: input.relayId,
      onFirstText: async (text) => {
        if (input.postFirstReply) {
          firstReply.text = text;
          await this.postAutoRelayMessage({
            thread: input.thread,
            externalThreadId: input.externalThreadId,
            agentId: input.agentId,
            phase: "first",
            text,
          });
        }
      },
    });
    if (!(await this.isRelayCurrent(input.externalThreadId, input.relayId))) {
      await this.store.markDeliveryCompleted(receipt);
      return;
    }

    const replyText = relayResult.finalText || (relayResult.sawAssistantTextBlock ? "" : "Done.");
    if (replyText && replyText.trim() !== firstReply.text?.trim()) {
      await this.postAutoRelayMessage({
        thread: input.thread,
        externalThreadId: input.externalThreadId,
        agentId: input.agentId,
        phase: "final",
        text: replyText,
      });
    }

    await this.store.updateSession(input.externalThreadId, (current) => {
      if (current.activeRelayId === input.relayId) current.activeRelayId = null;
    });
    await this.store.markDeliveryCompleted(receipt);
  }

  private async isRelayCurrent(externalThreadId: string, relayId: string): Promise<boolean> {
    const session = await this.store.getSession(externalThreadId);
    return session?.activeRelayId === relayId;
  }

  private async waitForAssistantTextBlocks(input: {
    agentId: string;
    sinceSeq: number;
    externalThreadId: string;
    relayId: string;
    onFirstText: (text: string) => Promise<void>;
  }): Promise<{ finalText: string; sawAssistantTextBlock: boolean }> {
    let firstTextPosted = false;
    let finalText = "";
    let sawAssistantTextBlock = false;

    while (await this.isRelayCurrent(input.externalThreadId, input.relayId)) {
      const timeline = await this.client.fetchAgentTimeline(input.agentId, {
        direction: "tail",
        projection: "canonical",
        limit: 200,
      });
      const assistantBlocks = collectAssistantTextBlocksSince(timeline.entries, input.sinceSeq);
      if (assistantBlocks.some((block) => block.text.length > 0)) {
        sawAssistantTextBlock = true;
      }
      const relayableBlocks = assistantBlocks.filter((block) =>
        isRelayableAssistantText(block.text),
      );

      const firstBlock = relayableBlocks[0];
      if (!firstTextPosted && firstBlock) {
        const status = timeline.agent?.status;
        const agentStopped = Boolean(status && status !== "initializing" && status !== "running");
        const firstBlockClosed = firstBlock.lastEntryIndex < timeline.entries.length - 1;
        if (firstBlock.text && (firstBlockClosed || agentStopped)) {
          firstTextPosted = true;
          await input.onFirstText(firstBlock.text);
        }
      }

      finalText = relayableBlocks.at(-1)?.text ?? finalText;

      const status = timeline.agent?.status;
      if (status && status !== "initializing" && status !== "running") {
        return { finalText, sawAssistantTextBlock };
      }
      await sleep(1_000);
    }

    return { finalText, sawAssistantTextBlock };
  }

  private async getTimelineNextSeq(agentId: string): Promise<number> {
    const timeline = await this.client.fetchAgentTimeline(agentId, {
      direction: "tail",
      projection: "canonical",
      limit: 1,
    });
    return timeline.window.nextSeq;
  }

  private async waitForFinalAssistantText(agentId: string, sinceSeq: number): Promise<string> {
    const deadline = Date.now() + 60_000;
    let latestText = "";
    while (Date.now() < deadline) {
      const timeline = await this.client.fetchAgentTimeline(agentId, {
        direction: "tail",
        projection: "projected",
        limit: 200,
      });
      latestText = timeline.entries
        .filter((entry) => entry.seqStart >= sinceSeq && entry.item.type === "assistant_message")
        .map((entry) => (entry.item.type === "assistant_message" ? entry.item.text : ""))
        .join("\n\n")
        .trim();

      const status = timeline.agent?.status;
      if (status && status !== "initializing" && status !== "running") return latestText;
      await sleep(500);
    }
    return latestText;
  }

  private async postAutoRelayMessage(input: {
    thread: Thread | null;
    externalThreadId: string;
    agentId: string;
    phase: "first" | "final";
    text: string;
  }): Promise<void> {
    const binding = await this.store.getSession(input.externalThreadId);
    if (!binding || getBindingOwnerAgentId(binding) !== input.agentId) {
      throw new Error("Auto relay binding owner changed before post");
    }
    for (const message of slackPostableMessagesFromMarkdown(input.text)) {
      await this.postMessage(input.thread, input.externalThreadId, message);
    }
    await this.store.appendAuditRecord({
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      officeAgentId: input.agentId,
      toolName: `chat.autoRelay.${input.phase}`,
      resolvedExternalThreadId: input.externalThreadId,
      conversationId:
        binding.kind === "outbound-conversation" ? binding.conversationId : input.externalThreadId,
      messagePreview: input.text.replace(/\s+/g, " ").trim().slice(0, 240),
      result: "posted",
    });
  }

  private async postMessage(
    thread: Thread | null,
    externalThreadId: string,
    message: string | AdapterPostableMessage,
  ): Promise<void> {
    if (thread?.id === externalThreadId) {
      await thread.post(message);
      return;
    }
    const adapter = thread?.adapter ?? this.fallbackAdapter;
    if (!adapter) throw new Error("No Slack adapter available to post linked thread response");
    await adapter.postMessage(externalThreadId, message);
  }
}
