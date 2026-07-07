import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStartedCardUrl, ChatBridge } from "./bridge.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";

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

interface ManualWatchdogInput {
  externalThreadId: string;
  agentId: string;
  turnId: string;
  startedSeq: number;
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
      model: "openai-codex/gpt-5.5",
      modeId: "high",
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

describe("ChatBridge auto relay", () => {
  it("does not post system-error-only artifacts or fall back to Done", async () => {
    const result = await runAutoRelayWithTimeline([
      {
        type: "assistant_message",
        text: " [System Error] fetch failed (stopReason=error, model=openai-codex/gpt-5.5)",
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
        text: "[System Error] fetch failed (stopReason=error, model=openai-codex/gpt-5.5)",
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
        text: "[System Error] fetch failed (stopReason=error, model=openai-codex/gpt-5.5)",
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

describe("ChatBridge manual final reply watchdog", () => {
  async function createManualWatchdogHarness(input?: {
    deliverySeq?: number;
    reminderCount?: number;
  }) {
    const stateDir = await mkdtemp(join(tmpdir(), "paseo-chat-bridge-test-"));
    const externalThreadId = "slack:D123:111.222";
    const rootAgentId = "agent-1";
    const turnId = input?.reminderCount
      ? `turn-1:final-reply-reminder-${input.reminderCount}`
      : "turn-1";
    const store = new ThreadSessionStore(stateDir);
    const postedMessages: unknown[] = [];
    const sendCalls: Array<{ agentId: string; text: string }> = [];
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
    await store.startManualReplyTurn({
      externalThreadId,
      turnId,
      agentId: rootAgentId,
      startedSeq: 5,
      reminderCount: input?.reminderCount ?? 0,
    });
    if (input?.deliverySeq !== undefined) {
      await store.recordManualVisibleDelivery({
        externalThreadId,
        agentId: rootAgentId,
        deliverySeq: input.deliverySeq,
      });
    }

    let waitCount = 0;
    const client = {
      waitForFinish: async () => {
        waitCount += 1;
        if (waitCount === 1) return { status: "idle", final: true };
        return new Promise(() => {});
      },
      fetchAgentTimeline: async () => ({
        window: { nextSeq: 9 },
        entries: [timelineEntry(8, { type: "assistant_message", text: "Final internal answer" })],
        agent: { status: "idle" },
      }),
      sendAgentMessage: async (agentId: string, text: string) => {
        sendCalls.push({ agentId, text });
      },
      getLastServerInfoMessage: () => ({ serverId: "local" }),
    };
    const bridge = new ChatBridge(
      {
        stateDir,
        relayMode: "manual",
        officeRepoPath: "/tmp/office",
        provider: "pi",
        model: "openai-codex/gpt-5.5",
        modeId: "high",
        deepLinkBaseUrl: "https://paseo.example",
      } as never,
      client as never,
      store,
      { answerPendingQuestion: async () => false } as never,
      {} as never,
      {
        postMessage: async (threadId: string, message: unknown) => {
          postedMessages.push(message);
          return { id: "bridge-message", threadId, raw: null };
        },
      },
    );
    const enforceManualFinalReply = (
      bridge as unknown as {
        enforceManualFinalReply: (input: ManualWatchdogInput) => Promise<void>;
      }
    ).enforceManualFinalReply;

    return {
      stateDir,
      store,
      externalThreadId,
      rootAgentId,
      turnId,
      sendCalls,
      postedMessages,
      enforce: () =>
        enforceManualFinalReply.call(bridge, {
          externalThreadId,
          agentId: rootAgentId,
          turnId,
          startedSeq: 5,
        }),
    };
  }

  it("reminds the same agent when a manual Slack turn ends without chat delivery", async () => {
    const harness = await createManualWatchdogHarness();
    try {
      await harness.enforce();

      expect(harness.sendCalls).toEqual([
        {
          agentId: harness.rootAgentId,
          text: [
            "You ended the Slack turn without sending a Slack-visible final response.",
            "Reminder attempt 1: send the missing final response now using chat.send to the current Slack binding.",
            `If you pass a destination, use { kind: "conversation", conversationId: "${harness.externalThreadId}" }. Do not do more background work before sending this final Slack reply.`,
          ].join("\n"),
        },
      ]);
      await expect(
        harness.store.getManualReplyTurn(harness.externalThreadId),
      ).resolves.toMatchObject({
        turnId: "turn-1:final-reply-reminder-1",
        reminderCount: 1,
        deliverySeq: null,
      });
    } finally {
      await rm(harness.stateDir, { recursive: true, force: true });
    }
  });

  it("treats a manual progress reply followed by later assistant text as missing final delivery", async () => {
    const harness = await createManualWatchdogHarness({ deliverySeq: 6 });
    try {
      await harness.enforce();

      expect(harness.sendCalls).toHaveLength(1);
      expect(harness.sendCalls[0]?.text).toContain(
        "without sending a Slack-visible final response",
      );
    } finally {
      await rm(harness.stateDir, { recursive: true, force: true });
    }
  });

  it("clears the watchdog when chat delivery happens after the latest assistant text", async () => {
    const harness = await createManualWatchdogHarness({ deliverySeq: 9 });
    try {
      await harness.enforce();

      expect(harness.sendCalls).toEqual([]);
      await expect(harness.store.getManualReplyTurn(harness.externalThreadId)).resolves.toBeNull();
    } finally {
      await rm(harness.stateDir, { recursive: true, force: true });
    }
  });

  it("sends another reminder instead of posting fallback when a reminder also omits chat delivery", async () => {
    const harness = await createManualWatchdogHarness({ reminderCount: 1 });
    try {
      await harness.enforce();

      expect(harness.postedMessages).toEqual([]);
      expect(harness.sendCalls).toEqual([
        {
          agentId: harness.rootAgentId,
          text: [
            "You ended the Slack turn without sending a Slack-visible final response.",
            "Reminder attempt 2: send the missing final response now using chat.send to the current Slack binding.",
            `If you pass a destination, use { kind: "conversation", conversationId: "${harness.externalThreadId}" }. Do not do more background work before sending this final Slack reply.`,
          ].join("\n"),
        },
      ]);
      await expect(
        harness.store.getManualReplyTurn(harness.externalThreadId),
      ).resolves.toMatchObject({
        turnId: "turn-1:final-reply-reminder-2",
        reminderCount: 2,
        deliverySeq: null,
      });
    } finally {
      await rm(harness.stateDir, { recursive: true, force: true });
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
          model: "openai-codex/gpt-5.5",
          modeId: "high",
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
          model: "openai-codex/gpt-5.5",
          modeId: "high",
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
});
