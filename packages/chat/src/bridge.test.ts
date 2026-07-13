import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message } from "chat";
import { describe, expect, it } from "vitest";
import {
  buildStartedCardUrl,
  ChatBridge,
  type ChatBridgeClient,
  type ChatBridgeThread,
} from "./bridge.js";
import { loadConfig } from "./config.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";

interface PriorSlackMessage {
  id: string;
  text: string;
  authorName: string;
}

interface SlackSessionCreationInput {
  isDM: boolean;
  priorMessages: PriorSlackMessage[];
}

class SessionCreationClient implements ChatBridgeClient {
  readonly createWorkspaceCalls: Array<Parameters<ChatBridgeClient["createWorkspace"]>[0]> = [];
  readonly createAgentCalls: Array<Parameters<ChatBridgeClient["createAgent"]>[0]> = [];

  async archiveAgent(): Promise<never> {
    throw new Error("archiveAgent is not available in the session creation test client");
  }

  async createWorkspace(input: Parameters<ChatBridgeClient["createWorkspace"]>[0]) {
    this.createWorkspaceCalls.push(input);
    return { workspace: { id: "workspace-1" } };
  }

  async createAgent(input: Parameters<ChatBridgeClient["createAgent"]>[0]) {
    this.createAgentCalls.push(input);
    return { id: "agent-1" };
  }

  async fetchAgent(): Promise<never> {
    throw new Error("fetchAgent is not available in the session creation test client");
  }

  async fetchAgentTimeline(): Promise<never> {
    throw new Error("fetchAgentTimeline is not available in the session creation test client");
  }

  getLastServerInfoMessage() {
    return { serverId: "local" };
  }

  async sendAgentMessage(): Promise<never> {
    throw new Error("sendAgentMessage is not available in the session creation test client");
  }
}

interface RelayTurnInput {
  thread: { id: string; post: (message: unknown) => Promise<void>; adapter: object };
  externalThreadId: string;
  agentId: string;
  messageId: string;
  source: string;
  sinceSeq: number;
  relayId: string;
  postFirstReply: boolean;
}

type TimelineItem =
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string };

function timelineEntry(seq: number, item: TimelineItem) {
  return {
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [],
    collapsed: [],
    item,
  };
}

