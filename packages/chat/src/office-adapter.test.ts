import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInstance, Message } from "chat";
import { OfficeAdapter } from "./office-adapter.js";

const turn = {
  version: 1 as const,
  kind: "message" as const,
  bindingId: "binding-1",
  runId: "run-1",
  receiptId: "receipt-1",
  providerTurnId: "office:run-1",
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
        downloadUrl: "https://office.example/spec.txt",
      },
    ],
  },
  callbackUrl: "https://convex.example/api/paseo/events",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OfficeAdapter", () => {
  it("authenticates Office ingress and processes it through Chat SDK", async () => {
    const processed: Array<{ threadId: string; message: Message }> = [];
    const received: unknown[] = [];
    const adapter = new OfficeAdapter({
      inboundToken: "office-token",
      callbackKeyId: "paseo-key",
      callbackSecret: "callback-secret",
      onTurnReceived: async (input) => {
        received.push(input);
      },
      resolveAgentId: async () => "agent-1",
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

    const unauthorized = await adapter.handleWebhook(
      new Request("http://localhost/chat/webhooks/office", {
        method: "POST",
        body: JSON.stringify(turn),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const response = await adapter.handleWebhook(
      new Request("http://localhost/chat/webhooks/office", {
        method: "POST",
        headers: { authorization: "Bearer office-token", "content-type": "application/json" },
        body: JSON.stringify(turn),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: "accepted",
      agentId: "agent-1",
      providerTurnId: "office:run-1",
    });
    expect(received).toEqual([expect.objectContaining({ threadId: "office:binding-1" })]);
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatchObject({
      threadId: "office:binding-1",
      message: {
        id: "receipt-1",
        text: "Please ship the fix.",
        isMention: false,
        author: { userId: "member-1", fullName: "Vivek", isBot: false, isMe: false },
      },
    });
    expect(processed[0]?.message.attachments).toEqual([
      expect.objectContaining({
        name: "spec.txt",
        mimeType: "text/plain",
        url: "https://office.example/spec.txt",
      }),
    ]);

    const conflict = await adapter.handleWebhook(
      new Request("http://localhost/chat/webhooks/office", {
        method: "POST",
        headers: { authorization: "Bearer office-token", "content-type": "application/json" },
        body: JSON.stringify({ ...turn, payloadDigest: "b".repeat(64) }),
      }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "OFFICE_RECEIPT_CONFLICT" });
  });

  it("signs every relay callback and preserves terminal delivery metadata", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return Response.json({ outcome: "applied" });
      }),
    );
    const adapter = new OfficeAdapter({
      inboundToken: "office-token",
      callbackKeyId: "paseo-key",
      callbackSecret: "callback-secret",
      onTurnReceived: async () => {},
      resolveAgentId: async () => "agent-1",
    });
    await adapter.initialize({
      getLogger: () => console as never,
      processMessage: async () => {},
    } as unknown as ChatInstance);
    await adapter.handleWebhook(
      new Request("http://localhost/chat/webhooks/office", {
        method: "POST",
        headers: { authorization: "Bearer office-token", "content-type": "application/json" },
        body: JSON.stringify(turn),
      }),
    );

    await adapter.postTurnEvent({
      externalThreadId: "office:binding-1",
      agentId: "agent-1",
      relayId: "receipt-1",
      phase: "final",
      sequence: 2,
      text: "The fix is complete.",
      terminal: true,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(turn.callbackUrl);
    const headers = new Headers(requests[0]?.init.headers);
    const body = String(requests[0]?.init.body);
    const timestamp = headers.get("x-paseo-timestamp");
    expect(headers.get("x-paseo-key-id")).toBe("paseo-key");
    expect(headers.get("x-paseo-signature")).toBe(
      `v1=${createHmac("sha256", "callback-secret").update(`${timestamp}.${body}`).digest("hex")}`,
    );
    expect(JSON.parse(body)).toMatchObject({
      version: 1,
      eventId: "office:run-1:auto:final:2",
      kind: "assistant",
      bindingId: "binding-1",
      runId: "run-1",
      receiptId: "receipt-1",
      agentId: "agent-1",
      providerTurnId: "office:run-1",
      phase: "final",
      sequence: 2,
      message: { markdown: "The fix is complete.", files: [] },
      terminal: true,
    });
  });

  it("emits explicit chat tool messages to Office without marking them terminal", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ outcome: "applied" });
      }),
    );
    const adapter = new OfficeAdapter({
      inboundToken: "office-token",
      callbackKeyId: "paseo-key",
      callbackSecret: "callback-secret",
      onTurnReceived: async () => {},
      resolveAgentId: async () => "agent-1",
    });
    await adapter.initialize({
      getLogger: () => console as never,
      processMessage: async () => {},
    } as unknown as ChatInstance);
    await adapter.handleWebhook(
      new Request("http://localhost/chat/webhooks/office", {
        method: "POST",
        headers: { authorization: "Bearer office-token", "content-type": "application/json" },
        body: JSON.stringify(turn),
      }),
    );

    await adapter.postMessage("office:binding-1", {
      markdown: "Here is the draft.",
      files: [
        {
          data: Buffer.from("draft"),
          filename: "draft.txt",
          mimeType: "text/plain",
        },
      ],
    });

    expect(bodies).toEqual([
      expect.objectContaining({
        kind: "assistant",
        phase: "chatSend",
        terminal: false,
        message: {
          markdown: "Here is the draft.",
          files: [
            expect.objectContaining({
              filename: "draft.txt",
              mimeType: "text/plain",
              size: 5,
              bytesBase64: Buffer.from("draft").toString("base64"),
            }),
          ],
        },
      }),
    ]);
  });

  it("reports relay failures as terminal run failures and clears the active turn", async () => {
    const bodies: unknown[] = [];
    const completed: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ outcome: "applied" });
      }),
    );
    const adapter = new OfficeAdapter({
      inboundToken: "office-token",
      callbackKeyId: "paseo-key",
      callbackSecret: "callback-secret",
      onTurnReceived: async () => {},
      onTurnCompleted: async (_threadId, providerTurnId) => {
        completed.push(providerTurnId);
      },
      resolveAgentId: async () => "agent-1",
    });
    await adapter.initialize({
      getLogger: () => console as never,
      processMessage: async () => {},
    } as unknown as ChatInstance);
    await adapter.handleWebhook(
      new Request("http://localhost/chat/webhooks/office", {
        method: "POST",
        headers: { authorization: "Bearer office-token", "content-type": "application/json" },
        body: JSON.stringify(turn),
      }),
    );

    await adapter.postTurnFailure({
      externalThreadId: "office:binding-1",
      agentId: "agent-1",
      relayId: "relay-1",
      errorCode: "PASEO_TIMELINE_FAILED",
    });

    expect(bodies).toEqual([
      expect.objectContaining({
        eventId: "office:run-1:auto:failed",
        kind: "failed",
        bindingId: "binding-1",
        runId: "run-1",
        agentId: "agent-1",
        providerTurnId: "office:run-1",
        errorCode: "PASEO_TIMELINE_FAILED",
      }),
    ]);
    expect(completed).toEqual(["office:run-1"]);
    await expect(adapter.hasActiveTurn("office:binding-1")).resolves.toBe(false);
  });
});
