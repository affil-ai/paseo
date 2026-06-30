# Chat Bridge v2 — Agent-Initiated Conversations Execution Plan

Source references: [prd.md](prd.md), [docs/chat-bridge.md](../../chat-bridge.md), [v1 execution](../chat-bridge-v1/execution.md)
Date created: 2026-06-29

> This plan assumes v1's `packages/chat` exists with Chat SDK Slack intake, `ThreadSessionStore`,
> `FocusRelay`, `PermissionBridge`, `CHAT_THREAD_LABEL`, file-backed Chat SDK `StateAdapter`, and
> timeline-polled relay.

## Goal

Add production-ready `chat.*` tools so agents can explicitly message people/channels, ask blocking
questions, and reply to current/bound conversations. Agents may use executor MCP to discover
channels and threads they can access, but all posting and binding persistence goes through Paseo's
chat bridge and Chat SDK.

Starting a new agent/workspace is **not** a chat tool. The agent uses existing Paseo tools for
that. The bridge observes the agent relationship and shifts focus in the same bound chat thread.

## Architecture decision

Use a **daemon-owned tool surface backed by `packages/chat` transport/state**:

```txt
agent -> daemon Paseo tool handler -> ChatBridge service client -> packages/chat -> Chat SDK
                                           |                         |
                                           |                         v
                                           |                 ChatBinding store
                                           v
                                  agent timeline/audit
```

Why:

- The daemon knows the current caller `agentId` and can attach audit/tool timeline context without
  trusting the model to pass its own agent id.
- `packages/chat` already owns Chat SDK adapters, subscriptions, delivery receipts, and external
  thread normalization.
- Agents get stable person/channel/conversation primitives, not Slack tokens or adapter clients.
- New agents stay in the existing Paseo lifecycle (`create_agent`, `create_worktree`, focus relay),
  so users do not have to juggle extra chat threads just because the office agent delegated work.

## Slice 1 — Chat service API between daemon tools and `packages/chat`

**Goal**: daemon tools can ask the running chat bridge to post/subscribe/bind without linking to
Slack adapter internals.

**Files / modules**

- `packages/chat/src/service.ts` (new): typed service methods.
- `packages/chat/src/index.ts`: start service endpoint/registration.
- daemon tool package (exact file TBD; likely near `packages/server/src/server/agent/tools/`).

**Service methods**

```ts
interface ChatBridgeService {
  startConversation(input: {
    callerAgentId: string;
    destination: ChatDestination;
    message: string;
    subscribe?: boolean;
    idempotencyKey?: string;
  }): Promise<{ conversationId: string; externalThreadId: string }>;

  reply(input: {
    callerAgentId: string;
    conversationId?: string;
    message: string;
    idempotencyKey?: string;
  }): Promise<{ conversationId: string; externalThreadId: string }>;

  ask(input: {
    callerAgentId: string;
    destination: ChatDestination;
    question: string;
    timeoutMinutes: number;
    scope: "person" | "channel";
    idempotencyKey?: string;
  }): Promise<{
    conversationId: string;
    requestId: string;
    answer: string | null;
    status: "answered" | "timeout" | "canceled";
  }>;
}
```

**Transport between daemon and chat bridge**

Pick the smallest reliable local-only seam:

1. Preferred: bridge registers a local service with daemon over an internal WebSocket/RPC channel
   using existing client connection patterns.
2. Acceptable first implementation: bridge exposes a loopback-only HTTP/Unix-socket service under
   `$PASEO_HOME/chat-bridge/service.sock` or `127.0.0.1` with daemon auth. This is not a public
   product REST API.

**Done when**

- [ ] Daemon can call `packages/chat` service methods in-process/local-only.
- [ ] If the bridge is not running, tool errors are clear: "Chat bridge is not connected.".

## Slice 2 — Evolve `ThreadSessionStore` to `ChatBindingStore`

**Goal**: represent inbound sessions, outbound same-agent conversations, pending asks, focus, and
audit records explicitly.

**Files**

- `packages/chat/src/state/thread-session-store.ts` (evolve or rename later)
- `packages/chat/src/state/json-state.ts`

**Schema sketch**

```ts
const ChatBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inbound-session"),
    externalThreadId: z.string(),
    rootAgentId: z.string(),
    focusedAgentId: z.string(),
    activeChildAgentId: z.string().nullable().default(null),
    activeRelayId: z.string().nullable().default(null),
    muted: z.boolean().default(false),
    title: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    kind: z.literal("outbound-conversation"),
    conversationId: z.string(),
    externalThreadId: z.string(),
    ownerAgentId: z.string(),
    focusedAgentId: z.string(), // defaults to ownerAgentId
    destination: ChatDestinationSchema,
    subscribed: z.boolean().default(true),
    pendingRequestId: z.string().optional(),
    activeRelayId: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
]);
```

