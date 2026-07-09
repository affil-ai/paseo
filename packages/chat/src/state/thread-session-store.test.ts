import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadSessionStore } from "./thread-session-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ThreadSessionStore chat bindings", () => {
  it("loads v1 sessions as inbound chat bindings", async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        sessions: {
          "slack:C1:111.222": {
            externalThreadId: "slack:C1:111.222",
            rootAgentId: "agent-office",
            focusedAgentId: "agent-child",
            activeChildAgentId: "agent-child",
            muted: true,
            activeRelayId: "relay-1",
            title: "legacy",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );

    const store = new ThreadSessionStore(dir);

    await expect(store.getSession("slack:C1:111.222")).resolves.toEqual({
      kind: "inbound-session",
      externalThreadId: "slack:C1:111.222",
      rootAgentId: "agent-office",
      muted: true,
      activeRelayId: "relay-1",
      title: "legacy",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(store.findSessionByAgent("agent-child")).resolves.toBeNull();
  });

  it("persists outbound bindings, pending asks, delivery receipts, and audit records", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";

    await store.upsertBinding({
      kind: "outbound-conversation",
      conversationId: "conv_1",
      externalThreadId: "slack:D1:111.222",
      officeAgentId: "agent-office",
      destination: { kind: "person", key: "vivek" },
      subscribed: true,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.createPendingRequest({
      requestId: "ask_1",
      officeAgentId: "agent-office",
      conversationId: "conv_1",
      externalThreadId: "slack:D1:111.222",
      question: "Confirm?",
      deadlineAt: "2026-01-01T01:00:00.000Z",
      status: "pending",
      answer: null,
      answeredBy: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.markDeliveryStarted("idem-1");
    await store.markDeliveryCompleted("idem-1", { conversationId: "conv_1" });
    await store.appendAuditRecord({
      id: "aud_1",
      timestamp,
      officeAgentId: "agent-office",
      toolName: "chat.reply",
      destination: { kind: "conversation", conversationId: "conv_1" },
      resolvedExternalThreadId: "slack:D1:111.222",
      conversationId: "conv_1",
      messagePreview: "hello",
      result: "posted",
    });

    const reloaded = new ThreadSessionStore(dir);

    await expect(reloaded.getConversation("conv_1")).resolves.toMatchObject({
      conversationId: "conv_1",
      officeAgentId: "agent-office",
      pendingRequestId: "ask_1",
    });
    await expect(reloaded.getCompletedDeliveryResult("idem-1")).resolves.toEqual({
      conversationId: "conv_1",
    });
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as {
      auditRecords: unknown[];
    };
    expect(raw.auditRecords).toHaveLength(1);
  });

  it("finds current bindings by office agent without including children", async () => {
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

    await expect(store.findBindingsByAgent("agent-office")).resolves.toHaveLength(1);
    await expect(store.findBindingsByAgent("agent-child")).resolves.toEqual([]);
  });

  it("persists inbound session starter metadata", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";

    await store.upsertBinding({
      kind: "inbound-session",
      externalThreadId: "slack:C1:111.222",
      rootAgentId: "agent-office",
      startedBy: {
        source: "slack",
        userId: "U123",
        name: "Jane Doe",
        handle: "jane",
        avatarUrl: "https://example.com/jane.png",
      },
      muted: false,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await expect(store.getSession("slack:C1:111.222")).resolves.toMatchObject({
      startedBy: {
        source: "slack",
        userId: "U123",
        name: "Jane Doe",
        handle: "jane",
        avatarUrl: "https://example.com/jane.png",
      },
    });
  });

  it("expires pending asks and clears the binding pointer", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";

    await store.upsertBinding({
      kind: "outbound-conversation",
      conversationId: "conv_1",
      externalThreadId: "slack:D1:111.222",
      officeAgentId: "agent-office",
      destination: { kind: "person", key: "vivek" },
      subscribed: true,
      pendingRequestId: "ask_1",
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.createPendingRequest({
      requestId: "ask_1",
      officeAgentId: "agent-office",
      conversationId: "conv_1",
      externalThreadId: "slack:D1:111.222",
      question: "Confirm?",
      deadlineAt: "2026-01-01T00:00:00.000Z",
      status: "pending",
      answer: null,
      answeredBy: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const expired = await store.expirePendingRequests(new Date("2026-01-01T00:01:00.000Z"));

    expect(expired).toHaveLength(1);
    await expect(store.getConversation("conv_1")).resolves.not.toHaveProperty("pendingRequestId");
  });

  it("stores and resolves email links", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);

    await store.putEmailLinks(
      ["message:abc@mail.example", "resend:em_1", "conversation:user@example.com:help"],
      "slack:C1:100.200",
    );

    await expect(store.getEmailLink("message:abc@mail.example")).resolves.toBe("slack:C1:100.200");
    await expect(store.getEmailLink("resend:em_1")).resolves.toBe("slack:C1:100.200");
    await expect(store.getEmailLink("message:unknown@mail.example")).resolves.toBeNull();
  });

  it("parses legacy state files without emailLinks", async () => {
    const dir = await createTempDir();
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        sessions: {},
        eventReceipts: {},
        deliveryReceipts: {},
        pendingQuestions: {},
        pendingRequests: {},
        auditRecords: [],
      }),
    );
    const store = new ThreadSessionStore(dir);
    await expect(store.getEmailLink("message:abc@mail.example")).resolves.toBeNull();
  });

  it("prunes email links when the linked session is deleted", async () => {
    const dir = await createTempDir();
    const store = new ThreadSessionStore(dir);
    const timestamp = "2026-01-01T00:00:00.000Z";

    await store.upsertBinding({
      kind: "inbound-session",
      externalThreadId: "slack:C1:100.200",
      rootAgentId: "agent-office",
      muted: false,
      activeRelayId: null,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.putEmailLinks(["message:abc@mail.example"], "slack:C1:100.200");
    await store.putEmailLinks(["message:other@mail.example"], "slack:C2:300.400");

    await store.deleteSession("slack:C1:100.200");

    await expect(store.getEmailLink("message:abc@mail.example")).resolves.toBeNull();
    await expect(store.getEmailLink("message:other@mail.example")).resolves.toBe(
      "slack:C2:300.400",
    );
  });
});
