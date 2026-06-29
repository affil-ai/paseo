import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Thread } from "chat";
import { CHAT_THREAD_LABEL, type ThreadSessionStore } from "./state/thread-session-store.js";

export class FocusRelay {
  constructor(
    private readonly client: DaemonClient,
    private readonly store: ThreadSessionStore,
  ) {}

  async maybeFocusChild(
    externalThreadId: string,
    agent: AgentSnapshotPayload,
    thread?: Thread,
  ): Promise<boolean> {
    const session = await this.store.getSession(externalThreadId);
    if (!session) return false;
    if (getParentAgentIdFromLabels(agent.labels) !== session.rootAgentId) return false;
    if (session.activeChildAgentId && session.activeChildAgentId !== agent.id) return false;
    if (session.focusedAgentId === agent.id) return false;

    await this.client
      .updateAgent(agent.id, { labels: { ...agent.labels, [CHAT_THREAD_LABEL]: externalThreadId } })
      .catch(() => {});
    await this.store.updateSession(externalThreadId, (current) => {
      current.focusedAgentId = agent.id;
      current.activeChildAgentId = agent.id;
    });
    if (thread)
      await thread.post(`🔧 handed off to a coding agent${agent.title ? `: ${agent.title}` : ""}.`);
    return true;
  }

  async returnToRoot(
    externalThreadId: string,
    childAgentId: string,
    thread?: Thread,
  ): Promise<void> {
    const session = await this.store.getSession(externalThreadId);
    if (!session || session.focusedAgentId !== childAgentId) return;
    await this.store.updateSession(externalThreadId, (current) => {
      current.focusedAgentId = current.rootAgentId;
      current.activeChildAgentId = null;
    });
    if (thread) await thread.post("↩️ returned focus to the office agent.");
  }

  async escapeToRoot(externalThreadId: string): Promise<void> {
    await this.store.updateSession(externalThreadId, (current) => {
      current.focusedAgentId = current.rootAgentId;
    });
  }
}
