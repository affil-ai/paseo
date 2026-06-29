import path from "node:path";
import { z } from "zod";
import { JsonFileStore } from "./json-state.js";

export const CHAT_THREAD_LABEL = "paseo.chat-thread-id";

const ThreadSessionSchema = z.object({
  externalThreadId: z.string(),
  rootAgentId: z.string(),
  focusedAgentId: z.string(),
  muted: z.boolean().default(false),
  activeChildAgentId: z.string().nullable().default(null),
  activeRelayId: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const StoreSchema = z.object({
  sessions: z.record(z.string(), ThreadSessionSchema).default({}),
  eventReceipts: z.record(z.string(), z.string()).default({}),
  deliveryReceipts: z.record(z.string(), z.string()).default({}),
  pendingQuestions: z
    .record(
      z.string(),
      z.object({ agentId: z.string(), requestId: z.string(), createdAt: z.string() }),
    )
    .default({}),
});

export type ThreadSession = z.infer<typeof ThreadSessionSchema>;
type StoreData = z.infer<typeof StoreSchema>;

function emptyStore(): StoreData {
  return { sessions: {}, eventReceipts: {}, deliveryReceipts: {}, pendingQuestions: {} };
}

export class ThreadSessionStore {
  private readonly store: JsonFileStore<StoreData>;

  constructor(stateDir: string) {
    this.store = new JsonFileStore(path.join(stateDir, "state.json"), emptyStore(), (value) =>
      StoreSchema.parse(value),
    );
  }

  load(): Promise<StoreData> {
    return this.store.load();
  }

  async getSession(externalThreadId: string): Promise<ThreadSession | null> {
    return (await this.load()).sessions[externalThreadId] ?? null;
  }

  async upsertSession(session: ThreadSession): Promise<void> {
    await this.store.update((data) => {
      data.sessions[session.externalThreadId] = { ...session, updatedAt: new Date().toISOString() };
    });
  }

  async updateSession(
    externalThreadId: string,
    mutator: (session: ThreadSession) => ThreadSession | void,
  ): Promise<ThreadSession | null> {
    let updated: ThreadSession | null = null;
    await this.store.update((data) => {
      const current = data.sessions[externalThreadId];
      if (!current) return;
      updated = mutator(current) ?? current;
      updated.updatedAt = new Date().toISOString();
      data.sessions[externalThreadId] = updated;
    });
    return updated;
  }

  async findSessionByAgent(agentId: string): Promise<ThreadSession | null> {
    const sessions = Object.values((await this.load()).sessions);
    return (
      sessions.find(
        (session) =>
          session.rootAgentId === agentId ||
          session.focusedAgentId === agentId ||
          session.activeChildAgentId === agentId,
      ) ?? null
    );
  }

  async deleteSession(externalThreadId: string): Promise<void> {
    await this.store.update((data) => {
      delete data.sessions[externalThreadId];
      delete data.pendingQuestions[externalThreadId];
    });
  }

  async markEventProcessed(eventId: string): Promise<boolean> {
    let fresh = false;
    await this.store.update((data) => {
      if (data.eventReceipts[eventId]) return;
      data.eventReceipts[eventId] = new Date().toISOString();
      fresh = true;
    });
    return fresh;
  }

  async markDeliveryStarted(key: string): Promise<boolean> {
    let fresh = false;
    await this.store.update((data) => {
      if (data.deliveryReceipts[key] === "completed") return;
      data.deliveryReceipts[key] = "started";
      fresh = true;
    });
    return fresh;
  }

  async markDeliveryCompleted(key: string): Promise<void> {
    await this.store.update((data) => {
      data.deliveryReceipts[key] = "completed";
    });
  }

  async setPendingQuestion(
    externalThreadId: string,
    agentId: string,
    requestId: string,
  ): Promise<void> {
    await this.store.update((data) => {
      data.pendingQuestions[externalThreadId] = {
        agentId,
        requestId,
        createdAt: new Date().toISOString(),
      };
    });
  }

  async takePendingQuestion(
    externalThreadId: string,
  ): Promise<{ agentId: string; requestId: string } | null> {
    let question: { agentId: string; requestId: string } | null = null;
    await this.store.update((data) => {
      const current = data.pendingQuestions[externalThreadId];
      if (!current) return;
      question = { agentId: current.agentId, requestId: current.requestId };
      delete data.pendingQuestions[externalThreadId];
    });
    return question;
  }
}