**Additional collections**

- `bindingsByExternalThreadId`
- `bindingsByConversationId`
- `pendingRequests`: request id → agent id, conversation id, deadline, status.
- `deliveryReceipts`: idempotency/delivery keys → started/completed.
- `auditRecords`: append-only outbound tool call summaries.

**Backward compatibility**

Existing v1 `sessions` parse as `kind: "inbound-session"` via a Zod transform/default so current
state files survive upgrade.

**Done when**

- [ ] Existing v1 sessions load as inbound bindings.
- [ ] Outbound bindings persist and reload after process restart.
- [ ] Lookup by caller agent returns zero/one/many current/default bindings deterministically.
- [ ] Focus lookup can find bindings by `rootAgentId`, `ownerAgentId`, or `focusedAgentId`.

## Slice 3 — Destination resolution

**Goal**: resolve people aliases, executor-discovered channel refs, Slack URLs/permalinks, and
current/default bindings into Chat SDK post targets.

**Files**

- `packages/chat/src/destinations.ts` (new)
- `packages/chat/src/people.ts` (new)
- `packages/chat/src/config.ts`
- `packages/chat/README.md`

**Resolution inputs**

```ts
type ChatDestination =
  | { kind: "current" }
  | { kind: "person"; key: string }
  | { kind: "channel"; id?: string; name?: string; url?: string }
  | { kind: "conversation"; conversationId: string };
```

**Rules**

- `current`: find caller agent's default binding. If none or multiple, return an actionable error.
- `conversation`: lookup by opaque `conversationId`, verify caller owns or is allowed.
- `person`: resolve via configured people map first; optionally cross-check office memory later.
- `channel`: accept executor-discovered channel ID, channel name, or Slack permalink. Validate by
  asking Chat SDK adapter to post/resolve when possible. Do **not** require static allowlist.

**Executor MCP interaction**

The executor MCP is used for **discovery**, not posting:

1. Agent calls executor Slack tools to list/search channels, inspect channel context, or get a
   permalink.
2. Agent passes `{ kind: "channel", id/name/url }` to `chat.startConversation`.
3. Chat bridge validates bot/workspace access and posts through Chat SDK.

If executor can see a channel but the Chat SDK bot cannot post, the tool returns a clear error
(`bot_not_in_channel`, `not_allowed`, `unknown_channel`) with remediation.

**Done when**

- [ ] Channel ID from executor discovery can be posted to without config allowlist.
- [ ] Channel name ambiguity returns choices instead of guessing.
- [ ] Slack permalink resolves to an existing thread or channel destination.

## Slice 4 — Subscription, reply routing, and focus

**Goal**: outbound-created conversations receive future replies and route them to the owning or
focused agent. If the owning agent starts another Paseo agent/subagent, the same chat thread can
follow focus instead of creating another external thread.

**Flow: start channel/person conversation**

1. Resolve destination.
2. Post through Chat SDK (`thread.post` / adapter post target).
3. Normalize created external thread id.
4. `thread.subscribe()` if requested/default.
5. Persist `outbound-conversation { ownerAgentId, focusedAgentId: ownerAgentId, externalThreadId,
conversationId, subscribed }`.
6. Return opaque `conversationId` to agent.

**Flow: inbound reply**

1. Chat SDK emits `onSubscribedMessage`.
2. Normalize `externalThreadId`.
3. Look up `ChatBinding`.
4. If pending request exists, resolve pending ask first.
5. Else route:
   - `inbound-session` → `sendAgentMessage(focusedAgentId, sender-prefixed text)`
   - `outbound-conversation` → `sendAgentMessage(focusedAgentId, sender-prefixed text)`
6. Start timeline-polled relay back to the same external thread.

**Flow: agent creates another Paseo agent**

1. Agent uses existing Paseo tools (`create_worktree` + `create_agent`, or `create_agent` in a
   project/workspace) with the proper relationship metadata.
2. Bridge observes `agent_update` / labels (`paseo.parent-agent-id`) as v1 focus relay already does.
3. If the parent/owner agent has a bound chat thread and no other child is currently focused, update
   that binding's `focusedAgentId` to the new agent.
4. Post a Chat SDK transition card in the same thread: "🔧 Focus moved to <agent title>" with a
   **Back to office agent** button. The button uses a bridge-owned action id and immediately sets
   `focusedAgentId` back to the owner/root agent; it does not ask the focused child.
