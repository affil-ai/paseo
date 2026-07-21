import { createHash } from "node:crypto";
import type { FetchAgentTimelinePayload } from "@getpaseo/client/internal/daemon-client";
import type { ChatBridgeClient } from "./bridge.js";
import type { OfficeV2RelayEvent } from "./office-adapter.js";
import {
  getBindingOwnerAgentId,
  type ChatBinding,
  type ThreadSessionStore,
} from "./state/thread-session-store.js";

type TimelineEntry = FetchAgentTimelinePayload["entries"][number];
type TerminalKind = "completed" | "failed" | "canceled";

interface TurnSegment {
  boundary: {
    kind: "human" | "autonomous";
    seqStart: number;
    seqEnd: number;
    timestamp: string;
    messageId?: string;
  };
  entries: TimelineEntry[];
  providerTurnId: string;
}

interface OfficeRelayEventResult {
  outcome?: string;
}

export interface OfficeTimelineRelayAdapter {
  postRelayEvent(event: OfficeV2RelayEvent): Promise<OfficeRelayEventResult | void>;
}

/**
 * Projects the durable parent-agent timeline into Office. The daemon stream is
 * only a wake-up signal: replay comes from fetchAgentTimeline, with human turns
 * bounded by user messages and autonomous continuations bounded by the durable
 * relay cursor.
 */
