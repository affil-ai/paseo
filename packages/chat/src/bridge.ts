import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  emoji,
  LinkButton,
  Actions,
  Card,
  type AdapterPostableMessage,
  type Message,
  type StreamChunk,
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
import { CHAT_THREAD_LABEL, ThreadSessionStore } from "./state/thread-session-store.js";
import { turnStream } from "./turn-stream.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatBridge {
  private customOfficePrompt: Promise<string>;

  constructor(
    private readonly config: ChatBridgeConfig,
    private readonly client: DaemonClient,
    private readonly store: ThreadSessionStore,
    private readonly permissions: PermissionBridge,
    private readonly focus: FocusRelay,
  ) {
    this.customOfficePrompt = loadOfficePrompt(config);
  }

  private readonly threads = new Map<string, Thread>();

  getThread(externalThreadId: string): Thread | null {
    return this.threads.get(externalThreadId) ?? null;
  }

  async handleMessage(
    thread: Thread,
    message: Message,
    source: "mention" | "dm" | "subscribed",
  ): Promise<void> {
    const normalized = await normalizeMessage(thread, message);
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

  private startBackgroundRelay(input: {
    thread: Thread;
    externalThreadId: string;
    agentId: string;
    messageId: string;
    source: string;
    sinceSeq: number;
    relayId: string;
  }): void {
    void this.relayTurn(input).catch(async (error) => {
      console.warn("Slack relay failed", error);
      if (!(await this.isRelayCurrent(input.externalThreadId, input.relayId))) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.postMessage(
        input.thread,
        input.externalThreadId,
        `I couldn't relay the agent response. Reason: ${reason}`,
      ).catch(() => {});
    });
  }

  private async relayTurn(input: {
    thread: Thread;
    externalThreadId: string;
    agentId: string;
    messageId: string;
    source: string;
    sinceSeq: number;
    relayId: string;
  }): Promise<void> {
    const receipt = `slack:${input.externalThreadId}:${input.messageId}:${input.source}:stream`;
    if (!(await this.store.markDeliveryStarted(receipt))) return;

    const streamedAssistantText = await this.drainTurnStream(
      turnStream(this.client, {
        externalThreadId: input.externalThreadId,
        agentId: input.agentId,
        showReasoning: this.config.showReasoning,
        store: this.store,
        focus: this.focus,
        thread: input.thread,
      }),
    );

    if (!(await this.isRelayCurrent(input.externalThreadId, input.relayId))) {
      await this.store.markDeliveryCompleted(receipt);
      return;
    }

    const finalText = await this.waitForFinalAssistantText(input.agentId, input.sinceSeq);
    if (!(await this.isRelayCurrent(input.externalThreadId, input.relayId))) {
      await this.store.markDeliveryCompleted(receipt);
      return;
    }

    const replyText = finalText || streamedAssistantText || "Done.";
    await this.postMessage(input.thread, input.externalThreadId, {
      markdown: slackMarkdownFixups(replyText),
    });

    await this.store.updateSession(input.externalThreadId, (current) => {
      if (current.activeRelayId === input.relayId) current.activeRelayId = null;
    });
    await this.store.markDeliveryCompleted(receipt);
  }

  private async isRelayCurrent(externalThreadId: string, relayId: string): Promise<boolean> {
    const session = await this.store.getSession(externalThreadId);
    return session?.activeRelayId === relayId;
  }

  private async drainTurnStream(stream: AsyncIterable<StreamChunk>): Promise<string> {
    let assistantText = "";
    for await (const chunk of stream) {
      // Intentionally drained for lifecycle/focus side effects only. Slack should get one final
      // assistant reply, not intermediate streamed/partial messages.
      if (chunk.type === "markdown_text") assistantText += chunk.text;
    }
    return assistantText.trim();
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
    thread: Thread,
    externalThreadId: string,
    message: string | AdapterPostableMessage,
  ): Promise<void> {
    if (thread.id === externalThreadId) {
      await thread.post(message);
      return;
    }
    await thread.adapter.postMessage(externalThreadId, message);
  }
}
