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

describe("ChatBridge follow-up delivery", () => {
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
