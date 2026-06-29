import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { StreamChunk, Thread } from "chat";
import type { FocusRelay } from "./focus.js";
import { renderTimelineItem } from "./render.js";
import type { ThreadSessionStore } from "./state/thread-session-store.js";

class AsyncQueue<T> {
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) resolver({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}

export interface TurnStreamOptions {
  externalThreadId: string;
  agentId: string;
  showReasoning?: boolean;
  store?: ThreadSessionStore;
  focus?: FocusRelay;
  thread?: Thread;
}

export async function* turnStream(
  client: DaemonClient,
  options: TurnStreamOptions,
): AsyncIterable<StreamChunk> {
  const queue = new AsyncQueue<StreamChunk>();
  let focusedAgentId = options.agentId;
  let ended = false;

  const stopStream = client.on("agent_stream", (message) => {
    const payload = message.payload;
    if (payload.agentId !== focusedAgentId) return;
    const event = payload.event;
    if (event.type === "timeline") {
      const chunk = renderTimelineItem(event.item, { showReasoning: options.showReasoning });
      if (chunk) queue.push(chunk);
      return;
    }
    if (event.type === "turn_failed") {
      queue.push({ type: "markdown_text", text: `⚠️ Agent error: ${event.error}` });
      ended = true;
      queue.close();
      return;
    }
    if (event.type === "turn_completed" || event.type === "turn_canceled") {
      ended = true;
      queue.close();
    }
  });

  const stopUpdates = client.on("agent_update", (message) => {
    const payload = message.payload;
    if (payload.kind !== "upsert" || !options.focus) return;
    const { agent } = payload;
    void handleAgentUpdate().catch(() => {});

    async function handleAgentUpdate(): Promise<void> {
      const changed = await options.focus!.maybeFocusChild(
        options.externalThreadId,
        agent,
        options.thread,
      );
      if (changed) {
        focusedAgentId = agent.id;
        queue.push({
          type: "task_update",
          id: `focus-${agent.id}`,
          title: `Handed off to ${agent.title ?? agent.id}`,
          status: "in_progress",
        });
      }
      if (
        agent.id === focusedAgentId &&
        agent.status !== "running" &&
        agent.id !== options.agentId
      ) {
        await options.focus!.returnToRoot(options.externalThreadId, agent.id, options.thread);
        focusedAgentId = options.agentId;
      }
    }
  });

  void client.waitForFinish(options.agentId, 0).finally(() => {
    if (!ended && focusedAgentId === options.agentId) queue.close();
  });

  try {
    while (true) {
      const next = await queue.next();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    stopStream();
    stopUpdates();
  }
}
