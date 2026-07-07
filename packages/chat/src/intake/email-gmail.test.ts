import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GmailChatEmailConfig } from "../config.js";
import { ThreadSessionStore } from "../state/thread-session-store.js";
import {
  decodeGmailPubSubWebhook,
  GmailEmailIntake,
  gmailTestInternals,
  verifyGmailWebhookToken,
  type GmailEmailClientLike,
} from "./email-gmail.js";
import type { ResendReceivedEmail } from "./email-resend.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-gmail-intake-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function textPart(text: string) {
  return { mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } };
}

const gmailConfig: GmailChatEmailConfig = {
  provider: "gmail",
  channelId: "C42",
  inboxEmail: "hello@nextcard.com",
  supportAddress: "hello@nextcard.com",
  oauthClientId: "client",
  oauthClientSecret: "secret",
  refreshToken: "refresh",
  pubsubTopic: "projects/p/topics/nextcard-hello-gmail",
  webhookToken: "secret-token",
};

describe("Gmail Pub/Sub webhook helpers", () => {
  it("decodes Gmail Pub/Sub notification payloads", () => {
    const body = JSON.stringify({
      message: {
        messageId: "pubsub-1",
        data: b64json({ emailAddress: "HELLO@NEXTCARD.COM", historyId: "123" }),
      },
    });
    expect(decodeGmailPubSubWebhook(body)).toEqual({
      emailAddress: "hello@nextcard.com",
      historyId: "123",
      messageId: "pubsub-1",
    });
  });

  it("verifies token in query params or headers", () => {
    expect(
      verifyGmailWebhookToken({
        requestUrl: "/support-email/gmail?token=abc",
        headers: {},
        expectedToken: "abc",
      }),
    ).toBe(true);
    expect(
      verifyGmailWebhookToken({
        requestUrl: "/support-email/gmail",
        headers: { "x-paseo-webhook-token": "abc" },
        expectedToken: "abc",
      }),
    ).toBe(true);
    expect(
      verifyGmailWebhookToken({
        requestUrl: "/support-email/gmail?token=wrong",
        headers: {},
        expectedToken: "abc",
      }),
    ).toBe(false);
  });
});

describe("Gmail message normalization", () => {
  it("normalizes headers, body, thread id, and attachments", () => {
    const email = gmailTestInternals.normalizeGmailMessage({
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1783400000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Jane <jane@example.com>" },
          { name: "To", value: "hello@nextcard.com" },
          { name: "Cc", value: "ops@nextcard.com" },
          { name: "Reply-To", value: "jane.alt@example.com" },
          { name: "Subject", value: "Need help" },
          { name: "Message-ID", value: "<rfc-1@example.com>" },
        ],
        parts: [
          textPart("I need help with my account."),
          {
            mimeType: "image/png",
            filename: "screenshot.png",
            headers: [{ name: "Content-ID", value: "<image-1>" }],
            body: { attachmentId: "att-1" },
          },
        ],
      },
    });

    expect(email).toMatchObject({
      source: "gmail",
      id: "msg-1",
      gmailThreadId: "thread-1",
      from: "Jane <jane@example.com>",
      to: ["hello@nextcard.com"],
      cc: ["ops@nextcard.com"],
      reply_to: ["jane.alt@example.com"],
      subject: "Need help",
      message_id: "<rfc-1@example.com>",
      text: "I need help with my account.",
    });
    expect(email.attachments).toEqual([
      expect.objectContaining({
        id: "att-1",
        filename: "screenshot.png",
        content_type: "image/png",
        content_id: "<image-1>",
      }),
    ]);
  });
});

describe("GmailEmailIntake", () => {
  it("processes message ids from Gmail history and persists notification history", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    await store.putGmailWatch({
      inboxEmail: "hello@nextcard.com",
      historyId: "h1",
      expiration: "999",
    });
    const handled: Array<{ email: ResendReceivedEmail; eventId: string }> = [];
    const gmail: GmailEmailClientLike = {
      watch: async () => ({ historyId: "h2", expiration: "1000" }),
      listHistoryMessageIds: vi.fn(async () => ["m1"]),
      listRecentMessageIds: vi.fn(async () => []),
      getReceivedEmail: vi.fn(
        async (messageId): Promise<ResendReceivedEmail> => ({
          source: "gmail",
          id: messageId,
          gmailThreadId: "thread-1",
          from: "Jane <jane@example.com>",
          to: ["hello@nextcard.com"],
          subject: "Need help",
          text: "Help",
        }),
      ),
      downloadAttachment: vi.fn(),
    };
    const intake = new GmailEmailIntake({
      config: gmailConfig,
      store,
      client: gmail,
      handleEmail: async (email, eventId) => {
        handled.push({ email, eventId });
        return { status: 200, body: { accepted: true } };
      },
    });
    const body = JSON.stringify({
      message: { data: b64json({ emailAddress: "hello@nextcard.com", historyId: "h2" }) },
    });

    const result = await intake.handleWebhook(body, {}, "/support-email/gmail?token=secret-token");

    expect(result).toEqual({ status: 200, body: { accepted: true } });
    expect(gmail.listHistoryMessageIds).toHaveBeenCalledWith("h1");
    expect(handled).toEqual([
      {
        email: expect.objectContaining({ id: "m1", gmailThreadId: "thread-1" }),
        eventId: "email:gmail:m1",
      },
    ]);
    await expect(store.getGmailWatch("hello@nextcard.com")).resolves.toMatchObject({
      historyId: "h2",
      expiration: "999",
    });
  });

  it("rejects invalid webhook tokens before touching Gmail", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const gmail: GmailEmailClientLike = {
      watch: vi.fn(),
      listHistoryMessageIds: vi.fn(),
      listRecentMessageIds: vi.fn(),
      getReceivedEmail: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const intake = new GmailEmailIntake({
      config: gmailConfig,
      store,
      client: gmail,
      handleEmail: async () => ({ status: 200, body: { accepted: true } }),
    });
    const result = await intake.handleWebhook("{}", {}, "/support-email/gmail?token=wrong");
    expect(result.status).toBe(401);
    expect(gmail.listHistoryMessageIds).not.toHaveBeenCalled();
  });
});
