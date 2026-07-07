import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeResendWebhook,
  emailBody,
  emailSenderIdentity,
  emailSenderIdentityForContext,
  formatSupportEmailForAgent,
  htmlToText,
  isForwardLikeEmail,
  isFromInternalSender,
  normalizeEmailAddress,
  stripQuotedEmailChain,
  supportEmailDuplicateExternalIds,
  supportEmailLookupExternalIds,
  supportEmailSlackPreview,
  supportEmailSlackTitle,
  supportEmailStoredExternalIds,
  truncateText,
  verifyResendWebhookSignature,
  type EmailIntakeContext,
  type ResendReceivedEmail,
} from "./email-resend.js";

const context: EmailIntakeContext = { supportAddress: "support@affil.ai" };

function makeEmail(overrides: Partial<ResendReceivedEmail> = {}): ResendReceivedEmail {
  return {
    id: "em_1",
    from: "Jane Doe <jane@customer.com>",
    to: ["support@affil.ai"],
    subject: "Cannot log in",
    text: "I cannot log in to my account.",
    headers: { "Message-ID": "<msg-1@customer.com>" },
    ...overrides,
  };
}

describe("external id derivation", () => {
  it("stores own message id, resend id, and conversation keys", () => {
    const ids = supportEmailStoredExternalIds(makeEmail(), context);
    expect(ids).toContain("message:msg-1@customer.com");
    expect(ids).toContain("resend:em_1");
    expect(ids).toContain("conversation:jane@customer.com:cannot log in");
  });

  it("looks up referenced ids for replies before conversation fallback", () => {
    const reply = makeEmail({
      id: "em_2",
      subject: "Re: Cannot log in",
      headers: {
        "Message-ID": "<msg-2@customer.com>",
        "In-Reply-To": "<msg-1@customer.com>",
        References: "<msg-0@customer.com> <msg-1@customer.com>",
      },
    });
    const lookup = supportEmailLookupExternalIds(reply, context);
    expect(lookup).toContain("message:msg-1@customer.com");
    expect(lookup).toContain("message:msg-0@customer.com");
    expect(lookup).toContain("message:msg-2@customer.com");
    expect(lookup).toContain("conversation:jane@customer.com:cannot log in");
    // referenced ids come before own ids so genuine replies match before redelivery ids
    expect(lookup.indexOf("message:msg-1@customer.com")).toBeLessThan(
      lookup.indexOf("message:msg-2@customer.com"),
    );
    expect(lookup.indexOf("message:msg-2@customer.com")).toBeLessThan(
      lookup.indexOf("conversation:jane@customer.com:cannot log in"),
    );
  });

  it("does not classify referenced parent ids as duplicates of the reply", () => {
    const reply = makeEmail({
      id: "em_2",
      headers: {
        "Message-ID": "<msg-2@customer.com>",
        "In-Reply-To": "<msg-1@customer.com>",
      },
    });
    const duplicates = supportEmailDuplicateExternalIds(reply);
    expect(duplicates).toContain("message:msg-2@customer.com");
    expect(duplicates).toContain("resend:em_2");
    expect(duplicates).not.toContain("message:msg-1@customer.com");
  });

  it("uses conversation fallback only for internal forward-like emails", () => {
    const forward = makeEmail({
      from: "Vivek <vivek@affil.ai>",
      subject: "Fwd: Cannot log in",
      text: "Forwarding this.\n\n---------- Forwarded message ----------\nFrom: jane@customer.com",
    });
    expect(isFromInternalSender(forward, context)).toBe(true);
    expect(isForwardLikeEmail(forward)).toBe(true);
    const lookup = supportEmailLookupExternalIds(forward, context);
    expect(lookup).toContain("conversation:jane@customer.com:cannot log in");

    const external = makeEmail({ subject: "Fwd: Cannot log in" });
    expect(
      supportEmailLookupExternalIds(external, context).some((id) => id.startsWith("conversation:")),
    ).toBe(false);
  });

  it("uses conversation fallback for reply-like subjects when message references are missing", () => {
    const reply = makeEmail({
      id: "em_2",
      subject: "Re: Cannot log in",
      headers: { "Message-ID": "<msg-2@customer.com>" },
    });
    const lookup = supportEmailLookupExternalIds(reply, context);
    expect(lookup).toContain("message:msg-2@customer.com");
    expect(lookup).toContain("conversation:jane@customer.com:cannot log in");
  });

  it("stores original forwarded message ids and original sender conversation keys", () => {
    const forwarded = makeEmail({
      id: "em_forwarded",
      from: "Hello <hello@nextcard.com>",
      to: ["inbound@resend.dev"],
      headers: {
        "Message-ID": "<wrapped@nextcard.com>",
        "X-Original-Message-ID": "<msg-1@customer.com>",
        "X-Original-From": "Jane Doe <jane@customer.com>",
      },
    });
    const nextcardContext = { supportAddress: "hello@nextcard.com" };
    const ids = supportEmailStoredExternalIds(forwarded, nextcardContext);
    expect(ids).toContain("message:wrapped@nextcard.com");
    expect(ids).toContain("message:msg-1@customer.com");
    expect(ids).toContain("conversation:jane@customer.com:cannot log in");
    expect(emailSenderIdentityForContext(forwarded, nextcardContext)).toEqual({
      userId: "jane@customer.com",
      name: "Jane Doe",
    });
  });

  it("excludes the support address and internal domain from conversation participants", () => {
    const ids = supportEmailStoredExternalIds(
      makeEmail({ text: "cc'ing support@affil.ai and vivek@affil.ai plus jane@customer.com" }),
      context,
    );
    const conversationIds = ids.filter((id) => id.startsWith("conversation:"));
    expect(conversationIds).toEqual(["conversation:jane@customer.com:cannot log in"]);
  });
});

