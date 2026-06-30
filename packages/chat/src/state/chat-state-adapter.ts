import path from "node:path";
import type { Lock, QueueEntry, StateAdapter } from "chat";
import { JsonFileStore } from "./json-state.js";

interface KvEntry {
  value: unknown;
  expiresAt: number | null;
}

interface ListEntry {
  values: unknown[];
  expiresAt: number | null;
}

interface ChatStateData {
  subscriptions: string[];
  kv: Record<string, KvEntry>;
  lists: Record<string, ListEntry>;
  queues: Record<string, QueueEntry[]>;
}

function empty(): ChatStateData {
  return { subscriptions: [], kv: {}, lists: {}, queues: {} };
}

function notExpired(entry: { expiresAt: number | null } | undefined): boolean {
  return !entry || entry.expiresAt === null || entry.expiresAt > Date.now();
}

export class FileChatStateAdapter implements StateAdapter {
  private readonly store: JsonFileStore<ChatStateData>;
  private readonly locks = new Map<string, Lock>();

  constructor(stateDir: string) {
    this.store = new JsonFileStore(
      path.join(stateDir, "chat-sdk-state.json"),
      empty(),
      (value) => ({
        ...empty(),
        ...(value as Partial<ChatStateData>),
      }),
    );
  }

  async connect(): Promise<void> {
    await this.store.load();
  }

  async disconnect(): Promise<void> {}

  async subscribe(threadId: string): Promise<void> {
    await this.store.update((data) => {
      if (!data.subscriptions.includes(threadId)) data.subscriptions.push(threadId);
    });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.store.update((data) => {
      data.subscriptions = data.subscriptions.filter((id) => id !== threadId);
    });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return (await this.store.load()).subscriptions.includes(threadId);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = (await this.store.load()).kv[key];
    if (!entry || !notExpired(entry)) return null;
    return entry.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.store.update((data) => {
      data.kv[key] = { value, expiresAt: ttlMs ? Date.now() + ttlMs : null };
    });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    let didSet = false;
    await this.store.update((data) => {
      if (data.kv[key] && notExpired(data.kv[key])) return;
      data.kv[key] = { value, expiresAt: ttlMs ? Date.now() + ttlMs : null };
      didSet = true;
    });
    return didSet;
  }

  async delete(key: string): Promise<void> {
    await this.store.update((data) => {
      delete data.kv[key];
      delete data.lists[key];
    });
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    await this.store.update((data) => {
      const current = data.lists[key];
      const values = current && notExpired(current) ? current.values : [];
      values.push(value);
      data.lists[key] = {
        values: options?.maxLength ? values.slice(-options.maxLength) : values,
        expiresAt: options?.ttlMs ? Date.now() + options.ttlMs : (current?.expiresAt ?? null),
      };
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const entry = (await this.store.load()).lists[key];
    if (!entry || !notExpired(entry)) return [];
    return entry.values as T[];
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    let depth = 0;
    await this.store.update((data) => {
      const queue = data.queues[threadId] ?? [];
      queue.push(entry);
      data.queues[threadId] = queue.slice(-maxSize);
      depth = data.queues[threadId].length;
    });
    return depth;
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    let entry: QueueEntry | null = null;
    await this.store.update((data) => {
      const queue = data.queues[threadId] ?? [];
      entry = queue.shift() ?? null;
      data.queues[threadId] = queue;
    });
    return entry;
  }

  async queueDepth(threadId: string): Promise<number> {
    return ((await this.store.load()).queues[threadId] ?? []).length;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const existing = this.locks.get(threadId);
    if (existing && existing.expiresAt > Date.now()) return null;
    const lock = { threadId, token: crypto.randomUUID(), expiresAt: Date.now() + ttlMs };
    this.locks.set(threadId, lock);
    return lock;
  }

  async releaseLock(lock: Lock): Promise<void> {
    if (this.locks.get(lock.threadId)?.token === lock.token) this.locks.delete(lock.threadId);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(lock.threadId);
    if (existing?.token !== lock.token) return false;
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.locks.delete(threadId);
  }
}
