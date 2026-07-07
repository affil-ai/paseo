import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AdapterPostableMessage, SentMessage, Thread } from "chat";
import { CHAT_THREAD_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, describe, expect, it } from "vitest";
import { ChatBridgeService } from "./service.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface PostedMessage {
  targetId: string;
  message: AdapterPostableMessage;
}

class FakeTarget {
  readonly subscribed: string[] = [];

  constructor(
    readonly id: string,
    private readonly posted: PostedMessage[],
  ) {}

  async post(message: AdapterPostableMessage): Promise<SentMessage> {
    this.posted.push({ targetId: this.id, message });
    const id = this.id.startsWith("slack:C") ? "111.222" : "333.444";
    return { id, threadId: this.id } as SentMessage;
  }

  async subscribe(): Promise<void> {
    this.subscribed.push(this.id);
  }
}

class FakeChat {
  readonly posted: PostedMessage[] = [];
  readonly targets = new Map<string, FakeTarget>();

  async openDM(userId: string): Promise<Thread> {
    return this.getTarget(`slack:D${userId}:`) as unknown as Thread;
  }

  channel(channelId: string): FakeTarget {
    return this.getTarget(`${channelId}:`);
  }

  thread(threadId: string): Thread {
    return this.getTarget(threadId) as unknown as Thread;
  }

  private getTarget(id: string): FakeTarget {
    const existing = this.targets.get(id);
    if (existing) return existing;
    const target = new FakeTarget(id, this.posted);
    this.targets.set(id, target);
    return target;
  }
}

function fakeDaemonClient(
  labels: Record<string, unknown> = { [CHAT_THREAD_ID_LABEL]: "slack:C1:111.222" },
  cwd = "/tmp/office",
) {
  return {
    sendAgentMessage: async () => {},
    fetchAgent: async () => ({ agent: { cwd, labels } }),
    fetchAgentTimeline: async () => ({ window: { nextSeq: 10 } }),
  };
}

function filePayload(mimeType = "text/csv") {
  return {
    bytesBase64: Buffer.from("hello").toString("base64"),
    filename: mimeType.startsWith("image/") ? "chart.png" : "report.csv",
    mimeType,
    size: 5,
  };
}