export class OfficeTimelineRelay {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Pick<ChatBridgeClient, "fetchAgentTimeline">,
    private readonly store: ThreadSessionStore,
    private readonly adapter: OfficeTimelineRelayAdapter,
  ) {}

  wake(
    agentId: string,
    terminal?: { kind: TerminalKind; errorCode?: string; occurredAt?: number },
  ): Promise<void> {
    const prior = this.queues.get(agentId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.catchUp(agentId, terminal))
      .finally(() => {
        if (this.queues.get(agentId) === next) this.queues.delete(agentId);
      });
    this.queues.set(agentId, next);
    return next;
  }

  async recover(): Promise<void> {
    const sessions = Object.values((await this.store.load()).sessions).filter(
      (session) => session.officeRelay && !session.supersededByOfficeBindingId,
    );
    for (const session of sessions) {
      const timeline = await this.fetchTimeline(getBindingOwnerAgentId(session));
      const status = timeline.agent?.status;
      await this.wake(
        getBindingOwnerAgentId(session),
        session.officeRelay?.activeTurn && status !== "initializing" && status !== "running"
          ? { kind: "completed" }
          : undefined,
      );
    }
  }

  private async catchUp(
    agentId: string,
    terminal?: { kind: TerminalKind; errorCode?: string; occurredAt?: number },
  ): Promise<void> {
    const session = await this.store.findSessionByAgent(agentId);
    if (!session?.officeRelay || session.supersededByOfficeBindingId) return;
    const timeline = await this.fetchTimeline(agentId);
    const relay = session.officeRelay;

    if (relay.epoch && relay.epoch !== timeline.epoch) {
      await this.adoptTimelineEpoch(session, timeline);
    }

    const turns = partitionTurns(agentId, timeline.epoch, timeline.entries, {
      acknowledgedSeq: relay.acknowledgedSeq,
      activeTurn: relay.activeTurn,
      hasPendingOfficeTurn: Boolean(session.activeOfficeTurn),
    });
    const activeId = relay.activeTurn?.providerTurnId;
    const candidates = turns.filter(
      (turn) =>
        turn.boundary.seqEnd > relay.acknowledgedSeq ||
        turn.entries.some((entry) => entry.seqEnd > relay.acknowledgedSeq) ||
        turn.providerTurnId === activeId,
    );

    for (let index = 0; index < candidates.length; index += 1) {
      const turn = candidates[index]!;
      const originalIndex = turns.findIndex(
        (candidate) => candidate.providerTurnId === turn.providerTurnId,
      );
      const inferredTerminal = originalIndex >= 0 && originalIndex < turns.length - 1;
      const isLatest = originalIndex === turns.length - 1;
      const terminalForTurn = inferredTerminal || (isLatest && Boolean(terminal));
      await this.relayTurn(session, timeline.epoch, turn, relay.acknowledgedSeq, {
        terminal: terminalForTurn,
        terminalKind: isLatest ? terminal?.kind : "completed",
        errorCode: isLatest ? terminal?.errorCode : undefined,
        occurredAt: isLatest ? terminal?.occurredAt : undefined,
      });
      const refreshed = await this.store.getSession(session.externalThreadId);
      if (!refreshed?.officeRelay) return;
      relay.acknowledgedSeq = refreshed.officeRelay.acknowledgedSeq;
      relay.activeTurn = refreshed.officeRelay.activeTurn;
    }
  }

  private async adoptTimelineEpoch(
    session: ChatBinding,
    timeline: FetchAgentTimelinePayload,
  ): Promise<void> {
    const relay = session.officeRelay;
    if (!relay) return;
    const receiptId =
      session.activeOfficeTurn?.version === 2
        ? session.activeOfficeTurn.receiptId
        : relay.activeTurn?.receiptId;
    const exactPendingBoundary = receiptId
      ? timeline.entries.find(
          (entry) => entry.item.type === "user_message" && entry.item.messageId === receiptId,
        )
      : undefined;
    // Provider session rehydration can preserve the durable conversation while
    // dropping the messageId metadata that Office attached to the prompt. An
    // active Office turn is always the newest human input on this binding, so
    // resume at that boundary instead of treating the new epoch's tail as
    // already acknowledged and silently skipping the whole turn.
    const pendingBoundary =
      exactPendingBoundary ??
      (session.activeOfficeTurn
        ? timeline.entries.findLast((entry) => entry.item.type === "user_message")
        : undefined);
    const acknowledgedSeq = pendingBoundary
      ? Math.max(0, pendingBoundary.seqStart - 1)
      : Math.min(relay.acknowledgedSeq, Math.max(0, timeline.window.nextSeq - 1));
    await this.store.updateSession(session.externalThreadId, (binding) => {
      if (!binding.officeRelay) return;
      binding.officeRelay.epoch = timeline.epoch;
      binding.officeRelay.acknowledgedSeq = acknowledgedSeq;
      binding.officeRelay.activeTurn = undefined;
    });
    relay.epoch = timeline.epoch;
    relay.acknowledgedSeq = acknowledgedSeq;
    relay.activeTurn = undefined;
  }

  private async relayTurn(
    session: ChatBinding,
    epoch: string,
    turn: TurnSegment,
    acknowledgedSeq: number,
    terminal: {
      terminal: boolean;
      terminalKind?: TerminalKind;
      errorCode?: string;
      occurredAt?: number;
    },
  ): Promise<void> {
    const relay = session.officeRelay;
    if (!relay) return;
    let boundaryReceiptId = turn.boundary.messageId;
    let dispatchReceipt = boundaryReceiptId
      ? await this.store.getOfficeDispatchReceipt(boundaryReceiptId)
      : null;
    if (!dispatchReceipt && session.activeOfficeTurn?.version === 2) {
      boundaryReceiptId = session.activeOfficeTurn.receiptId;
      dispatchReceipt = await this.store.getOfficeDispatchReceipt(boundaryReceiptId);
    }
    const startedAt = Date.parse(turn.boundary.timestamp);

    if (dispatchReceipt) {
      await this.adapter.postRelayEvent({
        version: 2,
        eventId: `${turn.providerTurnId}:accepted`,
        kind: "accepted",
        bindingId: relay.bindingId,
        runId: dispatchReceipt.runId,
        receiptId: boundaryReceiptId!,
        agentId: relay.agentId,
        providerTurnId: turn.providerTurnId,
        timelineStartSeq: turn.boundary.seqStart,
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      });
      await this.store.updateOfficeDispatchReceipt(boundaryReceiptId!, {
        status: "attached",
        providerTurnId: turn.providerTurnId,
      });
    } else {
      await this.adapter.postRelayEvent({
        version: 2,
        eventId: `${turn.providerTurnId}:started`,
        kind: "turnStarted",
        bindingId: relay.bindingId,
        agentId: relay.agentId,
        providerTurnId: turn.providerTurnId,
        timelineStartSeq: turn.boundary.seqStart,
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      });
    }

    await this.store.updateSession(session.externalThreadId, (binding) => {
      if (!binding.officeRelay) return;
      binding.officeRelay.epoch = epoch;
      binding.officeRelay.activeTurn = {
        providerTurnId: turn.providerTurnId,
        ...(dispatchReceipt && boundaryReceiptId ? { receiptId: boundaryReceiptId } : {}),
        startSeq: turn.boundary.seqStart,
      };
      binding.officeRelay.acknowledgedSeq = Math.max(
        binding.officeRelay.acknowledgedSeq,
        turn.boundary.seqEnd,
      );
    });

    const presentable = turn.entries.flatMap((entry, index) => {
      const item = projectItem(entry, {
        assistantClosed:
          terminal.terminal ||
          index < turn.entries.length - 1 ||
          entry.item.type !== "assistant_message",
      });
      return item ? [{ entry, ...item }] : [];
    });
    for (const projected of presentable) {
      if (projected.entry.seqEnd <= acknowledgedSeq) continue;
      await this.relayTimelineItem(session, turn, projected);
    }

    if (!terminal.terminal) return;
    if (terminal.terminalKind === "failed" || terminal.terminalKind === "canceled") {
      await this.adapter.postRelayEvent({
        version: 2,
        eventId: `${turn.providerTurnId}:${terminal.terminalKind}`,
        kind: terminal.terminalKind,
        bindingId: relay.bindingId,
        agentId: relay.agentId,
        providerTurnId: turn.providerTurnId,
        errorCode: (
          terminal.errorCode ?? `PASEO_TURN_${terminal.terminalKind.toUpperCase()}`
        ).slice(0, 100),
      });
    } else {
      const finalAssistant = presentable.findLast(
        (item) => item.item.type === "assistant_message" && item.item.text.trim(),
      );
      if (!finalAssistant) {
        await this.adapter.postRelayEvent({
          version: 2,
          eventId: `${turn.providerTurnId}:failed`,
          kind: "failed",
          bindingId: relay.bindingId,
          agentId: relay.agentId,
          providerTurnId: turn.providerTurnId,
          errorCode: "PASEO_FINAL_MISSING",
        });
      } else {
        await this.adapter.postRelayEvent({
          version: 2,
          eventId: `${turn.providerTurnId}:completed`,
          kind: "completed",
          bindingId: relay.bindingId,
          agentId: relay.agentId,
          providerTurnId: turn.providerTurnId,
          finalItemKey: finalAssistant.itemKey,
          completedAt: terminal.occurredAt ?? Date.now(),
        });
      }
    }

    if (boundaryReceiptId && dispatchReceipt) {
      await this.store.updateOfficeDispatchReceipt(boundaryReceiptId, {
        status: "terminal",
        providerTurnId: turn.providerTurnId,
      });
    }
    await this.store.updateSession(session.externalThreadId, (binding) => {
      if (binding.officeRelay?.activeTurn?.providerTurnId === turn.providerTurnId) {
        binding.officeRelay.activeTurn = undefined;
      }
      if (
        dispatchReceipt &&
        boundaryReceiptId &&
        binding.activeOfficeTurn?.receiptId === boundaryReceiptId
      ) {
        binding.activeOfficeTurn = undefined;
      }
    });
  }

  private async relayTimelineItem(
    session: ChatBinding,
    turn: TurnSegment,
    projected: { entry: TimelineEntry; itemKey: string; item: PresentationItem },
  ): Promise<void> {
    const relay = session.officeRelay;
    if (!relay) return;
    const occurredAt = Date.parse(projected.entry.timestamp);
    await this.adapter.postRelayEvent({
      version: 2,
      eventId: `${turn.providerTurnId}:timeline:${projected.itemKey}:${projected.entry.seqEnd}`,
      kind: "timeline",
      bindingId: relay.bindingId,
      agentId: relay.agentId,
      providerTurnId: turn.providerTurnId,
      itemKey: projected.itemKey,
      seqStart: projected.entry.seqStart,
      seqEnd: projected.entry.seqEnd,
      occurredAt: Number.isFinite(occurredAt) ? occurredAt : Date.now(),
      itemDigest: stableDigest(projected.item),
      item: projected.item,
    });
    // A stale result is terminal acknowledgement: Office has already closed
    // this provider turn and will never accept the item on retry. Advance the
    // durable cursor so an old canceled/failed turn cannot poison every later
    // message on the same long-lived binding.
    await this.store.updateSession(session.externalThreadId, (binding) => {
      if (!binding.officeRelay) return;
      binding.officeRelay.acknowledgedSeq = Math.max(
        binding.officeRelay.acknowledgedSeq,
        projected.entry.seqEnd,
      );
    });
  }

  private fetchTimeline(agentId: string) {
    return this.client.fetchAgentTimeline(agentId, {
      direction: "tail",
      projection: "projected",
      limit: 0,
    });
  }
}

