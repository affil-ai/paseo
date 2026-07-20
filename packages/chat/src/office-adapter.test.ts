import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInstance, Message } from "chat";
import { OfficeAdapter, type OfficeV2RelayEvent } from "./office-adapter.js";
import type { OfficeAgentRelay } from "./state/thread-session-store.js";

const turn = {
  version: 2 as const,
  kind: "message" as const,
  bindingId: "binding-1",
  runId: "run-1",
  receiptId: "receipt-1",
  payloadDigest: "a".repeat(64),
  agentId: "agent-1",
  title: "Existing Office chat",
  actor: {
    externalUserId: "member-1",
    displayName: "Vivek",
    email: "vivek@example.com",
  },
  message: {
    markdown: "Please ship the fix.",
    files: [
      {
        id: "attachment-1",
        filename: "spec.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        contentSha256: "b".repeat(64),
        downloadUrl: "https://office.example/spec.txt",
      },
    ],
  },
  callbackUrl: "https://convex.example/api/paseo/events",
};

const relay: OfficeAgentRelay = {
  version: 2,
  bindingId: "binding-1",
  agentId: "agent-1",
  callbackUrl: turn.callbackUrl,
  acknowledgedSeq: 9,
  epoch: "epoch-1",
  dispatchReceipts: {},
  activeTurn: { providerTurnId: "provider-turn-1", receiptId: turn.receiptId, startSeq: 4 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function initializedAdapter(
  overrides: Partial<ConstructorParameters<typeof OfficeAdapter>[0]> = {},
  processed: Array<{ threadId: string; message: Message }> = [],
) {
  const adapter = new OfficeAdapter({
    inboundToken: "office-token",
    callbackKeyId: "paseo-key",
    callbackSecret: "callback-secret",
    onTurnReceived: async () => "received",
    resolveAgentId: async () => "agent-1",
    resolveRelay: async () => relay,
    ...overrides,
  });
  await adapter.initialize({
    getLogger: () => console as never,
    processMessage: async (
      _adapter: Parameters<ChatInstance["processMessage"]>[0],
      threadId: Parameters<ChatInstance["processMessage"]>[1],
      factory: Parameters<ChatInstance["processMessage"]>[2],
    ) => {
      processed.push({
        threadId,
        message: typeof factory === "function" ? await factory() : factory,
      });
    },
  } as unknown as ChatInstance);
  return adapter;
}

function officeRequest(payload: unknown, token = "office-token") {
  return new Request("http://localhost/chat/webhooks/office", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("OfficeAdapter", () => {
  it("authenticates ingress, validates v2 metadata, and processes a receipt once", async () => {
    const processed: Array<{ threadId: string; message: Message }> = [];
    const received: unknown[] = [];
    const adapter = await initializedAdapter(
      {
        onTurnReceived: async (input) => {
          received.push(input);
          return received.length === 1 ? "received" : "alreadyReceived";
        },
      },
      processed,
    );

    expect((await adapter.handleWebhook(officeRequest(turn, "wrong"))).status).toBe(401);
    const response = await adapter.handleWebhook(officeRequest(turn));
    await expect(response.json()).resolves.toEqual({ outcome: "received", receiptId: "receipt-1" });
    const duplicate = await adapter.handleWebhook(officeRequest(turn));
    await expect(duplicate.json()).resolves.toEqual({
      outcome: "alreadyReceived",
      receiptId: "receipt-1",
    });
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({
      threadId: "office:binding-1",
      message: {
        id: "receipt-1",
        text: "Please ship the fix.",
        author: { userId: "member-1", fullName: "Vivek" },
      },
    });
    expect(processed[0]?.message.attachments).toEqual([
      expect.objectContaining({ name: "spec.txt", mimeType: "text/plain" }),
    ]);

    const conflict = await adapter.handleWebhook(
      officeRequest({ ...turn, payloadDigest: "c".repeat(64) }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "OFFICE_RECEIPT_CONFLICT" });
  });

  it("registers an existing binding without invoking Chat SDK", async () => {
    const registrations: unknown[] = [];
    const adapter = await initializedAdapter({
      registerRelay: async (input) => {
        registrations.push(input);
        return { outcome: "registered", supersededLegacySessions: 1 };
      },
    });
    const response = await adapter.handleWebhook(
      officeRequest({
        version: 2,
        kind: "register",
        bindingId: "binding-1",
        agentId: "agent-1",
        callbackUrl: turn.callbackUrl,
      }),
    );
    await expect(response.json()).resolves.toEqual({
      outcome: "registered",
      supersededLegacySessions: 1,
    });
    expect(registrations).toHaveLength(1);
  });

  it("signs v2 timeline callbacks", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return Response.json({ outcome: "applied" });
      }),
    );
    const adapter = await initializedAdapter();
    const event: OfficeV2RelayEvent = {
      version: 2,
      eventId: "provider-turn-1:timeline:assistant-1:10",
      kind: "timeline",
      bindingId: "binding-1",
      agentId: "agent-1",
      providerTurnId: "provider-turn-1",
      itemKey: "assistant:assistant-1",
      seqStart: 10,
      seqEnd: 10,
      occurredAt: 1_721_476_800_000,
      itemDigest: "d".repeat(64),
      item: { type: "assistant_message", text: "Done.", files: [] },
    };
    await adapter.postRelayEvent(event);

    const request = requests[0]!;
    expect(request.url).toBe(turn.callbackUrl);
    const headers = new Headers(request.init.headers);
    const body = String(request.init.body);
    const timestamp = headers.get("x-paseo-timestamp");
    expect(headers.get("x-paseo-signature")).toBe(
      `v1=${createHmac("sha256", "callback-secret").update(`${timestamp}.${body}`).digest("hex")}`,
    );
    expect(JSON.parse(body)).toEqual(event);
  });

  it("projects explicit chat.send output into the active parent turn", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ outcome: "applied" });
      }),
    );
    const adapter = await initializedAdapter();
    await adapter.handleWebhook(officeRequest(turn));
    await adapter.postMessage("office:binding-1", {
      markdown: "Here is the draft.",
      files: [{ data: Buffer.from("draft"), filename: "draft.txt", mimeType: "text/plain" }],
    });
    expect(bodies).toEqual([
      expect.objectContaining({
        version: 2,
        kind: "timeline",
        bindingId: "binding-1",
        providerTurnId: "provider-turn-1",
        item: {
          type: "assistant_message",
          text: "Here is the draft.",
          files: [expect.objectContaining({ filename: "draft.txt", size: 5 })],
        },
      }),
    ]);
  });
});
