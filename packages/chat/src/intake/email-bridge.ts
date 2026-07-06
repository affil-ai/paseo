import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AdapterPostableMessage, FileUpload, SentMessage } from "chat";
import type { ChatEmailConfig, ChatRelayMode } from "../config.js";
import {
  assembleFollowupPrompt,
  assembleInitialPrompt,
  EMAIL_TRIAGE_INSTRUCTION,
  externalIntakeAgentPrompt,
  incomingEmailInstruction,
} from "../prompt.js";
import { normalizeSlackChannelId, threadIdFromPostedMessage } from "../service.js";
import { getBindingOwnerAgentId, type ThreadSessionStore } from "../state/thread-session-store.js";
import {
  decodeResendWebhook,
  emailBody,
  emailSenderIdentity,
  fetchResendReceivedEmail,
  formatFollowupEmailForAgent,
  formatSupportEmailForAgent,
  processEmailAttachments,
  stripQuotedEmailChain,
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
  type ResendReceivedEmailWebhook,
} from "./email-resend.js";

const REPLY_PREVIEW_MAX_CHARS = 2800;

export interface EmailWebhookResult {
  status: number;
  body: unknown;
}

interface EmailChatTarget {
  id: string;
  post(message: AdapterPostableMessage): Promise<Pick<SentMessage, "id" | "threadId">>;
}

interface EmailChatThread {
  post(message: AdapterPostableMessage): Promise<unknown>;
  subscribe(): Promise<unknown>;
}

export interface EmailChatLike {
  channel(channelId: string): EmailChatTarget;
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
    title: string;
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
    if (this.inFlight.has(emailId) || (await this.deps.store.hasEventReceipt(eventId))) {
      return { status: 200, body: { accepted: true, duplicate: true } };
    }

    this.inFlight.add(emailId);
    try {
      return await this.processEmail(emailId, eventId);
    } catch (error) {
      // Leave the event receipt unmarked so Resend's retry reprocesses the email.
      console.warn("Email intake failed", error);
      return { status: 500, body: { error: errorSummary(error) } };
    } finally {
      this.inFlight.delete(emailId);
    }
  }

  private async processEmail(emailId: string, eventId: string): Promise<EmailWebhookResult> {
    const email = await fetchResendReceivedEmail({ emailId, apiKey: this.deps.email.apiKey });
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

    const processed = await processEmailAttachments({
      email,
      apiKey: this.deps.email.apiKey,
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
    const sender = emailSenderIdentity(input.email);
    const slackFiles = await emailSlackFiles(input.processed.attachments);
    const previewText = truncateText(
      stripQuotedEmailChain(emailBody(input.email)),
      REPLY_PREVIEW_MAX_CHARS,
    );

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
        incomingEmailInstruction(this.deps.relayMode),
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
    return { status: 200, body: { accepted: true, continued: true } };
  }

  private async startSession(input: {
    email: Awaited<ReturnType<typeof fetchResendReceivedEmail>>;
    eventId: string;
    storedIds: string[];
    processed: Awaited<ReturnType<typeof processEmailAttachments>>;
  }): Promise<EmailWebhookResult> {
    const channel = this.deps.chat.channel(normalizeSlackChannelId(this.deps.email.channelId));
    const preview = supportEmailSlackPreview({
      email: input.email,
      attachments: input.processed.attachments,
      context: this.context,
    });
    const slackFiles = await emailSlackFiles(input.processed.attachments);
    const sent = await channel.post({
      markdown: `*${supportEmailSlackTitle(input.email)}*\n\n${markdownCodeBlock(preview)}`,
      ...(slackFiles.length > 0 ? { files: slackFiles } : {}),
    });
    const externalThreadId = threadIdFromPostedMessage(channel.id, sent);
    await this.deps.chat.thread(externalThreadId).subscribe();

    try {
      const session = await this.deps.bridge.createExternalSession({
        externalThreadId,
        title: supportEmailTitle(input.email),
        initialPrompt: assembleInitialPrompt({
          basePrompt: externalIntakeAgentPrompt(this.deps.relayMode),
          customPrompt: [await this.deps.officePrompt, EMAIL_TRIAGE_INSTRUCTION]
            .filter(Boolean)
            .join("\n\n"),
          sender: emailSenderIdentity(input.email),
          text: formatSupportEmailForAgent(input.email, input.processed.attachments, this.context),
          relayMode: this.deps.relayMode,
          sourceInstruction: incomingEmailInstruction(this.deps.relayMode),
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
}