async function runAutoRelayWithTimeline(items: TimelineItem[]) {
  const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
  const externalThreadId = "slack:D123:111.222";
  const rootAgentId = "agent-1";
  const relayId = "relay-1";
  const store = new ThreadSessionStore(stateDir);
  const postedMessages: unknown[] = [];
  await store.upsertSession({
    kind: "inbound-session",
    externalThreadId,
    rootAgentId,
    muted: false,
    activeRelayId: relayId,
    title: "existing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const client = {
    fetchAgentTimeline: async () => ({
      entries: items.map((item, index) => timelineEntry(index + 1, item)),
      agent: { status: "idle" },
    }),
  };
  const bridge = new ChatBridge(
    {
      stateDir,
      relayMode: "auto",
      officeRepoPath: "/tmp/office",
      provider: "pi",
      model: "openrouter/anthropic/claude-fable-5",
      modeId: "",
      thinkingOptionId: "high",
      deepLinkBaseUrl: "https://paseo.example",
    } as never,
    client as never,
    store,
    { answerPendingQuestion: async () => false } as never,
    {} as never,
  );
  const thread = {
    id: externalThreadId,
    adapter: {},
    post: async (message: unknown) => {
      postedMessages.push(message);
    },
  };
  const relayTurn = (bridge as unknown as { relayTurn: (input: RelayTurnInput) => Promise<void> })
    .relayTurn;

  await relayTurn.call(bridge, {
    thread,
    externalThreadId,
    agentId: rootAgentId,
    messageId: "333.444",
    source: "test",
    sinceSeq: 1,
    relayId,
    postFirstReply: true,
  });

  return {
    stateDir,
    store,
    externalThreadId,
    rootAgentId,
    postedMessages,
    deliveryReceipt: `slack:${externalThreadId}:333.444:test:turn`,
  };
}

function createSlackMessage(input: {
  id: string;
  threadId: string;
  text: string;
  userId: string;
  authorName: string;
  authorHandle: string;
  isMention?: boolean;
}): Message {
  return new Message({
    id: input.id,
    threadId: input.threadId,
    text: input.text,
    formatted: { type: "root", children: [] },
    raw: { text: input.text, thread_ts: "111.222" },
    author: {
      userId: input.userId,
      userName: input.authorHandle,
      fullName: input.authorName,
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
    links: [],
    isMention: input.isMention,
  });
}

async function runSlackSessionCreation(input: SlackSessionCreationInput) {
  const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
  async function cleanup(): Promise<void> {
    await rm(stateDir, { recursive: true, force: true });
  }
  try {
    const client = new SessionCreationClient();
    const config = {
      ...loadConfig({
        PASEO_HOME: stateDir,
        PASEO_CHAT_STATE_DIR: stateDir,
        PASEO_CHAT_RELAY_MODE: "manual",
        PASEO_CHAT_DEEP_LINK_BASE_URL: "https://paseo.example",
      }),
      officeRepoPath: "/tmp/office",
    };
    const bridge = new ChatBridge(
      config,
      client,
      new ThreadSessionStore(stateDir),
      { answerPendingQuestion: async () => false },
      { escapeToRoot: async () => {} },
    );
    const threadId = input.isDM ? "slack:D123:111.222" : "slack:C123:111.222";
    let capturedThreadReads = 0;
    const allMessages = {
      async *[Symbol.asyncIterator]() {
        capturedThreadReads += 1;
        for (const [index, priorMessage] of input.priorMessages.entries()) {
          yield createSlackMessage({
            id: priorMessage.id,
            threadId,
            text: priorMessage.text,
            userId: `U${index + 2}`,
            authorName: priorMessage.authorName,
            authorHandle: priorMessage.authorName,
          });
        }
      },
    };
    const thread: ChatBridgeThread = {
      id: threadId,
      isDM: input.isDM,
      allMessages,
      subscribe: async () => {},
      post: async () => {},
      createSentMessageFromMessage: () => ({ addReaction: async () => {} }),
      adapter: {
        botUserId: "UCTO",
        postMessage: async () => {},
      },
    };
    const message = createSlackMessage({
      id: "333.444",
      threadId,
      text: "<@UCTO> debug, no mid turn replies",
      userId: "U1",
      authorName: "Vivek",
      authorHandle: "vivek",
      isMention: true,
    });

    await bridge.handleMessage(thread, message, input.isDM ? "dm" : "mention");

    return {
      cleanup,
      createWorkspaceCalls: client.createWorkspaceCalls,
      createAgentCalls: client.createAgentCalls,
      capturedThreadReads,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("buildStartedCardUrl", () => {
  it("links directly to the workspace route with an agent open intent", () => {
    expect(
      buildStartedCardUrl({
        baseUrl: "https://affil.olumbe.com/",
        serverId: "srv_iZJtVKHVcWXG",
        workspaceId: "wks_8194146bcb474423",
        agentId: "agt_123",
      }),
    ).toBe(
      "https://affil.olumbe.com/h/srv_iZJtVKHVcWXG/workspace/wks_8194146bcb474423?open=agent%3Aagt_123",
    );
  });

  it("base64url-encodes path-shaped workspace ids like the app route helper", () => {
    expect(
      buildStartedCardUrl({
        baseUrl: "https://paseo.example",
        serverId: "server/one",
        workspaceId: "/home/user/project",
        agentId: "agent:one",
      }),
    ).toBe(
      "https://paseo.example/h/server%2Fone/workspace/b64_L2hvbWUvdXNlci9wcm9qZWN0?open=agent%3Aagent%3Aone",
    );
  });
});

describe("ChatBridge session creation", () => {
  it("passes external intake instructions as provider systemPrompt", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const store = new ThreadSessionStore(stateDir);
      const createAgentCalls: unknown[] = [];
      const createWorkspaceCalls: unknown[] = [];
      const client = {
        createWorkspace: async (input: unknown) => {
          createWorkspaceCalls.push(input);
          return { workspace: { id: "workspace-1" } };
        },
        createAgent: async (input: unknown) => {
          createAgentCalls.push(input);
          return { id: "agent-1" };
        },
        getLastServerInfoMessage: () => ({ serverId: "local" }),
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "manual",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );
      const thread = {
        id: "slack:D123:111.222",
        adapter: {},
        post: async () => {},
      };

      await bridge.createExternalSession({
        externalThreadId: "slack:D123:111.222",
        source: "slack",
        title: "Slack request",
        workspaceTitlePrompt: "please check this",
        systemPrompt: "system rules",
        initialPrompt: "Jane: please check this",
        startedBy: {
          source: "slack",
          userId: "U123",
          name: "Jane Doe",
          handle: "jane",
          avatarUrl: "https://example.com/jane.png",
        },
        thread: thread as never,
      });

      expect(createAgentCalls).toEqual([
        expect.objectContaining({
          systemPrompt: "system rules",
          initialPrompt: "Jane: please check this",
          clientMessageId: expect.any(String),
          initialMessageSource: "slack",
          labels: expect.objectContaining({
            "paseo.chat-source": "slack",
            "paseo.chat-started-by-avatar-url": "https://example.com/jane.png",
            "paseo.chat-started-by-handle": "jane",
            "paseo.chat-started-by-name": "Jane Doe",
            "paseo.chat-started-by-source": "slack",
            "paseo.chat-started-by-user-id": "U123",
            "paseo.chat-thread-id": "slack:D123:111.222",
          }),
        }),
      ]);
      expect(createWorkspaceCalls).toEqual([
        {
          source: { kind: "directory", path: "/tmp/office" },
          firstAgentContext: {
            prompt: "please check this",
            attachments: [],
          },
        },
      ]);
      await expect(store.getSession("slack:D123:111.222")).resolves.toMatchObject({
        startedBy: {
          source: "slack",
          userId: "U123",
          name: "Jane Doe",
          handle: "jane",
          avatarUrl: "https://example.com/jane.png",
        },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses prior Slack thread context and the triggering message for workspace naming", async () => {
    const priorContext =
      "John Ta: @Vishal i think newly added got killed in the recent rerun right? probably want to just manually assign the comparison list to the July 10, 2026 list right?";
    const sessionHarness = await runSlackSessionCreation({
      isDM: false,
      priorMessages: [
        {
          id: "111.222",
          text: priorContext.slice("John Ta: ".length),
          authorName: "John Ta",
        },
      ],
    });
    try {
      expect(sessionHarness.createWorkspaceCalls).toEqual([
        {
          source: { kind: "directory", path: "/tmp/office" },
          firstAgentContext: {
            prompt: `${priorContext}\n\ndebug, no mid turn replies`,
            attachments: [],
          },
        },
      ]);
      expect(sessionHarness.createAgentCalls).toEqual([
        expect.objectContaining({
          initialPrompt: `Prior thread context:\n${priorContext}\n\nREMINDER: This came from Slack. Manual delivery is on. Slack will not see your final assistant message unless you call chat.send. Always end this turn with one final chat.send; skip only if the user explicitly asks for no more Slack messages. Use mid-turn chat.send sparingly per the system Slack delivery rules.\n\nVivek (@vivek): debug, no mid turn replies`,
        }),
      ]);
      expect(sessionHarness.capturedThreadReads).toBe(1);
    } finally {
      await sessionHarness.cleanup();
    }
  });

  it("uses only the triggering message when a channel thread has no prior context", async () => {
    const sessionHarness = await runSlackSessionCreation({ isDM: false, priorMessages: [] });
    try {
      expect(sessionHarness.createWorkspaceCalls).toEqual([
        {
          source: { kind: "directory", path: "/tmp/office" },
          firstAgentContext: {
            prompt: "debug, no mid turn replies",
            attachments: [],
          },
        },
      ]);
      expect(sessionHarness.createAgentCalls).toEqual([
        expect.objectContaining({
          initialPrompt: `REMINDER: This came from Slack. Manual delivery is on. Slack will not see your final assistant message unless you call chat.send. Always end this turn with one final chat.send; skip only if the user explicitly asks for no more Slack messages. Use mid-turn chat.send sparingly per the system Slack delivery rules.\n\nVivek (@vivek): debug, no mid turn replies`,
        }),
      ]);
      expect(sessionHarness.capturedThreadReads).toBe(1);
    } finally {
      await sessionHarness.cleanup();
    }
  });

  it("does not capture thread context for direct messages", async () => {
    const sessionHarness = await runSlackSessionCreation({
      isDM: true,
      priorMessages: [
        {
          id: "111.222",
          text: "this DM history must not be captured",
          authorName: "John Ta",
        },
      ],
    });
    try {
      expect(sessionHarness.createWorkspaceCalls).toEqual([
        {
          source: { kind: "directory", path: "/tmp/office" },
          firstAgentContext: {
            prompt: "debug, no mid turn replies",
            attachments: [],
          },
        },
      ]);
      expect(sessionHarness.createAgentCalls).toEqual([
        expect.objectContaining({
          initialPrompt: `REMINDER: This came from Slack. Manual delivery is on. Slack will not see your final assistant message unless you call chat.send. Always end this turn with one final chat.send; skip only if the user explicitly asks for no more Slack messages. Use mid-turn chat.send sparingly per the system Slack delivery rules.\n\nVivek (@vivek): debug, no mid turn replies`,
        }),
      ]);
      expect(sessionHarness.capturedThreadReads).toBe(0);
    } finally {
      await sessionHarness.cleanup();
    }
  });
});

describe("ChatBridge auto relay", () => {
  it("does not post system-error-only artifacts or fall back to Done", async () => {
    const result = await runAutoRelayWithTimeline([
      {
        type: "assistant_message",
        text: " [System Error] fetch failed (stopReason=error, model=openrouter/anthropic/claude-fable-5)",
      },
    ]);
    try {
      expect(result.postedMessages).toEqual([]);
      const state = await result.store.load();
      expect(state.sessions[result.externalThreadId]?.activeRelayId).toBeNull();
      expect(state.deliveryReceipts[result.deliveryReceipt]?.status).toBe("completed");
      expect(state.auditRecords).toEqual([]);
    } finally {
      await rm(result.stateDir, { recursive: true, force: true });
    }
  });

  it("posts only the normal answer when a system-error artifact follows it", async () => {
    const result = await runAutoRelayWithTimeline([
      { type: "assistant_message", text: "The report is ready." },
      { type: "reasoning", text: "separator" },
      {
        type: "assistant_message",
        text: "[System Error] fetch failed (stopReason=error, model=openrouter/anthropic/claude-fable-5)",
      },
    ]);
    try {
      expect(result.postedMessages).toEqual([{ markdown: "The report is ready." }]);
      const state = await result.store.load();
      expect(state.deliveryReceipts[result.deliveryReceipt]?.status).toBe("completed");
      expect(state.auditRecords).toHaveLength(1);
      expect(state.auditRecords[0]).toMatchObject({
        officeAgentId: result.rootAgentId,
        toolName: "chat.autoRelay.first",
        messagePreview: "The report is ready.",
        result: "posted",
      });
    } finally {
      await rm(result.stateDir, { recursive: true, force: true });
    }
  });

  it("posts Markdown tables as native table cards during auto relay", async () => {
    const result = await runAutoRelayWithTimeline([
      {
        type: "assistant_message",
        text: ["| Name | Value |", "| --- | --- |", "| Alpha | 1 |"].join("\n"),
      },
    ]);
    try {
      expect(result.postedMessages).toMatchObject([
        {
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
        },
      ]);
    } finally {
      await rm(result.stateDir, { recursive: true, force: true });
    }
  });

  it("posts only the normal answer when it follows a system-error artifact", async () => {
    const result = await runAutoRelayWithTimeline([
      {
        type: "assistant_message",
        text: "[System Error] fetch failed (stopReason=error, model=openrouter/anthropic/claude-fable-5)",
      },
      { type: "reasoning", text: "separator" },
      { type: "assistant_message", text: "I found the root cause." },
    ]);
    try {
      expect(result.postedMessages).toEqual([{ markdown: "I found the root cause." }]);
      const state = await result.store.load();
      expect(state.deliveryReceipts[result.deliveryReceipt]?.status).toBe("completed");
      expect(state.auditRecords).toHaveLength(1);
      expect(state.auditRecords[0]).toMatchObject({
        officeAgentId: result.rootAgentId,
        toolName: "chat.autoRelay.first",
        messagePreview: "I found the root cause.",
        result: "posted",
      });
    } finally {
      await rm(result.stateDir, { recursive: true, force: true });
    }
  });
});

describe("ChatBridge follow-up delivery", () => {
  it("routes subscribed outbound conversation replies to the owning office agent", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const externalThreadId = "slack:C123:111.222";
      const officeAgentId = "agent-office";
      const store = new ThreadSessionStore(stateDir);
      const timestamp = new Date().toISOString();
      await store.upsertBinding({
        kind: "outbound-conversation",
        conversationId: "conv_1",
        externalThreadId,
        officeAgentId,
        destination: { kind: "channel", id: "C123" },
        subscribed: true,
        activeRelayId: null,
        title: "outbound",
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const sendCalls: Array<{ agentId: string; text: string }> = [];
      let createAgentCalls = 0;
      const client = {
        createAgent: async () => {
          createAgentCalls += 1;
          throw new Error("should not create a new agent for outbound replies");
        },
        createWorkspace: async () => {
          throw new Error("should not create a new workspace for outbound replies");
        },
        fetchAgentTimeline: async () => ({ window: { nextSeq: 7 } }),
        waitForFinish: async () => new Promise(() => {}),
        sendAgentMessage: async (agentId: string, text: string) => {
          sendCalls.push({ agentId, text });
        },
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "manual",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );

      const thread = {
        id: externalThreadId,
        isDM: false,
        subscribe: async () => {},
        adapter: {},
      };
      const message = {
        id: "333.444",
        text: "yes, sounds good",
        raw: { text: "yes, sounds good", thread_ts: "111.222" },
        author: {
          userId: "U1",
          userName: "vivek",
          fullName: "Vivek",
          isBot: false,
          isMe: false,
        },
        attachments: [],
        links: [],
        isMention: false,
      };

      await bridge.handleMessage(thread as never, message as never, "subscribed");

      expect(createAgentCalls).toBe(0);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]).toMatchObject({ agentId: officeAgentId });
      expect(sendCalls[0]?.text).toContain("yes, sounds good");
      expect(await store.hasEventReceipt(`slack:${externalThreadId}:333.444`)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("marks a Slack follow-up processed only after the agent accepts it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const externalThreadId = "slack:D123:111.222";
      const rootAgentId = "agent-1";
      const store = new ThreadSessionStore(stateDir);
      await store.upsertSession({
        kind: "inbound-session",
        externalThreadId,
        rootAgentId,
        muted: false,
        activeRelayId: null,
        title: "existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const sendCalls: Array<{ agentId: string; text: string }> = [];
      const client = {
        fetchAgentTimeline: async () => ({ window: { nextSeq: 1 } }),
        sendAgentMessage: async (agentId: string, text: string) => {
          expect(await store.hasEventReceipt(`slack:${externalThreadId}:333.444`)).toBe(false);
          sendCalls.push({ agentId, text });
        },
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "manual",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );

      const thread = {
        id: externalThreadId,
        isDM: false,
        subscribe: async () => {},
        adapter: {},
      };
      const message = {
        id: "333.444",
        text: "only do apps/web",
        raw: { text: "only do apps/web", thread_ts: "111.222" },
        author: {
          userId: "U1",
          userName: "vivek",
          fullName: "Vivek",
          isBot: false,
          isMe: false,
        },
        attachments: [],
        links: [],
        isMention: false,
      };

      await bridge.handleMessage(thread as never, message as never, "subscribed");

      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]).toMatchObject({ agentId: rootAgentId });
      expect(sendCalls[0]?.text).toContain("only do apps/web");
      expect(await store.hasEventReceipt(`slack:${externalThreadId}:333.444`)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores bot-authored Slack messages on existing sessions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const externalThreadId = "slack:C123:111.222";
      const rootAgentId = "agent-1";
      const store = new ThreadSessionStore(stateDir);
      await store.upsertSession({
        kind: "inbound-session",
        externalThreadId,
        rootAgentId,
        muted: false,
        activeRelayId: null,
        title: "existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const sendCalls: Array<{ agentId: string; text: string }> = [];
      const client = {
        fetchAgentTimeline: async () => ({ window: { nextSeq: 1 } }),
        sendAgentMessage: async (agentId: string, text: string) => {
          sendCalls.push({ agentId, text });
        },
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "manual",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );

      const thread = {
        id: externalThreadId,
        isDM: false,
        subscribe: async () => {},
        adapter: {},
      };
      const message = {
        id: "333.444",
        text: "Final response: stopped.",
        raw: { text: "Final response: stopped.", thread_ts: "111.222" },
        author: {
          userId: "U0BEGMBCB2L",
          userName: "office-of-the-cto",
          fullName: "Office of the CTO",
          isBot: true,
          isMe: false,
        },
        attachments: [],
        links: [],
        isMention: false,
      };

      await bridge.handleMessage(thread as never, message as never, "subscribed");

      expect(sendCalls).toHaveLength(0);
      expect(await store.hasEventReceipt(`slack:${externalThreadId}:333.444`)).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("mutes and sends the command to the agent as context only", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const externalThreadId = "slack:C123:111.222";
      const rootAgentId = "agent-1";
      const store = new ThreadSessionStore(stateDir);
      await store.upsertSession({
        kind: "inbound-session",
        externalThreadId,
        rootAgentId,
        muted: false,
        activeRelayId: "relay-1",
        title: "existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const sendCalls: Array<{ agentId: string; text: string }> = [];
      const client = {
        fetchAgentTimeline: async () => ({ window: { nextSeq: 1 } }),
        archiveAgent: async () => {
          throw new Error("mute should not archive the agent");
        },
        sendAgentMessage: async (agentId: string, text: string) => {
          sendCalls.push({ agentId, text });
        },
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "manual",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );

      const thread = {
        id: externalThreadId,
        isDM: false,
        subscribe: async () => {},
        createSentMessageFromMessage: () => ({
          addReaction: async () => {},
        }),
        adapter: {},
      };
      const message = {
        id: "333.444",
        text: "<@U0BEGMBCB2L> dude shut up mute stop",
        raw: { text: "<@U0BEGMBCB2L> dude shut up mute stop", thread_ts: "111.222" },
        author: {
          userId: "U1",
          userName: "john",
          fullName: "John",
          isBot: false,
          isMe: false,
        },
        attachments: [],
        links: [],
        isMention: true,
      };

      await bridge.handleMessage(thread as never, message as never, "mention");

      expect(sendCalls).toEqual([
        {
          agentId: rootAgentId,
          text: expect.stringContaining("This Slack message is context only."),
        },
      ]);
      expect(sendCalls[0]?.text).toContain("Do not respond.");
      expect(sendCalls[0]?.text).toContain("Continue what you were doing.");
      expect(sendCalls[0]?.text).toContain("John (@john): dude shut up mute stop");
      await expect(store.getSession(externalThreadId)).resolves.toMatchObject({
        muted: true,
        activeRelayId: null,
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("archives only an exact command that explicitly mentions the bot", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const externalThreadId = "slack:C123:111.222";
      const rootAgentId = "agent-1";
      const store = new ThreadSessionStore(stateDir);
      await store.upsertSession({
        kind: "inbound-session",
        externalThreadId,
        rootAgentId,
        muted: false,
        activeRelayId: "relay-1",
        title: "existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const archivedAgents: string[] = [];
      const sentMessages: string[] = [];
      const postedMessages: unknown[] = [];
      const reactions: Array<{ messageId: string; emoji: string }> = [];
      const client = {
        archiveAgent: async (agentId: string) => {
          archivedAgents.push(agentId);
        },
        fetchAgentTimeline: async () => ({ window: { nextSeq: 1 } }),
        sendAgentMessage: async (_agentId: string, text: string) => {
          sentMessages.push(text);
        },
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "manual",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );

      const thread = {
        id: externalThreadId,
        isDM: false,
        subscribe: async () => {},
        post: async (message: unknown) => {
          postedMessages.push(message);
        },
        createSentMessageFromMessage: (message: { id: string }) => ({
          addReaction: async (emoji: string) => {
            reactions.push({ messageId: message.id, emoji });
          },
        }),
        adapter: {},
      };
      const author = {
        userId: "U1",
        userName: "john",
        fullName: "John",
        isBot: false,
        isMe: false,
      };
      for (const [id, text] of [
        ["333.441", "done"],
        ["333.442", "archive"],
      ]) {
        await bridge.handleMessage(
          thread as never,
          {
            id,
            text,
            raw: { text, thread_ts: "111.222" },
            author,
            attachments: [],
            links: [],
            isMention: false,
          } as never,
          "subscribed",
        );
      }

      expect(archivedAgents).toEqual([]);
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0]).toContain("John (@john): done");
      expect(sentMessages[1]).toContain("John (@john): archive");
      await expect(store.getSession(externalThreadId)).resolves.not.toBeNull();

      const message = {
        id: "333.444",
        text: "<@UCTO> done",
        raw: { text: "<@UCTO> done", thread_ts: "111.222" },
        author,
        attachments: [],
        links: [],
        isMention: true,
      };
      await bridge.handleMessage(thread as never, message as never, "subscribed");

      expect(archivedAgents).toEqual([rootAgentId]);
      await expect(store.getSession(externalThreadId)).resolves.toBeNull();
      expect(reactions).toEqual([{ messageId: "111.222", emoji: "wastebasket" }]);
      expect(postedMessages).toEqual(["Archived the office agent for this thread."]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sends aside messages to the agent as context only without starting relay", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    try {
      const externalThreadId = "slack:C123:111.222";
      const rootAgentId = "agent-1";
      const store = new ThreadSessionStore(stateDir);
      await store.upsertSession({
        kind: "inbound-session",
        externalThreadId,
        rootAgentId,
        muted: false,
        activeRelayId: "relay-1",
        title: "existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const sendCalls: Array<{ agentId: string; text: string }> = [];
      const client = {
        fetchAgentTimeline: async () => ({ window: { nextSeq: 1 } }),
        archiveAgent: async () => {
          throw new Error("aside should not archive the agent");
        },
        sendAgentMessage: async (agentId: string, text: string) => {
          sendCalls.push({ agentId, text });
        },
      };
      const bridge = new ChatBridge(
        {
          stateDir,
          relayMode: "auto",
          officeRepoPath: "/tmp/office",
          provider: "pi",
          model: "openrouter/anthropic/claude-fable-5",
          modeId: "",
          thinkingOptionId: "high",
          deepLinkBaseUrl: "https://paseo.example",
        } as never,
        client as never,
        store,
        { answerPendingQuestion: async () => false } as never,
        {} as never,
      );

      const thread = {
        id: externalThreadId,
        isDM: false,
        subscribe: async () => {},
        createSentMessageFromMessage: () => ({
          addReaction: async () => {},
        }),
        adapter: {},
      };
      const message = {
        id: "333.444",
        text: "aside - probably unrelated",
        raw: { text: "aside - probably unrelated", thread_ts: "111.222" },
        author: {
          userId: "U1",
          userName: "john",
          fullName: "John",
          isBot: false,
          isMe: false,
        },
        attachments: [],
        links: [],
        isMention: false,
      };

      await bridge.handleMessage(thread as never, message as never, "subscribed");

      expect(sendCalls).toEqual([
        {
          agentId: rootAgentId,
          text: expect.stringContaining("This Slack message is context only."),
        },
      ]);
      expect(sendCalls[0]?.text).toContain("John (@john): aside - probably unrelated");
      await expect(store.getSession(externalThreadId)).resolves.toMatchObject({
        muted: false,
        activeRelayId: null,
      });
      await expect(store.hasEventReceipt(`slack:${externalThreadId}:333.444`)).resolves.toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