describe("webhook decode and signature", () => {
  it("decodes email.received and ignores other event types", () => {
    expect(decodeResendWebhook({ type: "email.received", data: { email_id: "em_1" } })).toEqual({
      type: "email.received",
      emailId: "em_1",
    });
    expect(decodeResendWebhook({ type: "email.sent", data: { email_id: "em_1" } })).toEqual({
      type: "ignored",
      reason: "ignored_event_type:email.sent",
    });
    expect(decodeResendWebhook({ type: "email.received", data: {} })).toEqual({
      type: "ignored",
      reason: "missing_email_id",
    });
  });

  it("accepts a valid Svix signature and rejects tampered bodies", () => {
    const secretRaw = Buffer.from("test-secret-material");
    const secret = `whsec_${secretRaw.toString("base64")}`;
    const body = JSON.stringify({ type: "email.received", data: { email_id: "em_1" } });
    const id = "msg_123";
    const timestamp = "1720000000";
    const signature = createHmac("sha256", secretRaw)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    const headers = {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature} v1,someotherbogussig=`,
    };

    expect(() => verifyResendWebhookSignature({ body, headers, secret })).not.toThrow();
    expect(() => verifyResendWebhookSignature({ body: `${body} `, headers, secret })).toThrow(
      /invalid/i,
    );
    expect(() =>
      verifyResendWebhookSignature({ body, headers: { "svix-id": id }, secret }),
    ).toThrow(/missing/i);
  });
});

describe("body handling and formatting", () => {
  it("falls back from text to html to a placeholder", () => {
    expect(emailBody(makeEmail({ text: null, html: "<p>Hello<br>world</p>" }))).toBe(
      "Hello\nworld",
    );
    expect(emailBody(makeEmail({ text: null, html: null }))).toBe("(empty email body)");
    expect(htmlToText("<style>p{}</style><p>Hi &amp; bye</p>")).toBe("Hi & bye");
  });

  it("strips quoted reply chains", () => {
    const body = [
      "Thanks, that fixed it!",
      "",
      "On Mon, Jul 6, 2026 at 9:00 AM Support wrote:",
      "> We pushed a fix.",
    ].join("\n");
    expect(stripQuotedEmailChain(body)).toBe("Thanks, that fixed it!");
  });

  it("formats the agent prompt with identity headers and keeps paths out of the Slack preview", () => {
    const email = makeEmail({
      headers: {
        "Message-ID": "<msg-1@customer.com>",
        "Reply-To": "jane.alt@customer.com",
      },
    });
    const prompt = formatSupportEmailForAgent(
      email,
      [
        {
          kind: "stored",
          id: "att_1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          localPath: "/tmp/att/screenshot.png",
        },
      ],
      context,
    );
    expect(prompt).toContain("From: Jane Doe <jane@customer.com>");
    expect(prompt).toContain("Header-Reply-To: jane.alt@customer.com");
    expect(prompt).toContain("/tmp/att/screenshot.png");

    const preview = supportEmailSlackPreview({ email, attachments: [], context });
    expect(preview).toContain("Subject: Cannot log in");
    expect(preview).not.toContain("/tmp/att/screenshot.png");
  });

  it("truncates long previews", () => {
    const email = makeEmail({ text: "x".repeat(5000) });
    const preview = supportEmailSlackPreview({ email, context });
    expect(preview.length).toBeLessThanOrEqual(2800);
    expect(preview).toContain("...[truncated]");
    expect(truncateText("short", 100)).toBe("short");
  });

  it("derives sender identity and slack title from the from header", () => {
    expect(emailSenderIdentity(makeEmail())).toEqual({
      userId: "jane@customer.com",
      name: "Jane Doe",
    });
    expect(emailSenderIdentity(makeEmail({ from: "jane@customer.com" }))).toEqual({
      userId: "jane@customer.com",
      name: "jane@customer.com",
    });
    expect(supportEmailSlackTitle(makeEmail())).toBe(
      "New support email from jane@customer.com: Cannot log in",
    );
    expect(normalizeEmailAddress("<JANE@Customer.com>")).toBe("jane@customer.com");
  });
});
