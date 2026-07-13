import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AdapterPostableMessage, FileUpload, RawMessage } from "chat";
import type { ChatEmailConfig, ChatRelayMode } from "../config.js";
import {
  assembleExternalIntakeSystemPrompt,
  assembleFollowupPrompt,
  assembleInitialPrompt,
  EMAIL_TRIAGE_INSTRUCTION,
  externalIntakeAgentPrompt,
  incomingEmailInstruction,
} from "../prompt.js";
import { normalizeSlackChannelId } from "../service.js";
import { getBindingOwnerAgentId, type ThreadSessionStore } from "../state/thread-session-store.js";
import type { EmailClassifier } from "./email-classifier.js";
import {
  decodeResendWebhook,
  type EmailAttachmentDownloader,
  emailBody,
  emailSenderIdentityForContext,
  fetchResendReceivedEmail,
  formatFollowupEmailForAgent,
  formatSupportEmailForAgent,
  processEmailAttachments,
  supportEmailDuplicateExternalIds,
  supportEmailLookupExternalIds,
  supportEmailSlackPreview,
  supportEmailSlackTitle,
  supportEmailStoredExternalIds,
  supportEmailTitle,
  truncateText,
  verifyResendWebhookSignature,
  type EmailIntakeContext,
  type ProcessedEmailAttachment,
  type ResendReceivedEmail,
  type ResendReceivedEmailWebhook,
} from "./email-resend.js";

const REPLY_PREVIEW_MAX_CHARS = 2800;

export interface EmailWebhookResult {
  status: number;
  body: unknown;
}

class SlackChannelIdentityError extends Error {
  constructor(
    readonly requestedChannelId: string,
    readonly messageId: string,
  ) {
    super("Slack adapter post response did not include a canonical channel ID");
    this.name = "SlackChannelIdentityError";
  }
}

interface EmailChatThread {
  post(message: AdapterPostableMessage): Promise<unknown>;
  subscribe(): Promise<unknown>;
}

export interface EmailChatLike {
  postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<unknown>>;
  thread(threadId: string): EmailChatThread;
}

export interface EmailDaemonClient {
  sendAgentMessage(
    agentId: string,
    message: string,
    options?: {
      images?: Array<{ data: string; mimeType: string }>;
      attachments?: AgentAttachment[];
    },
  ): Promise<unknown>;
  fetchAgentTimeline(
    agentId: string,
    options: { direction: "tail"; projection: "canonical"; limit: number },
  ): Promise<{ window: { nextSeq: number } }>;
}

export interface EmailSessionBridge {
  createExternalSession(input: {
    externalThreadId: string;
    source: "slack" | "support";
    title: string;
    workspaceTitlePrompt?: string;
    systemPrompt?: string;
    initialPrompt: string;
    images?: Array<{ data: string; mimeType: string }>;
    attachments?: AgentAttachment[];
    initialRelayId?: string;
  }): Promise<{ rootAgentId: string }>;
  startRelay(input: {
    externalThreadId: string;
    agentId: string;
    relayId: string;
    sinceSeq: number;
    source?: string;
    postFirstReply?: boolean;
  }): Promise<void>;
}

export interface EmailIntakeBridgeDeps {
  email: ChatEmailConfig;
  relayMode: ChatRelayMode;
  stateDir: string;
  maxUploadBytes: number;
  officePrompt: Promise<string> | string;
  classifier?: EmailClassifier | undefined;
  attachmentDownloader?: EmailAttachmentDownloader | undefined;
  chat: EmailChatLike;
  client: EmailDaemonClient;
  store: ThreadSessionStore;
  bridge: EmailSessionBridge;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
}

