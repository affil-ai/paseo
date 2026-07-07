import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadSessionStore } from "../state/thread-session-store.js";
import { EmailIntakeBridge } from "./email-bridge.js";
import type { EmailClassification, EmailClassifier } from "./email-classifier.js";
import type { ResendReceivedEmail } from "./email-resend.js";

const SECRET_RAW = Buffer.from("test-secret-material");
const SECRET = `whsec_${SECRET_RAW.toString("base64")}`;

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-email-bridge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function signedHeaders(body: string): Record<string, string> {
  const id = "msg_1";
  const timestamp = "1720000000";
  const signature = createHmac("sha256", SECRET_RAW)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

function webhookBody(emailId: string): string {
  return JSON.stringify({ type: "email.received", data: { email_id: emailId } });
}

interface Harness {
  bridge: EmailIntakeBridge;
  store: ThreadSessionStore;
  channelPosts: unknown[];
  threadPosts: Array<{ threadId: string; message: unknown }>;
  subscribes: string[];
  sentMessages: Array<{ agentId: string; message: string; options: unknown }>;
  createdSessions: Array<{
    externalThreadId: string;
    title: string;
    initialPrompt: string;
    images: unknown;
    attachments: unknown;
    initialRelayId: unknown;
  }>;
  relays: Array<{
    externalThreadId: string;
    agentId: string;
    sinceSeq: number;
    postFirstReply: unknown;
  }>;
}

async function createHarness(
  emailsById: Record<string, ResendReceivedEmail>,
  harnessOptions: { classifier?: EmailClassifier } = {},
): Promise<Harness> {
  const dir = await createTempDir();
  const store = new ThreadSessionStore(dir);

  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://download.test/")) {
      return new Response(Buffer.from(`bytes:${url.split("/").at(-1) ?? "attachment"}`), {
        headers: { "content-type": "image/png" },
      });
    }
    const attachmentMatch = /\/emails\/receiving\/([^/]+)\/attachments\/([^/]+)$/.exec(url);
    if (attachmentMatch) {
      const emailId = decodeURIComponent(attachmentMatch[1] ?? "");
      const attachmentId = decodeURIComponent(attachmentMatch[2] ?? "");
      const sourceEmail = emailsById[emailId];
      const attachment = sourceEmail?.attachments?.find((entry) => entry.id === attachmentId);
      if (!attachment) return new Response("not found", { status: 404, statusText: "Not Found" });
      return Response.json({
        data: {
          id: attachmentId,
          filename: attachment.filename,
          content_type: attachment.content_type,
          download_url: `https://download.test/${attachmentId}`,
        },
      });
    }
    const match = /\/emails\/receiving\/([^/]+)$/.exec(url);
    const email = match ? emailsById[decodeURIComponent(match[1] ?? "")] : undefined;
    if (!email) return new Response("not found", { status: 404, statusText: "Not Found" });
    return Response.json({ data: email });
  });

  const harness: Harness = {
    bridge: null as never,
    store,
    channelPosts: [],
    threadPosts: [],
    subscribes: [],
    sentMessages: [],
    createdSessions: [],
    relays: [],
  };

  let agentCounter = 0;
  harness.bridge = new EmailIntakeBridge({
    email: {
      provider: "resend",
      apiKey: "re_test",
      webhookSecret: SECRET,
      channelId: "C42",
      supportAddress: "support@affil.ai",
    },
    relayMode: "auto",
    stateDir: dir,
    maxUploadBytes: 1024 * 1024,
    officePrompt: "office custom prompt",
    ...(harnessOptions.classifier ? { classifier: harnessOptions.classifier } : {}),
    chat: {
      channel: (channelId: string) => ({
        id: channelId,
        post: async (message: unknown) => {
          harness.channelPosts.push(message);
          return { id: "111.222", threadId: `${channelId}:` };
        },
      }),
      thread: (threadId: string) => ({
        post: async (message: unknown) => {
          harness.threadPosts.push({ threadId, message });
        },
        subscribe: async () => {
          harness.subscribes.push(threadId);
        },
      }),
    },
    client: {
      sendAgentMessage: async (agentId: string, message: string, sendOptions: unknown) => {
        harness.sentMessages.push({ agentId, message, options: sendOptions });
      },
      fetchAgentTimeline: async () => ({ window: { nextSeq: 7 } }),
    },
    store,
    bridge: {
      createExternalSession: async (input) => {
        agentCounter += 1;
        const agentId = `agent-${agentCounter}`;
        harness.createdSessions.push({
          externalThreadId: input.externalThreadId,
          title: input.title,
          initialPrompt: input.initialPrompt,
          images: input.images,
          attachments: input.attachments,
          initialRelayId: input.initialRelayId,
        });
        const now = new Date().toISOString();
        await store.upsertSession({
          kind: "inbound-session",
          externalThreadId: input.externalThreadId,
          rootAgentId: agentId,
          muted: false,
          activeRelayId: null,
          title: input.title,
          createdAt: now,
          updatedAt: now,
        });
        return { rootAgentId: agentId };
      },
      startRelay: async (input) => {
        harness.relays.push({
          externalThreadId: input.externalThreadId,
          agentId: input.agentId,
          sinceSeq: input.sinceSeq,
          postFirstReply: input.postFirstReply,
        });
      },
    },
  });
  return harness;
}