5. Replies in the same chat thread route to the new focused agent.
6. On completion, `@cto ↑`, or the **Back to office agent** button, focus returns to the original
   owner/root agent.

**Restart recovery**

On bridge boot:

- Load Chat SDK subscription state.
- Load chat bindings.
- For each active binding with `subscribed: true`, ensure Chat SDK subscription exists if the API
  supports re-subscribe-by-id; otherwise rely on persisted subscription store and validate on first
  reply.
- Load pending asks. Mark expired requests `timeout`; keep unexpired requests active.
- Delivery receipts suppress duplicate posts after crash/retry.

**Done when**

- [ ] Start outbound conversation, restart bridge, reply in Slack, and the focused agent receives
      the reply.
- [ ] Owner agent starts a new Paseo agent; the same chat thread routes replies to the new focused
      agent and the transition card includes a working **Back to office agent** button.
- [ ] Subscribed thread with no binding is ignored/logged, not routed arbitrarily.

## Slice 5 — Blocking asks

**Goal**: `chat.askPerson` / `chat.askChannel` let an agent wait for human input safely.

**Tool behavior**

- Posts question to destination.
- Stores `pendingRequest` with `requestId`, `conversationId`, `callerAgentId`, `deadline`.
- Suspends/resolves tool call if daemon tool runtime supports long waits; otherwise returns
  `requestId` and uses a follow-up message to the owning agent when answered.
- First qualifying human reply resolves the request with sender identity + answer text.
- Timeout returns `{ status: "timeout", answer: null }`.
- Cancel/teardown returns `{ status: "canceled", answer: null }`.

**Open implementation choice**

If daemon tools cannot hold a long-running promise robustly across restart, implement asks as
permission-like agent interrupts:

1. tool posts question and returns `pending` + request id;
2. bridge sends answer back to owning agent as a normal `sendAgentMessage` when received;
3. agent prompt/tool docs instruct it to wait for that answer before proceeding.

Prefer true blocking if the tool runtime can support it cleanly.

**Done when**

- [ ] Ask resolves with answer.
- [ ] Ask times out after deadline.
- [ ] Ask survives bridge restart.

## Slice 6 — Policy, auditing, and UX errors

**Goal**: production safety without hard-locking channels to a static allowlist.

**Policy defaults**

- Allow channel destinations discovered by executor MCP if the Chat SDK bot can post there.
- Optional denylist for sensitive channels.
- Optional confirmation for broad destinations (large public channel, `@channel`/`@here`, external
  shared channel, or message above configurable length).
- Optional people/channel allowlist for locked-down deployments, disabled by default.

**Audit record**

```ts
type ChatAuditRecord = {
  id: string;
  timestamp: string;
  callerAgentId: string;
  toolName: string;
  destination: ChatDestination;
  resolvedExternalThreadId?: string;
  conversationId?: string;
  messagePreview: string;
  result: "posted" | "blocked" | "failed" | "timeout" | "canceled";
  errorCode?: string;
};
```

**User-facing errors**

- `no_current_binding`: call `startConversation` or pass `conversationId`.
- `ambiguous_current_binding`: pass one of the returned `conversationId`s.
- `ambiguous_channel_name`: choose from candidates.
- `bot_not_in_channel`: invite the bot or choose another destination.
- `policy_blocked`: destination blocked by configured policy.
- `bridge_unavailable`: chat bridge not connected.

**Done when**

- [ ] Every outbound tool call writes an audit record.
- [ ] Common destination failures are actionable.

## Verification

Use targeted checks only:

- `npm run build:chat`
- `npm run typecheck`
- `npm run lint -- packages/chat/src/<changed>.ts packages/server/src/server/agent/tools/<changed>.ts`
- `npm run format:files -- <changed files>`
- Targeted vitest files only (`npx vitest run <file> --bail=1`), never broad suites.
- Manual Slack test with a non-main/ad-hoc daemon; never restart the main daemon on 6767.

## Acceptance tests

- Agent discovers `#growth` via executor MCP, passes channel id to `chat.startConversation`, bridge
  posts a new thread, and replies route back to the focused agent.
- Agent asks Vivek a question; Vivek replies; tool resumes or agent receives answer with sender
  identity.
- Bridge restarts between ask and reply; answer still routes correctly.
- `chat.reply({ message })` uses current binding; ambiguous/no binding errors are clear.
- Owner agent starts another Paseo agent/workspace; the same chat thread follows focus to that new
  agent instead of creating a second chat thread, and the transition card includes **Back to office
  agent**.
- Channel posting is not statically allowlist-gated by default.
- No raw Slack posting API exists outside Chat SDK.
