# Chat Bridge v2 — Agent-Initiated Conversations Execution Plan

Source references: [prd.md](prd.md), [docs/chat-bridge.md](../../chat-bridge.md), [v1 execution](../chat-bridge-v1/execution.md)
Date created: 2026-06-29

> This plan assumes v1's `packages/chat` exists with Chat SDK Slack intake, `ThreadSessionStore`,
> `PermissionBridge`, `CHAT_THREAD_LABEL`, file-backed Chat SDK `StateAdapter`, and
> timeline-polled relay.

## Goal

Add production-ready `chat.*` tools so agents can explicitly message people/channels, ask blocking
questions, reply to current/bound conversations, and send generated files/images back to chat.
Agents may use executor MCP to discover channels and threads they can access, but all posting,
file uploads, and binding persistence goes through Paseo's chat bridge and Chat SDK.

Starting a new agent/workspace is **not** a chat tool. The agent uses existing Paseo tools for
that. The bridge keeps the bound chat thread attached to the office agent and does not observe or
route to spawned agents.

## Architecture decision

Use a **daemon-owned tool surface backed by `packages/chat` transport/state**:

```txt
office agent -> daemon Paseo tool handler -> ChatBridge service client -> packages/chat -> Chat SDK
                                           |                         |
                                           |                         v
                                           |                 ChatBinding store
                                           v
                                  agent timeline/audit
```

Why:

- The daemon knows the current caller `agentId`, verifies it is the office agent for the binding,
  and can attach audit/tool timeline context without trusting the model to pass its own agent id.
- `packages/chat` already owns Chat SDK adapters, subscriptions, delivery receipts, external
  thread normalization, and Chat SDK file upload mechanics.