const initialEmail: ResendReceivedEmail = {
  id: "em_1",
  from: "Jane Doe <jane@customer.com>",
  to: ["support@affil.ai"],
  subject: "Cannot log in",
  text: "I cannot log in to my account.",
  headers: { "Message-ID": "<msg-1@customer.com>" },
};

const replyEmail: ResendReceivedEmail = {
  id: "em_2",
  from: "Jane Doe <jane@customer.com>",
  to: ["support@affil.ai"],
  subject: "Re: Cannot log in",
  text: "Still broken after clearing cookies.\n\nOn Mon wrote:\n> We pushed a fix.",
  headers: {
    "Message-ID": "<msg-2@customer.com>",
    "In-Reply-To": "<msg-1@customer.com>",
  },
};

const imageEmail: ResendReceivedEmail = {
  ...initialEmail,
  id: "em_image",
  text: "what about this image",
  attachments: [
    {
      id: "att_1",
      filename: "screenshot.png",
      content_type: "image/png",
    },
  ],
};

describe("EmailIntakeBridge", () => {
  it("rejects invalid signatures", async () => {
    const harness = await createHarness({});
    const body = webhookBody("em_1");
    const result = await harness.bridge.handleResendWebhook(body, {
      ...signedHeaders(body),
      "svix-signature": "v1,bm90LXRoZS1zaWduYXR1cmU=",
    });
    expect(result.status).toBe(401);
  });

  it("ignores non email.received events", async () => {
    const harness = await createHarness({});
    const body = JSON.stringify({ type: "email.sent", data: { email_id: "em_1" } });
    const result = await harness.bridge.handleResendWebhook(body, signedHeaders(body));
    expect(result).toEqual({
      status: 200,
      body: { accepted: true, ignored: true, reason: "ignored_event_type:email.sent" },
    });
  });

  it("starts a new session with a Slack announce thread for a fresh email", async () => {
    const harness = await createHarness({ em_1: initialEmail });
    const body = webhookBody("em_1");
    const result = await harness.bridge.handleResendWebhook(body, signedHeaders(body));

    expect(result.body).toEqual({ accepted: true, created: true });
    expect(harness.channelPosts).toHaveLength(1);
    expect(harness.subscribes).toEqual(["slack:C42:111.222"]);
    expect(harness.createdSessions).toHaveLength(1);
    const session = harness.createdSessions[0];
    expect(session?.externalThreadId).toBe("slack:C42:111.222");
    expect(session?.title).toBe("Support: Cannot log in");
    expect(session?.initialPrompt).toContain("inbound support email");
    expect(session?.initialPrompt).toContain("office custom prompt");
    expect(session?.initialPrompt).toContain("Support email triage:");
    expect(session?.initialPrompt).toContain("Subject: Cannot log in");
    expect(harness.relays).toEqual([
      {
        externalThreadId: "slack:C42:111.222",
        agentId: "agent-1",
        sinceSeq: 0,
        postFirstReply: false,
      },
    ]);
    await expect(harness.store.getEmailLink("message:msg-1@customer.com")).resolves.toBe(
      "slack:C42:111.222",
    );
  });

  it("posts email previews as code blocks and includes stored attachments", async () => {
    const harness = await createHarness({ em_image: imageEmail });
    const body = webhookBody("em_image");
    const result = await harness.bridge.handleResendWebhook(body, signedHeaders(body));

    expect(result.body).toEqual({ accepted: true, created: true });
    const announce = harness.channelPosts[0] as {
      markdown?: string;
      files?: Array<{ filename?: string; mimeType?: string; data?: Buffer }>;
    };
    expect(announce.markdown).toContain("```\nFrom: Jane Doe <jane@customer.com>");
    expect(announce.markdown).toContain("what about this image");
    expect(announce.files).toHaveLength(1);
    expect(announce.files?.[0]).toMatchObject({
      filename: "screenshot.png",
      mimeType: "image/png",
    });
    expect(Buffer.isBuffer(announce.files?.[0]?.data)).toBe(true);

    const session = harness.createdSessions[0];
    expect(session?.images).toEqual([
      { data: Buffer.from("bytes:att_1").toString("base64"), mimeType: "image/png" },
    ]);
    expect(session?.attachments).toEqual([
      expect.objectContaining({
        type: "uploaded_file",
        fileName: "screenshot.png",
        mimeType: "image/png",
      }),
    ]);
    expect(session?.initialRelayId).toBe("email:resend:em_image");
  });

  it("routes a reply email to the existing agent as a follow-up turn", async () => {
    const harness = await createHarness({ em_1: initialEmail, em_2: replyEmail });
    const first = webhookBody("em_1");
    await harness.bridge.handleResendWebhook(first, signedHeaders(first));

    const second = webhookBody("em_2");
    const result = await harness.bridge.handleResendWebhook(second, signedHeaders(second));

    expect(result.body).toEqual({ accepted: true, continued: true });
    expect(harness.createdSessions).toHaveLength(1);
    expect(harness.channelPosts).toHaveLength(1);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.agentId).toBe("agent-1");
    expect(harness.sentMessages[0]?.message).toContain("Still broken after clearing cookies.");
    expect(harness.sentMessages[0]?.message).not.toContain("We pushed a fix");
    expect(harness.sentMessages[0]?.message).toContain("inbound support email");
    const preview = harness.threadPosts.find((post) =>
      String((post.message as { markdown?: string }).markdown).includes("Email reply from"),
    );
    expect(preview?.threadId).toBe("slack:C42:111.222");
    expect(harness.relays.at(-1)).toEqual({
      externalThreadId: "slack:C42:111.222",
      agentId: "agent-1",
      sinceSeq: 7,
      postFirstReply: false,
    });
    await expect(harness.store.getEmailLink("message:msg-2@customer.com")).resolves.toBe(
      "slack:C42:111.222",
    );
  });

  it("posts reply previews as code blocks with attachments", async () => {
    const replyWithImage: ResendReceivedEmail = {
      ...replyEmail,
      id: "em_3",
      headers: {
        "Message-ID": "<msg-3@customer.com>",
        "In-Reply-To": "<msg-1@customer.com>",
      },
      attachments: [
        {
          id: "att_2",
          filename: "followup.png",
          content_type: "image/png",
        },
      ],
    };
    const harness = await createHarness({ em_1: initialEmail, em_3: replyWithImage });
    const first = webhookBody("em_1");
    await harness.bridge.handleResendWebhook(first, signedHeaders(first));

    const second = webhookBody("em_3");
    await harness.bridge.handleResendWebhook(second, signedHeaders(second));

    const preview = harness.threadPosts.find((post) =>
      String((post.message as { markdown?: string }).markdown).includes("Email reply from"),
    );
    expect(preview).toBeDefined();
    const previewMessage = preview?.message as { markdown?: string; files?: unknown[] };
    expect(previewMessage.markdown).toContain("```\nStill broken after clearing cookies.");
    expect(previewMessage.files).toEqual([
      expect.objectContaining({ filename: "followup.png", mimeType: "image/png" }),
    ]);
    expect(harness.sentMessages[0]?.options).toMatchObject({
      images: [{ data: Buffer.from("bytes:att_2").toString("base64"), mimeType: "image/png" }],
      attachments: [
        expect.objectContaining({
          type: "uploaded_file",
          fileName: "followup.png",
          mimeType: "image/png",
        }),
      ],
    });
  });

  it("treats redelivery of the same email id as a duplicate", async () => {
    const harness = await createHarness({ em_1: initialEmail });
    const body = webhookBody("em_1");
    await harness.bridge.handleResendWebhook(body, signedHeaders(body));
    const result = await harness.bridge.handleResendWebhook(body, signedHeaders(body));

    expect(result.body).toEqual({ accepted: true, duplicate: true });
    expect(harness.createdSessions).toHaveLength(1);
    expect(harness.sentMessages).toHaveLength(0);
  });

  it("treats the same message id under a new Resend email id as a duplicate, not a reply", async () => {
    const harness = await createHarness({
      em_1: initialEmail,
      em_9: { ...initialEmail, id: "em_9" },
    });
    const first = webhookBody("em_1");
    await harness.bridge.handleResendWebhook(first, signedHeaders(first));

    const redelivered = webhookBody("em_9");
    const result = await harness.bridge.handleResendWebhook(
      redelivered,
      signedHeaders(redelivered),
    );

    expect(result.body).toEqual({ accepted: true, duplicate: true });
    expect(harness.createdSessions).toHaveLength(1);
    expect(harness.sentMessages).toHaveLength(0);
  });

  it("starts a fresh session when the linked session was retired", async () => {
    const harness = await createHarness({ em_1: initialEmail, em_2: replyEmail });
    const first = webhookBody("em_1");
    await harness.bridge.handleResendWebhook(first, signedHeaders(first));
    await harness.store.deleteSession("slack:C42:111.222");

    const second = webhookBody("em_2");
    const result = await harness.bridge.handleResendWebhook(second, signedHeaders(second));

    expect(result.body).toEqual({ accepted: true, created: true });
    expect(harness.createdSessions).toHaveLength(2);
    expect(harness.sentMessages).toHaveLength(0);
  });

  it("does not create a Slack thread for classifier non-support results", async () => {
    const nonSupport: EmailClassification = {
      isSupport: false,
      confidence: 0.94,
      reason: "marketing newsletter",
    };
    const classifier = vi.fn(async () => nonSupport);
    const harness = await createHarness({ em_1: initialEmail }, { classifier });
    const body = webhookBody("em_1");
    const result = await harness.bridge.handleResendWebhook(body, signedHeaders(body));

    expect(result.body).toEqual({ accepted: true, ignored: true, reason: "non_support" });
    expect(harness.channelPosts).toHaveLength(0);
    expect(harness.createdSessions).toHaveLength(0);
    expect(classifier).toHaveBeenCalledOnce();
    const state = await harness.store.load();
    expect(state.emailAuditRecords.at(-1)).toMatchObject({
      result: "non_support",
      classification: nonSupport,
    });
  });

  it("fails open when the classifier throws", async () => {
    const classifier = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const harness = await createHarness({ em_1: initialEmail }, { classifier });
    const body = webhookBody("em_1");
    const result = await harness.bridge.handleResendWebhook(body, signedHeaders(body));

    expect(result.body).toEqual({ accepted: true, created: true });
    expect(harness.channelPosts).toHaveLength(1);
    expect(harness.createdSessions).toHaveLength(1);
    const state = await harness.store.load();
    expect(state.emailAuditRecords.some((record) => record.result === "failed_open")).toBe(true);
  });
});
