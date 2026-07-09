import path from "node:path";
import { CHAT_SOURCE_LABEL, CHAT_THREAD_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { z } from "zod";
import { JsonFileStore } from "./json-state.js";

export const CHAT_THREAD_LABEL = CHAT_THREAD_ID_LABEL;
export const CHAT_SOURCE_LABEL_KEY = CHAT_SOURCE_LABEL;

export const ChatDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("person"), key: z.string().min(1) }),
  z.object({
    kind: z.literal("channel"),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("conversation"), conversationId: z.string().min(1) }),
]);

const ChatStarterSchema = z.object({
  source: z.enum(["slack", "support"]),
  userId: z.string().min(1),
  name: z.string().min(1),
  handle: z.string().min(1).optional(),
  avatarUrl: z.string().min(1).optional(),
});

const InboundSessionBindingSchema = z.object({
  kind: z.literal("inbound-session"),
  externalThreadId: z.string(),
  rootAgentId: z.string(),
  startedBy: ChatStarterSchema.optional(),
  muted: z.boolean().default(false),
  activeRelayId: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const OutboundConversationBindingSchema = z.object({
  kind: z.literal("outbound-conversation"),
  conversationId: z.string(),
  externalThreadId: z.string(),
  officeAgentId: z.string(),
  destination: ChatDestinationSchema,
  subscribed: z.boolean().default(true),
  pendingRequestId: z.string().optional(),
  activeRelayId: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const LegacyThreadSessionSchema = z
  .object({
    kind: z.undefined().optional(),
    externalThreadId: z.string(),
    rootAgentId: z.string(),
    focusedAgentId: z.string().optional(),
    muted: z.boolean().default(false),
    activeChildAgentId: z.string().nullable().optional(),
    activeRelayId: z.string().nullable().default(null),
    title: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .transform((session) => ({
    kind: "inbound-session" as const,
    externalThreadId: session.externalThreadId,
    rootAgentId: session.rootAgentId,
    muted: session.muted,
    activeRelayId: session.activeRelayId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }));

const ChatBindingSchema = z.union([
  InboundSessionBindingSchema,
  OutboundConversationBindingSchema,
  LegacyThreadSessionSchema,
]);

const PendingQuestionSchema = z.object({
  agentId: z.string(),
  requestId: z.string(),
  createdAt: z.string(),
});

const PendingRequestSchema = z.object({
  requestId: z.string(),
  officeAgentId: z.string(),
  conversationId: z.string(),
  externalThreadId: z.string(),
  question: z.string(),
  deadlineAt: z.string(),
  status: z.enum(["pending", "answered", "timeout", "canceled"]),
  answer: z.string().nullable().default(null),
  answeredBy: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const LegacyDeliveryReceiptSchema = z
  .string()
  .transform((status) => ({ status: status === "completed" ? "completed" : "started" }));

const DeliveryReceiptSchema = z.union([
  z.object({
    status: z.enum(["started", "completed"]),
    completedAt: z.string().optional(),
    result: z.unknown().optional(),
  }),
  LegacyDeliveryReceiptSchema,
]);

const ChatAuditRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  officeAgentId: z.string(),
  toolName: z.string(),
  destination: ChatDestinationSchema.optional(),
  resolvedExternalThreadId: z.string().optional(),
  conversationId: z.string().optional(),
  messagePreview: z.string(),
  files: z
    .array(z.object({ filename: z.string(), mimeType: z.string(), size: z.number() }))
    .optional(),
  result: z.enum(["posted", "uploaded", "reacted", "blocked", "failed", "timeout", "canceled"]),
  errorCode: z.string().optional(),
});

const GithubPrLinkSchema = z.object({
  key: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  officeAgentId: z.string(),
  externalThreadId: z.string(),
  conversationId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const EmailClassificationSchema = z.object({
  isSupport: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});

const EmailAuditRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  source: z.string(),
  emailId: z.string(),
  result: z.enum(["created", "continued", "duplicate", "ignored", "non_support", "failed_open"]),
  subject: z.string().nullable().default(null),
  from: z.string().nullable().default(null),
  classification: EmailClassificationSchema.optional(),
  reason: z.string().optional(),
});

const StoreSchema = z.object({
  sessions: z.record(z.string(), ChatBindingSchema).default({}),
  eventReceipts: z.record(z.string(), z.string()).default({}),
  deliveryReceipts: z.record(z.string(), DeliveryReceiptSchema).default({}),
  pendingQuestions: z.record(z.string(), PendingQuestionSchema).default({}),
  pendingRequests: z.record(z.string(), PendingRequestSchema).default({}),
  auditRecords: z.array(ChatAuditRecordSchema).default([]),
  // email external id (message id / conversation key) → externalThreadId of the
  // owning Slack announce-thread session
  emailLinks: z.record(z.string(), z.string()).default({}),
  emailAuditRecords: z.array(EmailAuditRecordSchema).default([]),
  githubPrLinks: z.record(z.string(), z.array(GithubPrLinkSchema)).default({}),
});

export type ChatDestination = z.infer<typeof ChatDestinationSchema>;
export type ChatStarter = z.infer<typeof ChatStarterSchema>;
export type InboundSessionBinding = z.infer<typeof InboundSessionBindingSchema>;
export type OutboundConversationBinding = z.infer<typeof OutboundConversationBindingSchema>;
export type ChatBinding = InboundSessionBinding | OutboundConversationBinding;
export type ThreadSession = ChatBinding;
export type PendingRequest = z.infer<typeof PendingRequestSchema>;
export type ChatAuditRecord = z.infer<typeof ChatAuditRecordSchema>;
export type EmailAuditRecord = z.infer<typeof EmailAuditRecordSchema>;
export type GithubPrLink = z.infer<typeof GithubPrLinkSchema>;
type StoreData = z.infer<typeof StoreSchema>;

function emptyStore(): StoreData {
  return {
    sessions: {},
    eventReceipts: {},
    deliveryReceipts: {},
    pendingQuestions: {},
    pendingRequests: {},
    auditRecords: [],
    emailLinks: {},
    emailAuditRecords: [],
    githubPrLinks: {},
  };
}

function bindingOwnerAgentId(binding: ChatBinding): string {
  return binding.kind === "inbound-session" ? binding.rootAgentId : binding.officeAgentId;
}

export class ThreadSessionStore {
  private readonly store: JsonFileStore<StoreData>;

  constructor(stateDir: string) {
    this.store = new JsonFileStore(path.join(stateDir, "state.json"), emptyStore(), (value) =>
      StoreSchema.parse(value),
    );
  }

  load(): Promise<StoreData> {
    return this.store.load();
  }

  async getSession(externalThreadId: string): Promise<ChatBinding | null> {
    return this.getBinding(externalThreadId);
  }

  async getBinding(externalThreadId: string): Promise<ChatBinding | null> {
    return (await this.load()).sessions[externalThreadId] ?? null;
  }

  async upsertSession(session: ChatBinding): Promise<void> {
    await this.upsertBinding(session);
  }

  async upsertBinding(binding: ChatBinding): Promise<void> {
    await this.store.update((data) => {
      data.sessions[binding.externalThreadId] = {
        ...binding,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async updateSession(
    externalThreadId: string,
    mutator: (session: ChatBinding) => ChatBinding | void,
  ): Promise<ChatBinding | null> {
    return this.updateBinding(externalThreadId, mutator);
  }

  async updateBinding(
    externalThreadId: string,
    mutator: (binding: ChatBinding) => ChatBinding | void,
  ): Promise<ChatBinding | null> {
    let updated: ChatBinding | null = null;
    await this.store.update((data) => {
      const current = data.sessions[externalThreadId];
      if (!current) return;
      updated = mutator(current) ?? current;
      updated.updatedAt = new Date().toISOString();
      data.sessions[externalThreadId] = updated;
    });
    return updated;
  }

  async findSessionByAgent(agentId: string): Promise<ChatBinding | null> {
    const bindings = Object.values((await this.load()).sessions);
    return bindings.find((binding) => bindingOwnerAgentId(binding) === agentId) ?? null;
  }

  async findBindingsByAgent(agentId: string): Promise<ChatBinding[]> {
    const bindings = Object.values((await this.load()).sessions);
    return bindings
      .filter((binding) => bindingOwnerAgentId(binding) === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getConversation(conversationId: string): Promise<OutboundConversationBinding | null> {
    const bindings = Object.values((await this.load()).sessions);
    return (
      bindings.find(
        (binding): binding is OutboundConversationBinding =>
          binding.kind === "outbound-conversation" && binding.conversationId === conversationId,
      ) ?? null
    );
  }

  async deleteSession(externalThreadId: string): Promise<void> {
    await this.store.update((data) => {
      delete data.sessions[externalThreadId];
      delete data.pendingQuestions[externalThreadId];
      for (const [externalId, threadId] of Object.entries(data.emailLinks)) {
        if (threadId === externalThreadId) {
          delete data.emailLinks[externalId];
        }
      }
      for (const [key, links] of Object.entries(data.githubPrLinks)) {
        data.githubPrLinks[key] = links.filter(
          (link) => link.externalThreadId !== externalThreadId,
        );
        if (data.githubPrLinks[key].length === 0) delete data.githubPrLinks[key];
      }
      for (const [requestId, request] of Object.entries(data.pendingRequests)) {
        if (request.externalThreadId === externalThreadId && request.status === "pending") {
          data.pendingRequests[requestId] = {
            ...request,
            status: "canceled",
            updatedAt: new Date().toISOString(),
          };
        }
      }
    });
  }

  async getEmailLink(externalId: string): Promise<string | null> {
    return (await this.load()).emailLinks[externalId] ?? null;
  }

  async putEmailLinks(externalIds: string[], externalThreadId: string): Promise<void> {
    if (externalIds.length === 0) return;
    await this.store.update((data) => {
      for (const externalId of externalIds) {
        data.emailLinks[externalId] = externalThreadId;
      }
    });
  }

  async recordEmailAudit(record: Omit<EmailAuditRecord, "timestamp">): Promise<void> {
    await this.store.update((data) => {
      data.emailAuditRecords.push({ ...record, timestamp: new Date().toISOString() });
      if (data.emailAuditRecords.length > 500) {
        data.emailAuditRecords.splice(0, data.emailAuditRecords.length - 500);
      }
    });
  }

  async hasEventReceipt(eventId: string): Promise<boolean> {
    return Boolean((await this.load()).eventReceipts[eventId]);
  }

  async markEventProcessed(eventId: string): Promise<boolean> {
    let fresh = false;
    await this.store.update((data) => {
      if (data.eventReceipts[eventId]) return;
      data.eventReceipts[eventId] = new Date().toISOString();
      fresh = true;
    });
    return fresh;
  }

  async markDeliveryStarted(key: string): Promise<boolean> {
    let fresh = false;
    await this.store.update((data) => {
      if (data.deliveryReceipts[key]?.status === "completed") return;
      data.deliveryReceipts[key] = { status: "started" };
      fresh = true;
    });
    return fresh;
  }

  async markDeliveryCompleted(key: string, result?: unknown): Promise<void> {
    await this.store.update((data) => {
      data.deliveryReceipts[key] = {
        status: "completed",
        completedAt: new Date().toISOString(),
        ...(result === undefined ? {} : { result }),
      };
    });
  }

  async getCompletedDeliveryResult<T>(key: string): Promise<T | null> {
    const receipt = (await this.load()).deliveryReceipts[key];
    if (receipt?.status !== "completed" || !("result" in receipt)) return null;
    return (receipt.result as T | undefined) ?? null;
  }

  async setPendingQuestion(
    externalThreadId: string,
    agentId: string,
    requestId: string,
  ): Promise<void> {
    await this.store.update((data) => {
      data.pendingQuestions[externalThreadId] = {
        agentId,
        requestId,
        createdAt: new Date().toISOString(),
      };
    });
  }

  async takePendingQuestion(
    externalThreadId: string,
  ): Promise<{ agentId: string; requestId: string } | null> {
    let question: { agentId: string; requestId: string } | null = null;
    await this.store.update((data) => {
      const current = data.pendingQuestions[externalThreadId];
      if (!current) return;
      question = { agentId: current.agentId, requestId: current.requestId };
      delete data.pendingQuestions[externalThreadId];
    });
    return question;
  }

  async createPendingRequest(request: PendingRequest): Promise<void> {
    await this.store.update((data) => {
      data.pendingRequests[request.requestId] = request;
      const binding = data.sessions[request.externalThreadId];
      if (binding?.kind === "outbound-conversation") {
        data.sessions[request.externalThreadId] = {
          ...binding,
          pendingRequestId: request.requestId,
          updatedAt: new Date().toISOString(),
        };
      }
    });
  }

  async takePendingRequestForThread(externalThreadId: string): Promise<PendingRequest | null> {
    let request: PendingRequest | null = null;
    await this.store.update((data) => {
      request =
        Object.values(data.pendingRequests).find(
          (candidate) =>
            candidate.externalThreadId === externalThreadId && candidate.status === "pending",
        ) ?? null;
      if (!request) return;
      const now = new Date().toISOString();
      data.pendingRequests[request.requestId] = {
        ...request,
        status: "answered",
        updatedAt: now,
      };
      const binding = data.sessions[externalThreadId];
      if (
        binding?.kind === "outbound-conversation" &&
        binding.pendingRequestId === request.requestId
      ) {
        const { pendingRequestId: _pendingRequestId, ...withoutPending } = binding;
        data.sessions[externalThreadId] = { ...withoutPending, updatedAt: now };
      }
    });
    return request;
  }

  async finishPendingRequest(
    requestId: string,
    status: "answered" | "timeout" | "canceled",
    answer: string | null,
    answeredBy: string | null,
  ): Promise<PendingRequest | null> {
    let updated: PendingRequest | null = null;
    await this.store.update((data) => {
      const current = data.pendingRequests[requestId];
      if (!current) return;
      updated = {
        ...current,
        status,
        answer,
        answeredBy,
        updatedAt: new Date().toISOString(),
      };
      data.pendingRequests[requestId] = updated;
      const binding = data.sessions[current.externalThreadId];
      if (binding?.kind === "outbound-conversation" && binding.pendingRequestId === requestId) {
        const { pendingRequestId: _pendingRequestId, ...withoutPending } = binding;
        data.sessions[current.externalThreadId] = {
          ...withoutPending,
          updatedAt: updated.updatedAt,
        };
      }
    });
    return updated;
  }

  async expirePendingRequests(now: Date): Promise<PendingRequest[]> {
    const expired: PendingRequest[] = [];
    await this.store.update((data) => {
      const timestamp = now.toISOString();
      for (const request of Object.values(data.pendingRequests)) {
        if (request.status !== "pending" || Date.parse(request.deadlineAt) > now.getTime()) {
          continue;
        }
        const updated = { ...request, status: "timeout" as const, updatedAt: timestamp };
        data.pendingRequests[request.requestId] = updated;
        expired.push(updated);
        const binding = data.sessions[request.externalThreadId];
        if (
          binding?.kind === "outbound-conversation" &&
          binding.pendingRequestId === request.requestId
        ) {
          const { pendingRequestId: _pendingRequestId, ...withoutPending } = binding;
          data.sessions[request.externalThreadId] = { ...withoutPending, updatedAt: timestamp };
        }
      }
    });
    return expired;
  }

  async recordGithubPrLinks(
    prs: Array<{ key: string; owner: string; repo: string; number: number; url: string }>,
    owner: { officeAgentId: string; externalThreadId: string; conversationId?: string },
  ): Promise<void> {
    if (prs.length === 0) return;
    await this.store.update((data) => {
      const now = new Date().toISOString();
      for (const pr of prs) {
        const links = data.githubPrLinks[pr.key] ?? [];
        const existingIndex = links.findIndex(
          (link) =>
            link.officeAgentId === owner.officeAgentId &&
            link.externalThreadId === owner.externalThreadId,
        );
        const existing = existingIndex >= 0 ? links[existingIndex] : null;
        const next: GithubPrLink = {
          ...pr,
          officeAgentId: owner.officeAgentId,
          externalThreadId: owner.externalThreadId,
          ...(owner.conversationId ? { conversationId: owner.conversationId } : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existingIndex >= 0) {
          links[existingIndex] = next;
        } else {
          links.push(next);
        }
        data.githubPrLinks[pr.key] = links;
      }
    });
  }

  async findGithubPrLinks(key: string): Promise<GithubPrLink[]> {
    return [...((await this.load()).githubPrLinks[key] ?? [])].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async appendAuditRecord(record: ChatAuditRecord): Promise<void> {
    await this.store.update((data) => {
      data.auditRecords.push(record);
      if (data.auditRecords.length > 1_000) {
        data.auditRecords = data.auditRecords.slice(-1_000);
      }
    });
  }
}

export function getBindingOwnerAgentId(binding: ChatBinding): string {
  return bindingOwnerAgentId(binding);
}