- The office agent gets stable person/channel/conversation primitives, not Slack tokens or adapter clients.
- New agents stay in the existing Paseo lifecycle (`create_agent`, `create_worktree`) behind the
  office agent, so users do not have to juggle extra chat threads just because the office
  agent delegated work.

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
    officeAgentId: string;
    destination: ChatDestination;
    message: string;
    subscribe?: boolean;
    idempotencyKey?: string;
  }): Promise<{ conversationId: string; externalThreadId: string }>;

  reply(input: {
    officeAgentId: string;
    conversationId?: string;
    message: string;
    files?: ChatOutboundFile[];
    idempotencyKey?: string;
  }): Promise<{ conversationId: string; externalThreadId: string }>;

  sendFile(input: {
    officeAgentId: string;
    conversationId?: string;
    destination?: ChatDestination;
    message?: string;
    file: ChatOutboundFile;
    idempotencyKey?: string;
  }): Promise<{ conversationId: string; externalThreadId: string; fileId?: string }>;

  ask(input: {
    officeAgentId: string;
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

interface ChatOutboundFile {
  bytes?: Uint8Array; // preferred for remote bridge mode
  path?: string; // allowed only when bridge and daemon share a filesystem
  filename?: string;
  mimeType?: string;
  size?: number;
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
- [ ] Service supports text-only posts and posts with one or more `ChatOutboundFile` uploads.
- [ ] If the bridge is not running, tool errors are clear: "Chat bridge is not connected.".

## Slice 2 — Evolve `ThreadSessionStore` to `ChatBindingStore`

**Goal**: represent inbound sessions, outbound same-agent conversations, pending asks, and audit
records explicitly.

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
    officeAgentId: z.string(),
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
- `auditRecords`: append-only outbound tool call summaries, including file metadata for uploads.

**Backward compatibility**

Existing v1 `sessions` parse as `kind: "inbound-session"` via a Zod transform/default so current
state files survive upgrade.

**Done when**

- [ ] Existing v1 sessions load as inbound bindings.
- [ ] Outbound bindings persist and reload after process restart.
- [ ] Lookup by caller agent returns zero/one/many current/default bindings deterministically.
- [ ] Binding lookup can find conversations by `rootAgentId` or `officeAgentId`.

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

## Slice 4 — Subscription and reply routing

**Goal**: outbound-created conversations receive future replies and route them to the office agent.
If the office agent starts another Paseo agent/subagent, the same chat thread remains attached to
the office agent instead of creating another external thread or talking to the child.

**Inbound normalization requirement**: all Slack replies routed through this slice must preserve
full URLs from Chat SDK `message.links[*].url`. Do not rely on `message.text` alone because Slack
can render long links as shortened display text. If the exact URL is not already present in the
cleaned text, append it under a compact `Links:` section before building the sender-prefixed prompt.

**Flow: start channel/person conversation**

1. Resolve destination.
2. Post through Chat SDK (`thread.post` / adapter post target).
3. Normalize created external thread id.
4. `thread.subscribe()` if requested/default.
5. Persist `outbound-conversation { officeAgentId, externalThreadId, conversationId, subscribed }`.
6. Return opaque `conversationId` to agent.

**Flow: outbound file/image send**

1. Daemon tool validates the caller is the office agent for the current/default binding or supplied
   `conversationId`.
2. Resolve target thread the same way as `chat.reply`.
3. Resolve file input:
   - local bridge mode: accept `path` if it is readable by the daemon/bridge host;
   - remote bridge mode: daemon reads the path and sends bytes + filename + MIME metadata to the
     bridge service.
4. Enforce configured max file size and basic MIME/extension validation. `chat.sendImage` requires
   `image/*`.
5. Post through Chat SDK, not Slack Web API:
   `thread.post({ markdown: message, files: [{ data, filename }] })`.
6. Store delivery receipt and audit record. On retry after crash, do not duplicate an already
   completed upload for the same idempotency key.
7. Keep the binding unchanged; future replies still route to the same office agent.

**Flow: inbound reply**

1. Chat SDK emits `onSubscribedMessage`.
2. Normalize `externalThreadId`.
3. Look up `ChatBinding`.
4. If pending request exists, resolve pending ask first.
5. Else route:
   - `inbound-session` → `sendAgentMessage(rootAgentId, sender-prefixed text)`
   - `outbound-conversation` → `sendAgentMessage(officeAgentId, sender-prefixed text)`
6. Start timeline-polled relay from the office agent back to the same external thread.

**Flow: agent creates another Paseo agent**

1. Agent uses existing Paseo tools (`create_worktree` + `create_agent`, or `create_agent` in a
   project/workspace) with the proper relationship metadata.
2. The bridge takes no chat action for the spawned agent: no binding update, no child timeline
   polling, no child permission relay, and no handoff card.
3. The office agent remains responsible for supervising the child and summarizing progress back to
   Slack in its own messages.

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

- [ ] Start outbound conversation, restart bridge, reply in Slack, and the office agent receives
      the reply.
- [ ] Office agent starts a new Paseo agent; the same chat thread continues routing replies to the
      office agent and no child handoff/chat target is created.
- [ ] Office agent sends a generated image/file to the current thread and replies still route to
      the office agent afterward.
- [ ] Subscribed thread with no binding is ignored/logged, not routed arbitrarily.

## Slice 5 — URL-preserving inbound prompt normalization

**Goal**: agents always receive full URLs from Slack replies, even when Slack displays a shortened
label in the message text.

**Files**

- `packages/chat/src/intake/slack.ts`
- `packages/chat/src/intake/slack.test.ts`

**Implementation notes**

- Chat SDK exposes parsed links on `Message.links`; for Slack these are extracted from `rich_text`
  link blocks when present, with a fallback to legacy `<url>` / `<url|text>` mrkdwn parsing.
- Extend `normalizeMessage()` to append full URLs from `message.links[*].url` under `Links:` when
  the exact URL is not already included in the cleaned text or attachment text.
- Keep mention cleanup and attachment normalization separate from link preservation: the visible
  user text should remain readable, while the appended links provide lossless machine context.
- Apply the same helper to inbound sessions and outbound-conversation replies so v2 subscribed
  threads do not regress relative to v1.

**Regression tests**

- [ ] `message.text = "facebook.com/p/Aunt-Kara-Mo…"` and
      `message.links = [{ url: "https://www.facebook.com/p/Aunt-Kara-Mo-615.../" }]` produces a
      prompt containing the full URL.
- [ ] If the exact full URL is already present in cleaned text, no duplicate `Links:` entry is
      added.
- [ ] Multiple links are preserved in order and deduped.
- [ ] Attachment fallback URLs and `message.links` URLs can both appear without one suppressing the
      other unless they are exact duplicates.

**Done when**

- [ ] Slack's shortened displayed URL text no longer causes the office agent to receive a truncated
      URL.
- [ ] The behavior is covered by targeted tests for `normalizeMessage()`.

## Slice 6 — Outbound files and images

**Goal**: `chat.sendFile` / `chat.sendImage` let the office agent return generated artifacts to
Slack as real file uploads.

**Files**

- daemon chat tools (exact file TBD near `packages/server/src/server/agent/tools/`)
- `packages/chat/src/service.ts`
- `packages/chat/src/bridge.ts` or a new `packages/chat/src/outbound.ts`
- `packages/chat/src/state/thread-session-store.ts` / `ChatBindingStore`

**Tool schemas**

```ts
chat.sendFile({
  conversationId?: string,
  path: string,
  filename?: string,
  mimeType?: string,
  message?: string,
});

chat.sendImage({
  conversationId?: string,
  path: string,
  filename?: string,
  message?: string,
});
```

Optionally allow `files` on `chat.reply` for multi-file sends once the single-file path is solid.

**Implementation notes**

- Keep uploads explicit. Do not parse assistant text for paths.
- In local mode, the bridge may read `path` directly because it runs beside the daemon today.
- In remote mode, the daemon-side tool reads the file and sends bytes to the bridge service; path
  strings alone are not portable across hosts.
- Use Chat SDK upload support only: `thread.post({ markdown, files: [{ data, filename }] })`.
- Infer MIME from supplied `mimeType`, then extension, then `application/octet-stream`.
- Enforce configurable size limits before reading/uploading large files.
- Return structured tool errors: `no_current_binding`, `file_not_found`, `file_not_readable`,
  `file_too_large`, `unsupported_file`, `upload_failed`, `bridge_unavailable`.
- Audit successful and failed sends with filename, MIME, byte size, destination, office agent id,
  and idempotency key.

**Tests**

- [ ] Service posts a file through a mocked Chat SDK thread with `files` populated.
- [ ] `chat.sendImage` rejects a non-image MIME type.
- [ ] Missing/unreadable file returns a structured tool error.
- [ ] Idempotency suppresses duplicate uploads on retry after a simulated crash.
- [ ] Remote-mode code path sends bytes rather than requiring the bridge to read a daemon-local path.

**Done when**

- [ ] Office agent can generate a PNG/CSV/PDF and send it to the current Slack thread.
- [ ] Uploaded files appear as Slack files, not pasted base64 or path text.
- [ ] Sends are audited and retry-safe.

## Slice 7 — Blocking asks

**Goal**: `chat.askPerson` / `chat.askChannel` let an agent wait for human input safely.

**Tool behavior**

- Posts question to destination.
- Stores `pendingRequest` with `requestId`, `conversationId`, `officeAgentId`, `deadline`.
- Suspends/resolves tool call if daemon tool runtime supports long waits; otherwise returns
  `requestId` and uses a follow-up message to the office agent when answered.
- First qualifying human reply resolves the request with sender identity + answer text.
- Timeout returns `{ status: "timeout", answer: null }`.
- Cancel/teardown returns `{ status: "canceled", answer: null }`.

**Open implementation choice**

If daemon tools cannot hold a long-running promise robustly across restart, implement asks as
permission-like agent interrupts:

1. tool posts question and returns `pending` + request id;
2. bridge sends answer back to the office agent as a normal `sendAgentMessage` when received;
3. agent prompt/tool docs instruct it to wait for that answer before proceeding.

Prefer true blocking if the tool runtime can support it cleanly.

**Done when**

- [ ] Ask resolves with answer.
- [ ] Ask times out after deadline.
- [ ] Ask survives bridge restart.

## Slice 8 — Policy, auditing, and UX errors

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
  officeAgentId: string;
  toolName: string;
  destination: ChatDestination;
  resolvedExternalThreadId?: string;
  conversationId?: string;
  messagePreview: string;
  files?: Array<{ filename: string; mimeType: string; size: number }>;
  result: "posted" | "uploaded" | "blocked" | "failed" | "timeout" | "canceled";
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
- `file_not_found` / `file_not_readable`: the requested upload path cannot be read.
- `file_too_large`: file exceeds configured upload limit.
- `unsupported_file`: `chat.sendImage` got a non-image or blocked MIME type.
- `upload_failed`: Chat SDK/adapter rejected the upload.

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
  posts a new thread, and replies route back to the office agent.
- Agent generates `/home/olumbe/code/office/artifacts/chart.png`, calls `chat.sendImage`, and Slack
  receives an uploaded image file in the current thread.
- Agent generates a CSV/PDF, calls `chat.sendFile`, and Slack receives an uploaded file in the
  selected conversation.
- Office agent asks Vivek a question; Vivek replies; tool resumes or the office agent receives the
  answer with sender identity.
- Bridge restarts between ask and reply; answer still routes correctly.
- `chat.reply({ message })` uses current binding; ambiguous/no binding errors are clear.
- A Slack reply whose displayed text contains a shortened URL still reaches the office agent with
  the full URL from Chat SDK `message.links`.
- Office agent starts another Paseo agent/workspace; the same chat thread stays attached to the
  office agent instead of creating a second chat thread or routing to the child.
- Channel posting is not statically allowlist-gated by default.
- No raw Slack posting API exists outside Chat SDK.
