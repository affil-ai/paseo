import { join } from "node:path";
import type {
  DaemonClient,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
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
import type { ChatBridgeConfig } from "./config.js";
import type { FocusRelay } from "./focus.js";
import {
  captureThreadContext,
  normalizeMessage,
  shouldIgnoreAmbient,
  titleFromText,
} from "./intake/slack.js";
import { assembleFollowupPrompt, assembleInitialPrompt, loadOfficePrompt } from "./prompt.js";
import { slackMarkdownFixups } from "./render.js";
import type { PermissionBridge } from "./permissions.js";
import {
  CHAT_THREAD_LABEL,
  ThreadSessionStore,
  type ThreadSession,
} from "./state/thread-session-store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    private readonly config: ChatBridgeConfig,
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
    for (const session of sessions) {
      const agentId = session.focusedAgentId;
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

  async handleAgentTurnStarted(agentId: string, eventSeq?: number): Promise<void> {
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

  private async findLinkedSessionForAgent(agentId: string): Promise<ThreadSession | null> {
    const directSession = await this.store.findSessionByAgent(agentId);
    if (directSession) return directSession;

    const result = await this.client.fetchAgent(agentId).catch(() => null);
    const labels = result?.agent.labels ?? {};
    const externalThreadId = labels[CHAT_THREAD_LABEL];
    if (externalThreadId) return this.store.getSession(externalThreadId);

    const parentAgentId = getParentAgentIdFromLabels(labels);
    if (!parentAgentId) return null;
    const sessions = Object.values((await this.store.load()).sessions);
    return sessions.find((session) => session.rootAgentId === parentAgentId) ?? null;
  }

  async handleMessage(
    thread: Thread,
    message: Message,
    source: "mention" | "dm" | "subscribed",
  ): Promise<void> {
    const normalized = await normalizeMessage(thread, message, {
      attachmentDir: join(this.config.stateDir, "inbound-attachments"),
    });
    this.threads.set(normalized.externalThreadId, thread);
    const existing = await this.store.getSession(normalized.externalThreadId);
    if (shouldIgnoreAmbient(thread, message, Boolean(existing))) return;
    if (!(await this.store.markEventProcessed(normalized.eventId))) return;
    await thread.subscribe();

    if (normalized.command === "aside") return;
    if (normalized.command === "mute" || normalized.command === "unmute") {
      if (existing) {
        await this.store.updateSession(normalized.externalThreadId, (session) => {
          session.muted = normalized.command === "mute";
        });
      }
      await this.reactToMuteCommand(thread, message, normalized.command);
      return;
    }
    if (normalized.command === "escape" && existing) {
      await this.focus.escapeToRoot(normalized.externalThreadId);
      await this.postMessage(
        thread,
        normalized.externalThreadId,
        "Talking to the office agent again. The coding child can keep running in Office.",
      );
      return;
    }
    if (normalized.command === "done" && existing) {
      await this.client.archiveAgent(existing.rootAgentId);
      await this.store.deleteSession(normalized.externalThreadId);
      await this.postMessage(
        thread,
        normalized.externalThreadId,
        "Done — archived the office agent for this thread.",
      );
      return;
    }
    if (existing?.muted && !message.isMention) return;

    try {
      const session = existing ?? (await this.startNewSession(thread, message, normalized));
      if (
        await this.permissions.answerPendingQuestion(
          normalized.externalThreadId,
          normalized.cleanedText,
        )
      )
        return;
      const relayId = message.id;
      const sinceSeq = existing ? await this.getTimelineNextSeq(session.focusedAgentId) : 0;
      await this.store.updateSession(normalized.externalThreadId, (current) => {
        current.activeRelayId = relayId;
      });
      if (existing) {
        await this.client.sendAgentMessage(
          session.focusedAgentId,
          assembleFollowupPrompt(normalized.sender, normalized.cleanedText),
          {
            images: normalized.images,
            attachments: normalized.attachments,
          },
        );
      }
      this.startBackgroundRelay({
        thread,
        externalThreadId: normalized.externalThreadId,
        agentId: session.focusedAgentId,
        messageId: message.id,
        source,
        sinceSeq,
        relayId,
        postFirstReply: true,
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

  private async startNewSession(
    thread: Thread,
    message: Message,
    normalized: Awaited<ReturnType<typeof normalizeMessage>>,
  ) {
    const title = titleFromText(normalized.cleanedText);
    const workspaceResult = await this.client.createWorkspace({
      source: { kind: "directory", path: this.config.officeRepoPath },
      title,
    });
    if (!workspaceResult.workspace)
      throw new Error(workspaceResult.error ?? "Failed to create workspace");

    const agent = await this.client.createAgent({
      provider: this.config.provider as never,
      cwd: this.config.officeRepoPath,
      workspaceId: workspaceResult.workspace.id,
      title,
      modeId: this.config.modeId,
      model: this.config.model,
      initialPrompt: assembleInitialPrompt({
        customPrompt: await this.customOfficePrompt,
        sender: normalized.sender,
        text: normalized.cleanedText,
        threadContext: thread.isDM ? "" : await captureThreadContext(thread, message.id),
      }),
      images: normalized.images,
      attachments: normalized.attachments,
      labels: { [CHAT_THREAD_LABEL]: normalized.externalThreadId },
    });

    const now = new Date().toISOString();
    const session = {
      externalThreadId: normalized.externalThreadId,
      rootAgentId: agent.id,
      focusedAgentId: agent.id,
      activeChildAgentId: null,
      activeRelayId: null,
      muted: false,
      title,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertSession(session);
    await thread
      .createSentMessageFromMessage(message)
      .addReaction(emoji.eyes)
      .catch(() => {});
    if (this.config.ackEmoji)
      await thread
        .createSentMessageFromMessage(message)
        .addReaction(this.config.ackEmoji)
        .catch(() => {});
    await this.postStartedCard(thread, normalized.externalThreadId, agent.id);
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
    thread: Thread,
    externalThreadId: string,
    agentId: string,
  ): Promise<void> {
    const serverId = this.client.getLastServerInfoMessage()?.serverId ?? "local";
    const url = `${this.config.deepLinkBaseUrl}/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
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
    const finalText = await this.waitForAssistantTextBlocks({
      agentId: input.agentId,
      sinceSeq: input.sinceSeq,
      externalThreadId: input.externalThreadId,
      relayId: input.relayId,
      onFirstText: async (text) => {
        if (input.postFirstReply) {
          firstReply.text = text;
          await this.postMessage(input.thread, input.externalThreadId, {
            markdown: slackMarkdownFixups(text),
          });
        }
      },
    });
    if (!(await this.isRelayCurrent(input.externalThreadId, input.relayId))) {
      await this.store.markDeliveryCompleted(receipt);
      return;
    }

    const replyText = finalText || "Done.";
    if (replyText.trim() !== firstReply.text?.trim()) {
      await this.postMessage(input.thread, input.externalThreadId, {
        markdown: slackMarkdownFixups(replyText),
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
  }): Promise<string> {
    let firstTextPosted = false;
    let finalText = "";

    while (await this.isRelayCurrent(input.externalThreadId, input.relayId)) {
      const timeline = await this.client.fetchAgentTimeline(input.agentId, {
        direction: "tail",
        projection: "canonical",
        limit: 200,
      });
      const assistantBlocks = collectAssistantTextBlocksSince(timeline.entries, input.sinceSeq);

      const firstBlock = assistantBlocks[0];
      if (!firstTextPosted && firstBlock) {
        const status = timeline.agent?.status;
        const agentStopped = Boolean(status && status !== "initializing" && status !== "running");
        const firstBlockClosed = firstBlock.lastEntryIndex < timeline.entries.length - 1;
        if (firstBlock.text && (firstBlockClosed || agentStopped)) {
          firstTextPosted = true;
          await input.onFirstText(firstBlock.text);
        }
      }

      finalText = assistantBlocks.at(-1)?.text ?? finalText;

      const status = timeline.agent?.status;
      if (status && status !== "initializing" && status !== "running") return finalText;
      await sleep(1_000);
    }

    return finalText;
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