function partitionTurns(
  agentId: string,
  epoch: string,
  entries: readonly TimelineEntry[],
  state: {
    acknowledgedSeq: number;
    activeTurn?: { providerTurnId: string; startSeq: number };
    hasPendingOfficeTurn: boolean;
  },
): TurnSegment[] {
  const autonomous = resolveAutonomousBoundary(agentId, epoch, entries, state);
  const turns: TurnSegment[] = [];
  let current: TurnSegment | undefined;
  for (const entry of entries) {
    if (entry.item.type === "user_message") {
      current = {
        boundary: {
          kind: "human",
          seqStart: entry.seqStart,
          seqEnd: entry.seqEnd,
          timestamp: entry.timestamp,
          ...(entry.item.messageId ? { messageId: entry.item.messageId } : {}),
        },
        entries: [],
        providerTurnId: providerTurnId(agentId, epoch, entry.seqStart),
      };
      turns.push(current);
      continue;
    }
    if (
      autonomous &&
      entry.seqEnd >= autonomous.startSeq &&
      current?.providerTurnId !== autonomous.providerTurnId
    ) {
      current = {
        boundary: {
          kind: "autonomous",
          seqStart: autonomous.startSeq,
          seqEnd: Math.max(0, autonomous.startSeq - 1),
          timestamp: entry.timestamp,
        },
        entries: [],
        providerTurnId: autonomous.providerTurnId,
      };
      turns.push(current);
    }
    current?.entries.push(entry);
  }
  return turns;
}

