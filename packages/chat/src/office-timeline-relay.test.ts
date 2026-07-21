import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OfficeV2RelayEvent } from "./office-adapter.js";
import { OfficeTimelineRelay } from "./office-timeline-relay.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";

function entry(seq: number, item: Record<string, unknown>) {
  return {
    timestamp: `2026-07-20T12:00:${String(seq).padStart(2, "0")}.000Z`,
    provider: "pi",
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
    item,
  };
}

describe("OfficeTimelineRelay", () => {
  it("replays complete parent turns and creates autonomous turn boundaries", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "office-relay-test-"));
    const store = new ThreadSessionStore(stateDir);
    await store.upsertSession({
      kind: "inbound-session",
      externalThreadId: "office:binding-1",
      rootAgentId: "agent-1",
      muted: false,
      activeRelayId: null,
      title: "Relay test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.registerOfficeRelay({
      externalThreadId: "office:binding-1",
      bindingId: "binding-1",
      agentId: "agent-1",
      callbackUrl: "https://convex.example/api/paseo/events",
      acknowledgedSeq: 0,
    });
    await store.reserveOfficeDispatch({
      receiptId: "receipt-1",
      runId: "run-1",
      payloadDigest: "a".repeat(64),
    });
    await store.updateSession("office:binding-1", (session) => {
      session.activeOfficeTurn = {
        version: 2,
        kind: "message",
        bindingId: "binding-1",
        runId: "run-1",
        receiptId: "receipt-1",
        payloadDigest: "a".repeat(64),
        agentId: "agent-1",
        actor: { externalUserId: "member-1", displayName: "Vivek" },
        message: { markdown: "Ship it", files: [] },
        callbackUrl: "https://convex.example/api/paseo/events",
      };
    });

    let entries = [
      entry(1, { type: "user_message", text: "Ship it" }),
      entry(2, { type: "assistant_message", text: "I’ll inspect the repo.", messageId: "a-1" }),
      entry(3, { type: "reasoning", text: "private reasoning must not leave Paseo" }),
      entry(4, {
        type: "tool_call",
        callId: "tool-1",
        name: "shell",
        status: "completed",
        detail: { command: "git status", authorization: "secret" },
        error: null,
      }),
      entry(5, {
        type: "tool_call",
        callId: "executor-1",
        name: "executor_execute",
        status: "completed",
        detail: {
          type: "unknown",
          input: { code: "return tools.posthog_api.projects();" },
          output: {
            content: [{ type: "text", text: "2 projects" }],
            structuredContent: { status: "completed", result: [{ id: "1" }] },
          },
        },
        error: null,
      }),
      entry(6, { type: "assistant_message", text: "The change is complete.", messageId: "a-2" }),
    ];
    const events: OfficeV2RelayEvent[] = [];
    const relay = new OfficeTimelineRelay(
      {
        fetchAgentTimeline: async () => ({
          entries,
          epoch: "epoch-1",
          agent: { status: "idle" },
        }),
      } as never,
      store,
      { postRelayEvent: async (event) => void events.push(event) },
    );

    await relay.wake("agent-1", { kind: "completed", occurredAt: 1234 });
    expect(events.map((event) => event.kind)).toEqual([
      "accepted",
      "timeline",
      "timeline",
      "timeline",
      "timeline",
      "timeline",
      "completed",
    ]);
    expect(events[2]).toMatchObject({
      kind: "timeline",
      occurredAt: Date.parse("2026-07-20T12:00:03.000Z"),
      item: { type: "reasoning" },
    });
    expect(JSON.stringify(events)).not.toContain("private reasoning must not leave Paseo");
    expect(events[3]).toMatchObject({
      kind: "timeline",
      occurredAt: Date.parse("2026-07-20T12:00:04.000Z"),
      item: {
        type: "tool_call",
        input: { command: "git status", authorization: "[redacted]" },
      },
    });
    expect(events[4]).toMatchObject({
      kind: "timeline",
      item: {
        type: "tool_call",
        name: "executor_execute",
        input: { code: "return tools.posthog_api.projects();" },
        output: {
          content: [{ type: "text", text: "2 projects" }],
          structuredContent: { status: "completed", result: [{ id: "1" }] },
        },
      },
    });
    const firstProviderTurnId = events[0]!.providerTurnId;
    expect(events.every((event) => event.providerTurnId === firstProviderTurnId)).toBe(true);

    await relay.wake("agent-1", { kind: "completed" });
    expect(events).toHaveLength(7);

    entries = [
      ...entries,
      entry(7, { type: "user_message", text: "Run the tests" }),
      entry(8, { type: "assistant_message", text: "Tests pass.", messageId: "a-3" }),
    ];
    await relay.wake("agent-1", { kind: "completed", occurredAt: 5678 });
    expect(events.slice(7).map((event) => event.kind)).toEqual([
      "turnStarted",
      "timeline",
      "completed",
    ]);
    expect(events[7]!.providerTurnId).not.toBe(firstProviderTurnId);
    const stored = await store.getSession("office:binding-1");
    expect(stored?.officeRelay).toMatchObject({ acknowledgedSeq: 8, epoch: "epoch-1" });
    expect(stored?.officeRelay?.activeTurn).toBeUndefined();
  });

  it("creates a new continuation turn when a subagent notification resumes the parent", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "office-relay-subagent-test-"));
    const store = new ThreadSessionStore(stateDir);
    await store.upsertSession({
      kind: "inbound-session",
      externalThreadId: "office:binding-1",
      rootAgentId: "agent-1",
      muted: false,
      activeRelayId: null,
      title: "Subagent relay test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.registerOfficeRelay({
      externalThreadId: "office:binding-1",
      bindingId: "binding-1",
      agentId: "agent-1",
      callbackUrl: "https://convex.example/api/paseo/events",
      acknowledgedSeq: 0,
    });

    let entries = [
      entry(1, { type: "user_message", text: "Review the PR", messageId: "receipt-1" }),
      entry(2, { type: "assistant_message", text: "I delegated the review.", messageId: "a-1" }),
    ];
    const events: OfficeV2RelayEvent[] = [];
    const relay = new OfficeTimelineRelay(
      {
        fetchAgentTimeline: async () => ({
          entries,
          epoch: "epoch-1",
          agent: { status: "idle" },
        }),
      } as never,
      store,
      { postRelayEvent: async (event) => void events.push(event) },
    );

    await relay.wake("agent-1", { kind: "completed" });
    const originalProviderTurnId = events[0]!.providerTurnId;
    expect(events.map((event) => event.kind)).toEqual(["turnStarted", "timeline", "completed"]);

    entries = [
      ...entries,
      entry(3, { type: "reasoning", text: "private subagent notification reasoning" }),
      entry(4, {
        type: "assistant_message",
        text: "The independent review is complete.",
        messageId: "a-2",
      }),
    ];
    await relay.wake("agent-1", { kind: "completed" });

    expect(events.slice(3).map((event) => event.kind)).toEqual([
      "turnStarted",
      "timeline",
      "timeline",
      "completed",
    ]);
    expect(events[3]!.providerTurnId).not.toBe(originalProviderTurnId);
    expect(
      events.slice(3).every((event) => event.providerTurnId === events[3]!.providerTurnId),
    ).toBe(true);
    expect(events[5]).toMatchObject({
      kind: "timeline",
      seqStart: 4,
      item: { type: "assistant_message", text: "The independent review is complete." },
    });
    const stored = await store.getSession("office:binding-1");
    expect(stored?.officeRelay).toMatchObject({ acknowledgedSeq: 4, epoch: "epoch-1" });
    expect(stored?.officeRelay?.activeTurn).toBeUndefined();
  });

  it("drains stale terminal timeline events so a later Office turn can relay", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "office-relay-stale-test-"));
    const store = new ThreadSessionStore(stateDir);
    await store.upsertSession({
      kind: "inbound-session",
      externalThreadId: "office:binding-1",
      rootAgentId: "agent-1",
      muted: false,
      activeRelayId: null,
      title: "Stale relay test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.registerOfficeRelay({
      externalThreadId: "office:binding-1",
      bindingId: "binding-1",
      agentId: "agent-1",
      callbackUrl: "https://convex.example/api/paseo/events",
      acknowledgedSeq: 0,
    });
    let entries = [
      entry(1, { type: "user_message", text: "Hello" }),
      entry(2, { type: "assistant_message", text: "Hi", messageId: "a-1" }),
    ];
    const events: OfficeV2RelayEvent[] = [];
    let staleProviderTurnId: string | undefined;
    const relay = new OfficeTimelineRelay(
      {
        fetchAgentTimeline: async () => ({
          entries,
          epoch: "epoch-1",
          agent: { status: "idle" },
        }),
      } as never,
      store,
      {
        postRelayEvent: async (event) => {
          events.push(event);
          staleProviderTurnId ??= event.providerTurnId;
          return {
            outcome: event.providerTurnId === staleProviderTurnId ? "stale" : "applied",
          };
        },
      },
    );

    await relay.wake("agent-1", { kind: "completed" });
    let stored = await store.getSession("office:binding-1");
    expect(stored?.officeRelay).toMatchObject({ acknowledgedSeq: 2 });
    expect(stored?.officeRelay?.activeTurn).toBeUndefined();

    entries = [
      ...entries,
      entry(3, { type: "user_message", text: "Try again" }),
      entry(4, { type: "assistant_message", text: "Recovered", messageId: "a-2" }),
    ];
    await relay.wake("agent-1", { kind: "completed" });

    const recovered = events.filter((event) => event.providerTurnId !== staleProviderTurnId);
    expect(recovered.map((event) => event.kind)).toEqual(["turnStarted", "timeline", "completed"]);
    expect(recovered[1]).toMatchObject({
      kind: "timeline",
      seqStart: 4,
      item: { type: "assistant_message", text: "Recovered" },
    });
    stored = await store.getSession("office:binding-1");
    expect(stored?.officeRelay).toMatchObject({ acknowledgedSeq: 4 });
    expect(stored?.officeRelay?.activeTurn).toBeUndefined();
  });

  it("continues from the pending Office message when the parent timeline epoch changes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "office-relay-epoch-test-"));
    const store = new ThreadSessionStore(stateDir);
    await store.upsertSession({
      kind: "inbound-session",
      externalThreadId: "office:binding-1",
      rootAgentId: "agent-1",
      muted: false,
      activeRelayId: null,
      title: "Epoch relay test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.registerOfficeRelay({
      externalThreadId: "office:binding-1",
      bindingId: "binding-1",
      agentId: "agent-1",
      callbackUrl: "https://convex.example/api/paseo/events",
      acknowledgedSeq: 2,
    });
    await store.reserveOfficeDispatch({
      receiptId: "receipt-2",
      runId: "run-2",
      payloadDigest: "b".repeat(64),
    });
    await store.updateSession("office:binding-1", (session) => {
      session.activeOfficeTurn = {
        version: 2,
        kind: "message",
        bindingId: "binding-1",
        runId: "run-2",
        receiptId: "receipt-2",
        payloadDigest: "b".repeat(64),
        agentId: "agent-1",
        actor: { externalUserId: "member-1", displayName: "Vivek" },
        message: { markdown: "Interrupt with this", files: [] },
        callbackUrl: "https://convex.example/api/paseo/events",
      };
      if (session.officeRelay) session.officeRelay.epoch = "epoch-old";
    });

    const events: OfficeV2RelayEvent[] = [];
    const relay = new OfficeTimelineRelay(
      {
        fetchAgentTimeline: async () => ({
          entries: [
            entry(1, { type: "user_message", text: "Old request", messageId: "receipt-1" }),
            entry(2, { type: "assistant_message", text: "Old response", messageId: "a-1" }),
            entry(3, {
              type: "user_message",
              text: "Interrupt with this",
              messageId: "receipt-2",
            }),
            entry(4, { type: "assistant_message", text: "Replacement done", messageId: "a-2" }),
          ],
          epoch: "epoch-new",
          agent: { status: "idle" },
        }),
      } as never,
      store,
      { postRelayEvent: async (event) => void events.push(event) },
    );

    await relay.wake("agent-1", { kind: "completed" });

    expect(events.map((event) => event.kind)).toEqual(["accepted", "timeline", "completed"]);
    expect(events[1]).toMatchObject({
      kind: "timeline",
      seqStart: 4,
      item: { type: "assistant_message", text: "Replacement done" },
    });
    const stored = await store.getSession("office:binding-1");
    expect(stored?.officeRelay).toMatchObject({ acknowledgedSeq: 4, epoch: "epoch-new" });
    expect(stored?.officeRelay?.activeTurn).toBeUndefined();
    expect(stored?.activeOfficeTurn).toBeUndefined();
  });
});
