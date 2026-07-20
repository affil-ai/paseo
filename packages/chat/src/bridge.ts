import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  DaemonClient,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import {
  CHAT_STARTED_BY_AVATAR_URL_LABEL,
  CHAT_STARTED_BY_HANDLE_LABEL,
  CHAT_STARTED_BY_NAME_LABEL,
  CHAT_STARTED_BY_SOURCE_LABEL,
  CHAT_STARTED_BY_USER_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import {
  emoji,
  LinkButton,
  Actions,
  Card,
  type AdapterPostableMessage,
  type EmojiValue,
  type Message,
  type UserInfo,
} from "chat";
import type { ResolvedChatBridgeConfig } from "./config.js";
import type { FocusRelay } from "./focus.js";
import {
  captureThreadContext,
  normalizeMessage,
  shouldIgnoreAuthor,
  shouldIgnoreAmbient,
  titleFromText,
  type SlackIntakeThread,
} from "./intake/slack.js";
import {
  assembleContextOnlySlackPrompt,
  assembleExternalIntakeSystemPrompt,
  assembleFollowupPrompt,
  assembleInitialPrompt,
  externalIntakeAgentPrompt,
  loadOfficePrompt,
} from "./prompt.js";
import { extractGithubPrLinks } from "./github.js";
import { slackPostableMessagesFromMarkdown } from "./render.js";
import type { PermissionBridge } from "./permissions.js";
import { buildPaseoAgentUrl } from "./paseo-link.js";
import {
  CHAT_SOURCE_LABEL_KEY,
  CHAT_THREAD_LABEL,
  getBindingOwnerAgentId,
  ThreadSessionStore,
  type ChatBinding,
  type ChatStarter,
} from "./state/thread-session-store.js";

export interface ChatBridgeClient {
  archiveAgent(agentId: string): Promise<unknown>;
  createAgent(input: Parameters<DaemonClient["createAgent"]>[0]): Promise<{ id: string }>;
  createWorkspace(
    input: Parameters<DaemonClient["createWorkspace"]>[0],
  ): Promise<{ workspace?: { id: string } | null; error?: string | null }>;
  fetchAgent(agentId: string): Promise<{ agent: { labels?: Record<string, string> } } | null>;
  fetchAgentTimeline: DaemonClient["fetchAgentTimeline"];
  getLastServerInfoMessage(): { serverId: string } | null;
  sendAgentMessage: DaemonClient["sendAgentMessage"];
}

interface ChatBridgeAdapter {
  name?: string;
  botUserId?: string;
  getUser?: (userId: string) => Promise<UserInfo | null>;
  hasActiveTurn?(externalThreadId: string): Promise<boolean>;
  usesPersistentRelay?(externalThreadId: string): Promise<boolean>;
  postMessage(externalThreadId: string, message: string | AdapterPostableMessage): Promise<unknown>;
  postTurnEvent?(event: OfficeTurnRelayEvent): Promise<unknown>;
  postTurnFailure?(event: OfficeTurnFailureEvent): Promise<unknown>;
}

export interface OfficeTurnRelayEvent {
  externalThreadId: string;
  agentId: string;
  relayId: string;
  phase: "message" | "final";
  sequence: number;
  text: string;
  terminal: boolean;
}

export interface OfficeTurnFailureEvent {
  externalThreadId: string;
  agentId: string;
  relayId: string;
  errorCode: string;
}

export interface ChatBridgeThread extends Omit<SlackIntakeThread, "adapter"> {
  adapter: ChatBridgeAdapter;
  subscribe(): Promise<unknown>;
  post(message: string | AdapterPostableMessage): Promise<unknown>;
  createSentMessageFromMessage(message: Message): {
    addReaction(reaction: EmojiValue | string): Promise<unknown>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slackAttribution(sender: { userId: string; name: string; email?: string }) {
  return {
    source: "slack" as const,
    userId: sender.userId,
    name: sender.name,
    ...(sender.email ? { email: sender.email } : {}),
  };
}

function isSystemErrorAssistantText(text: string): boolean {
  return text.trimStart().startsWith("[System Error]");
}

function isRelayableAssistantText(text: string): boolean {
  return text.trim().length > 0 && !isSystemErrorAssistantText(text);
}

function isAgentSettled(agent: FetchAgentTimelinePayload["agent"]): boolean {
  if (!agent || agent.status === "initializing" || agent.status === "running") return false;
  const updatedAt = Date.parse(agent.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= 5_000;
}

function getSlackThreadRootMessageId(message: Message): string {
  const raw = message.raw as { thread_ts?: unknown } | undefined;
  const threadTs = typeof raw?.thread_ts === "string" && raw.thread_ts ? raw.thread_ts : null;
  return threadTs ?? message.id;
}

function chatStarterLabels(startedBy: ChatStarter | undefined): Record<string, string> {
  if (!startedBy) return {};
  return {
    [CHAT_STARTED_BY_SOURCE_LABEL]: startedBy.source,
    [CHAT_STARTED_BY_USER_ID_LABEL]: startedBy.userId,
    [CHAT_STARTED_BY_NAME_LABEL]: startedBy.name,
    ...(startedBy.handle ? { [CHAT_STARTED_BY_HANDLE_LABEL]: startedBy.handle } : {}),
    ...(startedBy.avatarUrl ? { [CHAT_STARTED_BY_AVATAR_URL_LABEL]: startedBy.avatarUrl } : {}),
  };
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
    private readonly client: ChatBridgeClient,
    private readonly store: ThreadSessionStore,
    private readonly permissions: Pick<PermissionBridge, "answerPendingQuestion">,
    private readonly focus: Pick<FocusRelay, "escapeToRoot">,
    private readonly fallbackAdapter?: ChatBridgeAdapter,
  ) {
    this.customOfficePrompt = loadOfficePrompt(config);
  }

  private readonly threads = new Map<string, ChatBridgeThread>();

  getThread(externalThreadId: string): ChatBridgeThread | null {
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
      if (session.officeRelay) continue;
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
    if (session.officeRelay) return;
    const thread = this.getThread(session.externalThreadId);
    if (!thread && !this.fallbackAdapter) return;
    const relayAdapter = thread?.adapter ?? this.fallbackAdapter;
    if (
      relayAdapter?.hasActiveTurn &&
      !(await relayAdapter.hasActiveTurn(session.externalThreadId))
    )
      return;
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
    thread: ChatBridgeThread,
    message: Message,
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
    existing: ChatBinding | null,
  ): Promise<boolean> {
    if (normalized.command === "aside") {
      if (existing) {
        await this.dispatchContextOnlyMessage({
          normalized,
          session: existing,
        });
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
          await this.dispatchContextOnlyMessage({
            normalized,
            session: existing,
          });
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
    const isMentionedArchiveCommand =
      normalized.command === "archive" && message.isMention === true;
    if (isMentionedArchiveCommand && existing) {
      await this.client.archiveAgent(getBindingOwnerAgentId(existing));
      await this.store.deleteSession(normalized.externalThreadId);
      await this.reactToArchiveCommand(thread, message);
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
      {
        images: normalized.images,
        attachments: normalized.attachments,
        userMessageSource: "slack",
        attribution: slackAttribution(normalized.sender),
      },
    );
    return true;
  }

  async handleMessage(
    thread: ChatBridgeThread,
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
      await this.dispatchAgentTurn({
        thread,
        message,
        source,
        normalized,
        existing,
        session,
      });
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
          userMessageSource: "slack",
          attribution: slackAttribution(input.normalized.sender),
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
    thread: ChatBridgeThread;
    message: Message;
    source: "mention" | "dm" | "subscribed";
    normalized: Awaited<ReturnType<typeof normalizeMessage>>;
    existing: ChatBinding | null;
    session: ChatBinding;
  }): Promise<void> {
    const relayId = input.message.id;
    const ownerAgentId = getBindingOwnerAgentId(input.session);
    const sinceSeq = input.existing ? await this.getTimelineNextSeq(ownerAgentId) : 0;
    const usesPersistentRelay = await input.thread.adapter.usesPersistentRelay?.(
      input.normalized.externalThreadId,
    );
    if (this.config.relayMode === "auto" && !usesPersistentRelay) {
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
          userMessageSource: "slack",
          attribution: slackAttribution(input.normalized.sender),
          messageId: input.message.id,
        },
      );
      await this.store.markEventProcessed(input.normalized.eventId);
    }
    if (this.config.relayMode === "auto" && !usesPersistentRelay) {
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
    workspaceTitlePrompt?: string;
    systemPrompt?: string;
    initialPrompt: string;
    images?: Array<{ data: string; mimeType: string }>;
    attachments?: AgentAttachment[];
    thread?: ChatBridgeThread | null;
    initialRelayId?: string;
    clientMessageId?: string;
    startedBy?: ChatStarter;
  }) {
    const workspaceResult = await this.client.createWorkspace({
      source: { kind: "directory", path: this.config.officeRepoPath },
      firstAgentContext: {
        prompt: input.workspaceTitlePrompt ?? input.title,
        attachments: input.attachments ?? [],
      },
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
      clientMessageId: input.clientMessageId ?? randomUUID(),
      initialMessageSource: input.source,
      ...(input.startedBy ? { initialAttribution: slackAttribution(input.startedBy) } : {}),
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      labels: {
        [CHAT_THREAD_LABEL]: input.externalThreadId,
        [CHAT_SOURCE_LABEL_KEY]: input.source,
        ...chatStarterLabels(input.startedBy),
      },
    });

    const now = new Date().toISOString();
    const session = {
      kind: "inbound-session" as const,
      externalThreadId: input.externalThreadId,
      rootAgentId: agent.id,
      workspaceId: workspaceResult.workspace.id,
      ...(input.startedBy ? { startedBy: input.startedBy } : {}),
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
    thread: ChatBridgeThread,
    message: Message,
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
  ) {
    const title = titleFromText(normalized.cleanedText);
    let threadContext = "";
    if (!thread.isDM) {
      threadContext = await captureThreadContext(thread, message.id);
    }

    let workspaceTitlePrompt = normalized.cleanedText;
    if (threadContext) {
      workspaceTitlePrompt = threadContext;
      if (normalized.cleanedText) {
        workspaceTitlePrompt = `${threadContext}\n\n${normalized.cleanedText}`;
      }
    }
    const session = await this.createExternalSession({
      externalThreadId: normalized.externalThreadId,
      source: "slack",
      title,
      workspaceTitlePrompt,
      systemPrompt: assembleExternalIntakeSystemPrompt({
        basePrompt: externalIntakeAgentPrompt(this.config.relayMode),
        customPrompt: await this.customOfficePrompt,
      }),
      initialPrompt: assembleInitialPrompt({
        sender: normalized.sender,
        text: normalized.cleanedText,
        threadContext,
        relayMode: this.config.relayMode,
      }),
      images: normalized.images,
      attachments: normalized.attachments,
      clientMessageId: message.id,
      startedBy: {
        source: "slack",
        userId: normalized.sender.userId,
        name: normalized.sender.name,
        ...(normalized.sender.email ? { email: normalized.sender.email } : {}),
        ...(normalized.sender.handle ? { handle: normalized.sender.handle } : {}),
        ...(normalized.sender.avatarUrl ? { avatarUrl: normalized.sender.avatarUrl } : {}),
      },
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
    thread: ChatBridgeThread,
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

  private async reactToArchiveCommand(thread: ChatBridgeThread, message: Message): Promise<void> {
    const targetMessageId = getSlackThreadRootMessageId(message);
    const targetMessage =
      targetMessageId === message.id ? message : ({ ...message, id: targetMessageId } as Message);
    for (const reaction of ["wastebasket", "trash"]) {
      try {
        await thread.createSentMessageFromMessage(targetMessage).addReaction(reaction);
        return;
      } catch {
        // Try the next likely Slack emoji name; workspaces can differ on aliases.
      }
    }
  }

  private async postStartedCard(
    thread: ChatBridgeThread | null,
    externalThreadId: string,
    workspaceId: string,
    agentId: string,
  ): Promise<void> {
    const serverId = this.client.getLastServerInfoMessage()?.serverId ?? "local";
    const url = buildPaseoAgentUrl({
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
    thread: ChatBridgeThread | null;
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
      const relayAdapter = input.thread?.adapter ?? this.fallbackAdapter;
      if (relayAdapter?.postTurnFailure) {
        await relayAdapter
          .postTurnFailure({
            externalThreadId: input.externalThreadId,
            agentId: input.agentId,
            relayId: input.relayId,
            errorCode: reason.slice(0, 100) || "OFFICE_RELAY_FAILED",
          })
          .catch(() => {});
        return;
      }
      await this.postMessage(
        input.thread,
        input.externalThreadId,
        `I couldn't relay the agent response. Reason: ${reason}`,
      ).catch(() => {});
    });
  }

  private async relayTurn(input: {
    thread: ChatBridgeThread | null;
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

    const relayAdapter = input.thread?.adapter ?? this.fallbackAdapter;
    if (relayAdapter?.postTurnEvent) {
      const relayResult = await this.waitForAssistantTextBlocks({
        agentId: input.agentId,
        sinceSeq: input.sinceSeq,
        externalThreadId: input.externalThreadId,
        relayId: input.relayId,
        onFirstText: async () => {},
        onClosedText: input.postFirstReply
          ? async (text, sequence) => {
              await relayAdapter.postTurnEvent?.({
                externalThreadId: input.externalThreadId,
                agentId: input.agentId,
                relayId: input.relayId,
                phase: "message",
                sequence,
                text,
                terminal: false,
              });
            }
          : undefined,
      });
      if (!(await this.isRelayCurrent(input.externalThreadId, input.relayId))) {
        await this.store.markDeliveryCompleted(receipt);
        return;
      }
      const finalText = relayResult.finalText || (relayResult.sawAssistantTextBlock ? "" : "Done.");
      await relayAdapter.postTurnEvent({
        externalThreadId: input.externalThreadId,
        agentId: input.agentId,
        relayId: input.relayId,
        phase: "final",
        sequence: Math.max(0, relayResult.relayableBlockCount - 1),
        text: finalText,
        terminal: true,
      });
      await this.store.updateSession(input.externalThreadId, (current) => {
        if (current.activeRelayId === input.relayId) current.activeRelayId = null;
      });
      await this.store.markDeliveryCompleted(receipt);
      return;
    }

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
    onClosedText?: (text: string, sequence: number) => Promise<void>;
  }): Promise<{
    finalText: string;
    sawAssistantTextBlock: boolean;
    relayableBlockCount: number;
  }> {
    let firstTextPosted = false;
    let finalText = "";
    let sawAssistantTextBlock = false;
    let closedTextCount = 0;
    let relayableBlockCount = 0;

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
      relayableBlockCount = relayableBlocks.length;

      const agentSettled = isAgentSettled(timeline.agent);
      const closedBlocks = agentSettled
        ? relayableBlocks.slice(0, -1)
        : relayableBlocks.filter((block) => block.lastEntryIndex < timeline.entries.length - 1);
      while (input.onClosedText && closedTextCount < closedBlocks.length) {
        const block = closedBlocks[closedTextCount];
        if (!block) break;
        await input.onClosedText(block.text, closedTextCount);
        closedTextCount += 1;
      }

      const firstBlock = relayableBlocks[0];
      if (!firstTextPosted && firstBlock) {
        const firstBlockClosed = firstBlock.lastEntryIndex < timeline.entries.length - 1;
        if (firstBlock.text && (firstBlockClosed || agentSettled)) {
          firstTextPosted = true;
          await input.onFirstText(firstBlock.text);
        }
      }

      finalText = relayableBlocks.at(-1)?.text ?? finalText;

      if (agentSettled) {
        return { finalText, sawAssistantTextBlock, relayableBlockCount };
      }
      await sleep(1_000);
    }

    return { finalText, sawAssistantTextBlock, relayableBlockCount };
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
    thread: ChatBridgeThread | null;
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
    await this.store.recordGithubPrLinks(extractGithubPrLinks(input.text), {
      officeAgentId: input.agentId,
      externalThreadId: input.externalThreadId,
      ...(binding.kind === "outbound-conversation"
        ? { conversationId: binding.conversationId }
        : {}),
    });
  }

  private async postMessage(
    thread: ChatBridgeThread | null,
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