function markdownCodeBlock(text: string): string {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}\n${text}\n${fence}`;
}

async function emailSlackFiles(
  attachments: readonly ProcessedEmailAttachment[],
): Promise<FileUpload[]> {
  const files: FileUpload[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== "stored") continue;
    try {
      const file: FileUpload = {
        data: await readFile(attachment.localPath),
        filename: basename(attachment.name),
      };
      if (attachment.mimeType !== undefined) file.mimeType = attachment.mimeType;
      files.push(file);
    } catch (error) {
      console.warn("Failed to load email attachment for Slack preview", {
        path: attachment.localPath,
        error,
      });
    }
  }
  return files;
}

export class EmailIntakeBridge {
  private readonly inFlight = new Set<string>();
  private readonly context: EmailIntakeContext;

  constructor(private readonly deps: EmailIntakeBridgeDeps) {
    this.context = { supportAddress: deps.email.supportAddress };
  }

  async handleResendWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<EmailWebhookResult> {
    if (this.deps.email.provider !== "resend") {
      return { status: 404, body: { error: "Resend email intake is not enabled" } };
    }

    try {
      verifyResendWebhookSignature({
        body: rawBody,
        headers: normalizeHeaders(headers),
        secret: this.deps.email.webhookSecret,
      });
    } catch (error) {
      return { status: 401, body: { error: errorSummary(error) } };
    }

    let payload: ResendReceivedEmailWebhook;
    try {
      payload = JSON.parse(rawBody) as ResendReceivedEmailWebhook;
    } catch {
      return { status: 400, body: { error: "Invalid JSON payload" } };
    }

    const decoded = decodeResendWebhook(payload);
    if (decoded.type === "ignored") {
      return { status: 200, body: { accepted: true, ignored: true, reason: decoded.reason } };
    }

    const emailId = decoded.emailId;
    const eventId = `email:resend:${emailId}`;
    try {
      const email = await fetchResendReceivedEmail({ emailId, apiKey: this.deps.email.apiKey });
      return await this.handleEmail({ ...email, source: "resend" }, eventId);
    } catch (error) {
      // Leave the event receipt unmarked so Resend's retry reprocesses the email.
      console.warn("Email intake failed", error);
      return { status: 500, body: { error: errorSummary(error) } };
    }
  }

  async handleEmail(email: ResendReceivedEmail, eventId: string): Promise<EmailWebhookResult> {
    if (this.inFlight.has(eventId) || (await this.deps.store.hasEventReceipt(eventId))) {
      return { status: 200, body: { accepted: true, duplicate: true } };
    }

    this.inFlight.add(eventId);
    try {
      return await this.processEmail(email, eventId);
    } finally {
      this.inFlight.delete(eventId);
    }
  }

  private async processEmail(
    email: ResendReceivedEmail,
    eventId: string,
  ): Promise<EmailWebhookResult> {
    const duplicateIds = new Set(supportEmailDuplicateExternalIds(email));
    const storedIds = supportEmailStoredExternalIds(email, this.context);

    let existingThreadId: string | null = null;
    for (const id of supportEmailLookupExternalIds(email, this.context)) {
      const threadId = await this.deps.store.getEmailLink(id);
      if (!threadId) continue;
      if (duplicateIds.has(id)) {
        // Redelivery of an already-processed email under a new Resend event.
        await this.deps.store.putEmailLinks(storedIds, threadId);
        await this.deps.store.markEventProcessed(eventId);
        return { status: 200, body: { accepted: true, duplicate: true } };
      }
      if (await this.deps.store.getSession(threadId)) {
        existingThreadId = threadId;
        break;
      }
      // Stale link (session retired via `done`): keep looking, else start fresh.
    }

    if (!existingThreadId) {
      const classification = await this.classifyNewEmail(email);
      if (!classification.isSupport) {
        await this.deps.store.recordEmailAudit({
          id: eventId,
          source: email.source ?? "resend",
          emailId: email.id,
          result: "non_support",
          subject: email.subject ?? null,
          from: email.from ?? null,
          classification,
        });
        await this.deps.store.markEventProcessed(eventId);
        return { status: 200, body: { accepted: true, ignored: true, reason: "non_support" } };
      }
      if (classification.confidence === 0 && classification.reason.includes("failed open")) {
        await this.deps.store.recordEmailAudit({
          id: `${eventId}:classification`,
          source: email.source ?? "resend",
          emailId: email.id,
          result: "failed_open",
          subject: email.subject ?? null,
          from: email.from ?? null,
          classification,
        });
      }
    }

    const processed = await processEmailAttachments({
      email,
      ...(this.deps.email.provider === "resend" ? { apiKey: this.deps.email.apiKey } : {}),
      downloader: this.deps.attachmentDownloader,
      storageDir: join(this.deps.stateDir, "email-attachments"),
      maxUploadBytes: this.deps.maxUploadBytes,
    });

    if (existingThreadId) {
      return this.continueSession({ email, eventId, storedIds, processed, existingThreadId });
    }
    return this.startSession({ email, eventId, storedIds, processed });
  }

  private async continueSession(input: {
    email: Awaited<ReturnType<typeof fetchResendReceivedEmail>>;
    eventId: string;
    storedIds: string[];
    processed: Awaited<ReturnType<typeof processEmailAttachments>>;
    existingThreadId: string;
  }): Promise<EmailWebhookResult> {
    const binding = await this.deps.store.getSession(input.existingThreadId);
    if (!binding) throw new Error("Email session disappeared while processing reply");
    const ownerAgentId = getBindingOwnerAgentId(binding);
    const sender = emailSenderIdentityForContext(input.email, this.context);
    const slackFiles = await emailSlackFiles(input.processed.attachments);
    const previewText = truncateText(emailBody(input.email), REPLY_PREVIEW_MAX_CHARS);

    await this.deps.chat
      .thread(input.existingThreadId)
      .post({
        markdown: `📧 *Email reply from ${sender.name}*\n\n${markdownCodeBlock(previewText)}`,
        ...(slackFiles.length > 0 ? { files: slackFiles } : {}),
      })
      .catch((error) => {
        console.warn("Failed to post email reply preview to Slack", error);
      });

    const timeline = await this.deps.client.fetchAgentTimeline(ownerAgentId, {
      direction: "tail",
      projection: "canonical",
      limit: 1,
    });
    if (this.deps.relayMode === "auto") {
      await this.deps.store.updateSession(input.existingThreadId, (current) => {
        current.activeRelayId = input.eventId;
      });
    }
    await this.deps.client.sendAgentMessage(
      ownerAgentId,
      assembleFollowupPrompt(
        sender,
        formatFollowupEmailForAgent(input.email, input.processed.attachments),
        this.deps.relayMode,
        incomingEmailInstruction(this.deps.relayMode, this.context.supportAddress),
      ),
      { images: input.processed.images, attachments: input.processed.agentAttachments },
    );
    await this.deps.bridge.startRelay({
      externalThreadId: input.existingThreadId,
      agentId: ownerAgentId,
      relayId: input.eventId,
      sinceSeq: timeline.window.nextSeq,
      source: "email",
      postFirstReply: false,
    });
    await this.deps.store.putEmailLinks(input.storedIds, input.existingThreadId);
    await this.deps.store.markEventProcessed(input.eventId);
    await this.deps.store.recordEmailAudit({
      id: input.eventId,
      source: input.email.source ?? "resend",
      emailId: input.email.id,
      result: "continued",
      subject: input.email.subject ?? null,
      from: input.email.from ?? null,
    });
    return { status: 200, body: { accepted: true, continued: true } };
  }

  private async startSession(input: {
    email: Awaited<ReturnType<typeof fetchResendReceivedEmail>>;
    eventId: string;
    storedIds: string[];
    processed: Awaited<ReturnType<typeof processEmailAttachments>>;
  }): Promise<EmailWebhookResult> {
    const channelId = normalizeSlackChannelId(this.deps.email.channelId);
    const preview = supportEmailSlackPreview({
      email: input.email,
      attachments: input.processed.attachments,
      context: this.context,
    });
    const slackFiles = await emailSlackFiles(input.processed.attachments);
    const sent = await this.deps.chat.postChannelMessage(channelId, {
      markdown: `*${supportEmailSlackTitle(input.email, this.context)}*\n\n${markdownCodeBlock(preview)}`,
      ...(slackFiles.length > 0 ? { files: slackFiles } : {}),
    });
    const postedPayload = sent.raw;
    const hasCanonicalChannelId =
      typeof postedPayload === "object" &&
      postedPayload !== null &&
      "channel" in postedPayload &&
      typeof postedPayload.channel === "string" &&
      /^[CDG][A-Z0-9]+$/.test(postedPayload.channel);
    if (!hasCanonicalChannelId) {
      throw new SlackChannelIdentityError(channelId, sent.id);
    }
    const externalThreadId = `slack:${postedPayload.channel}:${sent.id}`;
    await this.deps.chat.thread(externalThreadId).subscribe();

    try {
      const session = await this.deps.bridge.createExternalSession({
        externalThreadId,
        source: "support",
        title: supportEmailTitle(input.email),
        systemPrompt: assembleExternalIntakeSystemPrompt({
          basePrompt: externalIntakeAgentPrompt(this.deps.relayMode),
          customPrompt: [await this.deps.officePrompt, EMAIL_TRIAGE_INSTRUCTION]
            .filter(Boolean)
            .join("\n\n"),
        }),
        initialPrompt: assembleInitialPrompt({
          sender: emailSenderIdentityForContext(input.email, this.context),
          text: formatSupportEmailForAgent(input.email, input.processed.attachments, this.context),
          relayMode: this.deps.relayMode,
          sourceInstruction: incomingEmailInstruction(
            this.deps.relayMode,
            this.context.supportAddress,
          ),
        }),
        images: input.processed.images,
        attachments: input.processed.agentAttachments,
        ...(this.deps.relayMode === "auto" ? { initialRelayId: input.eventId } : {}),
      });
      await this.deps.store.putEmailLinks(input.storedIds, externalThreadId);
      await this.deps.bridge.startRelay({
        externalThreadId,
        agentId: session.rootAgentId,
        relayId: input.eventId,
        sinceSeq: 0,
        source: "email",
        postFirstReply: false,
      });
      await this.deps.store.markEventProcessed(input.eventId);
      await this.deps.store.recordEmailAudit({
        id: input.eventId,
        source: input.email.source ?? "resend",
        emailId: input.email.id,
        result: "created",
        subject: input.email.subject ?? null,
        from: input.email.from ?? null,
      });
      return { status: 200, body: { accepted: true, created: true } };
    } catch (error) {
      // The announce thread already exists; surface the failure there and stop
      // retrying rather than letting Resend redeliver forever.
      const reason = errorSummary(error);
      await this.deps.chat
        .thread(externalThreadId)
        .post({ markdown: `I couldn't start triage for this email. Reason: ${reason}` })
        .catch(() => {});
      await this.deps.store.markEventProcessed(input.eventId);
      return { status: 200, body: { accepted: true, error: reason } };
    }
  }

  private async classifyNewEmail(email: ResendReceivedEmail) {
    if (!this.deps.classifier) {
      return { isSupport: true, confidence: 0, reason: "classifier_not_configured; failed open" };
    }
    try {
      return await this.deps.classifier(email);
    } catch (error) {
      return {
        isSupport: true,
        confidence: 0,
        reason: `classifier_error:${errorSummary(error)}; failed open`,
      };
    }
  }
}