describe("ChatBridgeService", () => {
  it("starts and subscribes an outbound channel conversation without channel allowlist", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const chat = new FakeChat();
    const service = new ChatBridgeService(chat, fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });

    const result = await service.startConversation({
      officeAgentId: "agent-office",
      destination: { kind: "channel", id: "C123" },
      message: "hello channel",
      subscribe: true,
      idempotencyKey: "idem-start",
    });

    expect(result).toEqual({
      conversationId: result.conversationId,
      externalThreadId: "slack:C123:111.222",
    });
    await expect(store.getConversation(result.conversationId)).resolves.toMatchObject({
      kind: "outbound-conversation",
      officeAgentId: "agent-office",
      externalThreadId: "slack:C123:111.222",
    });
  });

  it("lets root agents in the configured office repo start outbound conversations", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const chat = new FakeChat();
    const service = new ChatBridgeService(chat, fakeDaemonClient({}, "/tmp/office"), store, {
      people: {},
      channels: {},
      officeRepoPath: "/tmp/office",
    });

    const result = await service.startConversation({
      officeAgentId: "agent-office",
      destination: { kind: "channel", id: "C123" },
      message: "hello channel",
    });

    expect(result.externalThreadId).toBe("slack:C123:111.222");
  });

  it("returns no_current_binding for reply without a binding", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const service = new ChatBridgeService(new FakeChat(), fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });

    await expect(
      service.reply({ officeAgentId: "agent-office", message: "hello" }),
    ).rejects.toMatchObject({ code: "no_current_binding" });
  });

  it("returns ambiguous_current_binding when reply target is unclear", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";
    await store.upsertBinding({
      kind: "inbound-session",
      externalThreadId: "slack:C1:111.222",
      rootAgentId: "agent-office",
      muted: false,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.upsertBinding({
      kind: "outbound-conversation",
      conversationId: "conv_2",
      externalThreadId: "slack:C2:333.444",
      officeAgentId: "agent-office",
      destination: { kind: "channel", id: "C2" },
      subscribed: true,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const service = new ChatBridgeService(new FakeChat(), fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });

    await expect(
      service.reply({ officeAgentId: "agent-office", message: "hello" }),
    ).rejects.toMatchObject({ code: "ambiguous_current_binding" });
  });

  it("records explicit replies as Slack-visible manual deliveries", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";
    await store.upsertBinding({
      kind: "inbound-session",
      externalThreadId: "slack:C1:111.222",
      rootAgentId: "agent-office",
      muted: false,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.startManualReplyTurn({
      externalThreadId: "slack:C1:111.222",
      turnId: "turn-1",
      agentId: "agent-office",
      startedSeq: 5,
      reminderAttempted: false,
    });
    const service = new ChatBridgeService(new FakeChat(), fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });

    await service.reply({ officeAgentId: "agent-office", message: "manual reply" });

    await expect(store.getManualReplyTurn("slack:C1:111.222")).resolves.toMatchObject({
      deliverySeq: 10,
    });
  });

  it("explicit replies suppress active auto relay for that binding", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";
    await store.upsertBinding({
      kind: "inbound-session",
      externalThreadId: "slack:C1:111.222",
      rootAgentId: "agent-office",
      muted: false,
      activeRelayId: "relay-1",
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const service = new ChatBridgeService(new FakeChat(), fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });

    await service.reply({ officeAgentId: "agent-office", message: "manual reply" });

    await expect(store.getSession("slack:C1:111.222")).resolves.toMatchObject({
      activeRelayId: null,
    });
  });

  it("posts manual replies with Markdown tables as native table cards", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const chat = new FakeChat();
    const service = new ChatBridgeService(chat, fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });
    const started = await service.startConversation({
      officeAgentId: "agent-office",
      destination: { kind: "channel", id: "C123" },
      message: "start",
    });

    await service.reply({
      officeAgentId: "agent-office",
      conversationId: started.conversationId,
      message: ["| Name | Value |", "| --- | --- |", "| Alpha | 1 |"].join("\n"),
      files: [filePayload()],
    });

    expect(chat.posted[1]?.targetId).toBe(started.externalThreadId);
    expect(chat.posted[1]?.message).toMatchObject({
      card: {
        children: [
          {
            headers: ["Name", "Value"],
            rows: [["Alpha", "1"]],
            type: "table",
          },
        ],
        type: "card",
      },
      files: [{ filename: "report.csv", mimeType: "text/csv" }],
    });
  });

  it("uploads files through Chat SDK file payloads and suppresses idempotent retries", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const chat = new FakeChat();
    const service = new ChatBridgeService(chat, fakeDaemonClient(), store, {
      people: {},
      channels: {},
    });
    const started = await service.startConversation({
      officeAgentId: "agent-office",
      destination: { kind: "channel", id: "C123" },
      message: "start",
    });

    const first = await service.sendFile({
      officeAgentId: "agent-office",
      conversationId: started.conversationId,
      message: "report attached",
      file: filePayload(),
      idempotencyKey: "idem-file",
    });
    const second = await service.sendFile({
      officeAgentId: "agent-office",
      conversationId: started.conversationId,
      message: "report attached",
      file: filePayload(),
      idempotencyKey: "idem-file",
    });

    expect(second).toEqual(first);
    const uploadPosts = chat.posted.filter(
      (post) =>
        typeof post.message === "object" && post.message !== null && "files" in post.message,
    );
    expect(uploadPosts).toHaveLength(1);
    expect(uploadPosts[0]?.message).toMatchObject({
      files: [{ filename: "report.csv", mimeType: "text/csv" }],
    });
  });

  it("stores pending asks for follow-up answer routing", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const service = new ChatBridgeService(new FakeChat(), fakeDaemonClient(), store, {
      people: { vivek: "U123" },
      channels: {},
    });

    const result = await service.ask({
      officeAgentId: "agent-office",
      destination: { kind: "person", key: "vivek" },
      question: "confirm?",
      timeoutMinutes: 5,
      scope: "person",
    });

    expect(result.status).toBe("pending");
    const binding = await store.getConversation(result.conversationId);
    expect(binding).toMatchObject({ pendingRequestId: result.requestId });
  });
});
