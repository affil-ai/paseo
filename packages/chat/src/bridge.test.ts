import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStartedCardUrl, ChatBridge } from "./bridge.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";

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