function resolveAutonomousBoundary(
  agentId: string,
  epoch: string,
  entries: readonly TimelineEntry[],
  state: {
    acknowledgedSeq: number;
    activeTurn?: { providerTurnId: string; startSeq: number };
    hasPendingOfficeTurn: boolean;
  },
): { startSeq: number; providerTurnId: string } | undefined {
  const activeHumanTurn = state.activeTurn
    ? entries.find(
        (entry) =>
          entry.item.type === "user_message" &&
          providerTurnId(agentId, epoch, entry.seqStart) === state.activeTurn?.providerTurnId,
      )
    : undefined;
  const firstUnacknowledged = entries.find((entry) => entry.seqEnd > state.acknowledgedSeq);
  let autonomousStart: number | undefined;
  if (state.activeTurn && !activeHumanTurn) {
    autonomousStart = state.activeTurn.startSeq;
  } else if (!state.activeTurn && !state.hasPendingOfficeTurn) {
    autonomousStart =
      firstUnacknowledged?.item.type === "user_message" ? undefined : firstUnacknowledged?.seqStart;
  }
  const autonomousProviderTurnId =
    autonomousStart === undefined
      ? undefined
      : (state.activeTurn?.providerTurnId ??
        providerTurnId(agentId, epoch, autonomousStart, "autonomous"));
  return autonomousStart === undefined || !autonomousProviderTurnId
    ? undefined
    : { startSeq: autonomousStart, providerTurnId: autonomousProviderTurnId };
}

function providerTurnId(
  agentId: string,
  epoch: string,
  seqStart: number,
  kind: "human" | "autonomous" = "human",
): string {
  return createHash("sha256")
    .update(
      kind === "human"
        ? `${agentId}\0${epoch}\0${seqStart}`
        : `${agentId}\0${epoch}\0autonomous\0${seqStart}`,
    )
    .digest("base64url");
}

function projectItem(
  entry: TimelineEntry,
  options: { assistantClosed: boolean },
): { itemKey: string; item: PresentationItem } | null {
  const item = entry.item;
  if (item.type === "assistant_message") {
    const text = item.text.slice(0, 80_000).trim();
    if (!options.assistantClosed || !text || text.startsWith("[System Error]")) return null;
    return {
      itemKey: `assistant:${item.messageId ?? entry.seqStart}`,
      item: { type: "assistant_message", text, files: [] },
    };
  }
  if (item.type === "reasoning") {
    // Office should show that the agent is thinking, but the bridge must not
    // export or persist private chain-of-thought text.
    return {
      itemKey: `reasoning:${entry.seqStart}`,
      item: { type: "reasoning" },
    };
  }
  if (item.type !== "tool_call") return null;
  const detail = boundedValue(item.detail, 32_000);
  const input = item.detail.type === "unknown" ? boundedValue(item.detail.input, 32_000) : detail;
  const output = item.detail.type === "unknown" ? boundedValue(item.detail.output, 32_000) : detail;
  return {
    itemKey: `tool:${item.callId}`,
    item: {
      type: "tool_call",
      callId: item.callId,
      name: item.name.slice(0, 200),
      status: item.status,
      input,
      ...(item.status === "completed" ? { output } : {}),
      ...(item.status === "failed"
        ? {
            errorText: boundedString(String(item.error ?? "Tool failed"), 8_000),
          }
        : {}),
    },
  };
}

type PresentationItem =
  | { type: "reasoning" }
  | { type: "assistant_message"; text: string; files: [] }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
      input: unknown;
      output?: unknown;
      errorText?: string;
    };

function boundedValue(value: unknown, maxBytes: number): unknown {
  const sanitized = sanitizeValue(value, 0);
  const text = stableStringify(sanitized);
  return Buffer.byteLength(text, "utf8") <= maxBytes
    ? sanitized
    : { truncated: true, preview: boundedString(text, maxBytes - 64) };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[depth limit]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedString(value, 16_000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /(?:authorization|cookie|credential|password|secret|token)/i.test(key)
          ? "[redacted]"
          : sanitizeValue(item, depth + 1),
      ]),
  );
}

function boundedString(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}…[truncated]`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sanitizeValue(value, 0));
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
