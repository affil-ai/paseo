# Chat Bridge v1 — Execution Plan

Source references: [prd.md](prd.md), [research.md](research.md), [docs/chat-bridge.md](../../chat-bridge.md)
Date created: 2026-06-27

> Branch note: chat bridge work is in this worktree on `cto/generalized-chat-bridge`. PR #5 in
> `affil-ai/paseo` is currently `feature/cloudflare-access-user-email` (Cloudflare Access email),
> not the chat bridge PR.

> [!IMPORTANT]
> This is a working execution plan. As implementation progresses:
>
> 1. Mark checklist items with `[x]` only after code is changed and verified.
> 2. Update **Implementation Notes** with deviations, decisions, and surprises.
> 3. Update **Implementation Footprint** with files created or modified.
> 4. Leave blocked or unverified work unchecked with a short note.

## Goal

Ship `@getpaseo/chat`: a standalone Node process that bridges Slack (via Chat SDK, Socket Mode)
to the local Paseo daemon, so a `@cto` mention starts an office agent whose final answer is posted
back into the thread, with permissions, mute, and restart-safe state — no database and no public
product HTTP surface.

## Locked decisions

- New package `packages/chat` (`@getpaseo/chat`), private, ESM, NodeNext, vitest, oxlint/oxfmt.
- Low-level `DaemonClient` from `@getpaseo/client/internal/daemon-client`; connect to
  `127.0.0.1:6767` (mirror `packages/cli/src/utils/client.ts`).
- Office agent: `directory` workspace at the configured `officeRepoPath` (the office repo);
  provider `pi`, model `openrouter/anthropic/claude-fable-5`, thinking `high` (all from config).
- Chat SDK is the only Slack client; bot built with `concurrency: "queue"`.
- File-backed state under `$PASEO_HOME/chat-bridge/`; copy `writeJsonFileAtomic` locally.
- `ThreadSession { rootAgentId, muted, activeRelayId }` keyed by `externalThreadId`.
- Office-agent-only chat boundary: the bridge never routes replies to child agents, never polls
  child timelines, and never tracks active child work.
- Stamp `paseo.chat-thread-id` on the office agent.

## Out of scope

- Agent-initiated chat tools (`chat.startConversation`, `chat.askPerson`, `chat.askChannel`,
  `chat.reply`) — v2.
- GitHub/Resend webhooks, remote/relay mode, multi-repo routing, outbound files, public REST API.
  Inbound Slack images/files are v1 and are relayed to the office agent. (All other items v2+ or
  dropped.) Minimal Slack webhook mode may exist only to support Chat SDK's own inbound
  adapter; it is not the v2 public webhook feature set.
- The office brain capture/lint implementation (this plan only calls the teardown hook).

## Implementation slices

### Slice 1 — Package scaffold + daemon connection

**Goal**: `npm run build` produces `@getpaseo/chat`; the process connects to the daemon and logs
`server_info`.

**Files**

- `packages/chat/package.json`
- `packages/chat/tsconfig.json`
- `packages/chat/src/index.ts`
- `packages/chat/src/config.ts`
- `packages/chat/src/paseo-client.ts`
- root `package.json` (add `build:chat` after `build:client`)

**Change map**

| File                 | Change                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` (pkg) | name `@getpaseo/chat`, private, type module, deps: `chat`, `@chat-adapter/slack`, `@getpaseo/client`, `@getpaseo/protocol`, `ws`, `zod`                                                                                                                         |
| `tsconfig.json`      | extend `../../tsconfig.base.json`, NodeNext                                                                                                                                                                                                                     |
| `config.ts`          | Zod-parsed env: `officeRepoPath`, `provider` (default `pi`), `model` (default `openrouter/anthropic/claude-fable-5`), `modeId` (default empty), `thinkingOptionId` (default `high`), `ackEmoji`, `officePromptPath`, `deepLinkBaseUrl`, daemon host, `stateDir` |
| `paseo-client.ts`    | `connect()` mirroring `cli/src/utils/client.ts` (DaemonClient over `ws://127.0.0.1:6767`, reconnect enabled)                                                                                                                                                    |
| `index.ts`           | boot: load config → connect daemon → (Slice 5) construct Chat + adapters → register handlers                                                                                                                                                                    |

**Tests**

- [ ] `config.ts` parses env with defaults; missing `officeRepoPath` errors.

**Done when**

- [x] `npm run build:chat` succeeds; running the process logs daemon `server_info`.

### Slice 2 — File-backed state stores

**Goal**: durable, atomic, restart-safe state for thread links, dedup, and Chat SDK.

**Files**

- `packages/chat/src/state/json-state.ts`
- `packages/chat/src/state/thread-session-store.ts`
- `packages/chat/src/state/chat-state-adapter.ts`

**Change map**

| File                      | Change                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json-state.ts`           | local copy of `writeJsonFileAtomic` + an in-memory write queue (mirror `loop-service.ts`)                                                                                                               |
| `thread-session-store.ts` | Zod `ThreadSession` collection keyed `externalThreadId` with `activeRelayId`; inbound event-receipt set; outbound delivery-receipt set; (later) artifact links                                          |
| `chat-state-adapter.ts`   | implement Chat SDK `StateAdapter`: persisted `subscribe/unsubscribe/isSubscribed` set; JSON KV `get/set/delete` with `expiresAt`; in-process keyed async mutex for `acquireLock/releaseLock/extendLock` |

**Sketch**

```ts
type ThreadSession = {
  externalThreadId: string;
  rootAgentId: string;
  muted?: boolean;
  activeRelayId: string | null;
  createdAt: string;
};
```

**Tests**

- [ ] Round-trip a `ThreadSession`; reload from disk returns identical data.
- [ ] Delivery-receipt: marking `completed` makes a second post a no-op.
- [ ] `StateAdapter` lock is exclusive per thread id within the process.

**Done when**

- [x] State survives a process restart (write, restart, read back).

### Slice 3 — Timeline-polled output relay (office agent only)

**Goal**: one office-agent turn is observed by polling the projected daemon timeline. Slack receives the first complete assistant text block and the final assistant text block only. Do not show intermediate assistant/tool output or native Slack streaming in v1.

**Files**

- `packages/chat/src/bridge.ts`
- `packages/chat/src/render.ts`

**Change map**

| File        | Change                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.ts` | capture timeline sequence before prompting; poll projected timeline for `assistant_message` rows; post first complete assistant text block; on terminal status post final assistant text block; skip duplicate first/final text |
| `render.ts` | Slack markdown fix-ups for projected assistant text (flatten tables, backtick `@scope/pkg`)                                                                                                                                     |

**Tests**

- [ ] First complete assistant text block posts once.
- [ ] Final assistant text block posts once after agent terminal status.
- [ ] If first and final text match, only one reply is posted.

**Done when**

- [ ] A real office-agent turn posts first + final assistant replies in the Slack thread, with no intermediate/native-streaming message. _Code path implemented; pending Slack manual test._

### Slice 4 — Permissions + questions

**Goal**: permission requests become Slack buttons; agent questions become numbered cards; both
resolve against the office agent.

**Files**

- `packages/chat/src/permissions.ts`

**Change map**

| File             | Change                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions.ts` | subscribe `agent_permission_request`; for kind `tool` render `actions[]` as standalone Block Kit buttons/cards; for kind `question` render a numbered card; on click/reply call `respondToPermission(rootAgentId, request.id, { behavior, selectedActionId })` |

**Tests**

- [ ] A tool permission request posts buttons; clicking resolves with the matching action.
- [ ] A question reply normalizes (`<@…>` stripped) and submits; supports single-answer-for-all.

**Done when**

- [ ] An office-agent permission prompt is answerable from Slack and the agent continues. _Code path implemented; pending Slack manual test._

### Slice 5 — Slack intake + new-thread / reply flow

**Goal**: mentions/DMs start an office agent; subscribed replies continue it; sender identity is
attached.

**Files**

- `packages/chat/src/bridge.ts`
- `packages/chat/src/intake/slack.ts`
- `packages/chat/src/index.ts` (wire Chat + Slack adapter, register handlers)

**Change map**

| File              | Change                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | construct `Chat` with the file-backed `StateAdapter` + `@chat-adapter/slack`, `concurrency: "queue"`; register `onNewMention`/`onDirectMessage`/`onSubscribedMessage` → `bridge.handleMessage`                                                                                                                                                                                     |
| `bridge.ts`       | `handleMessage`: dedup on `eventId`; `thread.subscribe()`; new-thread vs follow-up; resolve sender identity; create workspace+agent or `sendAgentMessage`; persist `ThreadSession`; `:eyes:` reaction + "task started" card; set `activeRelayId`, start a background relay that polls projected timeline and posts first + final assistant text only if the relay is still current |
| `intake/slack.ts` | channel-vs-DM gates, mentions-other-user filter, ambient-message gate, attribution strip, bot mention strip, other-user mention resolution, thread-context capture (~30 msgs/8k chars), sender resolution (`user` id → name/handle, cached), mute/`aside -` parsing                                                                                                                |

**Sketch**

```ts
// new thread
const ws = await client.createWorkspace({
  source: { kind: "directory", path: cfg.officeRepoPath },
});
const agent = await client.createAgent({
  provider: cfg.provider, // "pi"
  config: { model: cfg.model, modeId: cfg.modeId, thinkingOptionId: cfg.thinkingOptionId },
  workspaceId: ws.workspaceId,
  initialPrompt: assemblePrompt(sender, cleanedText, threadContext),
  images,
  labels: { "paseo.chat-thread-id": externalThreadId },
});
await store.put({ externalThreadId, rootAgentId: agent.id });
```

**Tests**

- [ ] Duplicate `eventId` is skipped (inbound dedup).
- [ ] Channel ambient message with no mention + no link is ignored; DM is not.
- [ ] Reply on a linked thread routes to `sendAgentMessage(rootAgentId, …)`.
- [ ] Sender identity block is prepended to the prompt.

**Done when**

- [ ] From Slack, a mention starts an office agent and a reply continues it, end to end. _Code path implemented; pending Slack manual test._

### Slice 6 — Office system prompt assembly

**Goal**: the initial prompt is layered (base + custom office prompt + sender + request).

**Files**

- `packages/chat/src/prompt.ts`

**Change map**

| File        | Change                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt.ts` | `EXTERNAL_INTAKE_AGENT_PROMPT` base constant + load `officePromptPath`; assemble `<office_agent_prompt>…</office_agent_prompt>` + `From: …` + `User request:` + cleaned text/context |

**Tests**

- [ ] Assembled prompt contains base block, custom block, sender line, and request.

**Done when**

- [x] Office agents start with the assembled prompt (verified in create-agent request path).

### Slice 7 — Office-agent-only delegation boundary

**Goal**: the office agent can spawn coding subagents with normal Paseo tools while Slack remains
attached only to the office agent.

**Files**

- `packages/chat/src/bridge.ts` (reply routing and timeline relay target)

**Change map**

| File        | Change                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.ts` | always route subscribed replies to `rootAgentId`; always poll the office agent timeline; ignore spawned child agents as chat targets; rely on the office agent to supervise and summarize child work |

**Tests**

- [ ] A child agent starting does not change the thread session or relay target.
- [ ] Replies during child work still go to the office agent.
- [ ] No `@cto ↑` / focus escape behavior exists because Slack never leaves the office agent.

**Done when**

- [ ] "fix X and open a PR" keeps Slack attached to the office agent, and the office agent reports
      the child result itself. _Pending Slack/manual subagent test._

### Slice 8 — Mute / unmute / aside + errors + teardown

**Goal**: thread controls, error surfacing, and the teardown capture hook.

**Files**

- `packages/chat/src/bridge.ts`
- `packages/chat/src/intake/slack.ts`

**Change map**

| File              | Change                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.ts`       | `@cto mute`/`unmute` toggle `ThreadSession.muted` and react to the command message (`:mute:`/`:sound:` with fallbacks); `aside - <msg>` ignored; start-failure → "I couldn't start a task… Reason: …"; `turn_failed`/status `error` → short error line; `@cto done`/archive → `archiveAgent` + drop store entry + **fire office-brain teardown capture hook** |
| `intake/slack.ts` | parse mute/aside/done commands from cleaned text                                                                                                                                                                                                                                                                                                              |

**Tests**

- [ ] Muted thread does not post agent output for ambient replies; explicit bot mentions and `unmute` still get through.
- [ ] Start failure and turn error each post exactly one message.
- [ ] `@cto done` archives the agent and drops the link.

**Done when**

- [ ] Mute/unmute/aside/done all behave; errors are surfaced; teardown hook fires. _Controls and errors implemented; teardown capture hook is a no-op pending office-brain implementation._

### Slice 9 — Health/config diagnostic + README

**Goal**: an operator can confirm setup.

**Files**

- `packages/chat/src/index.ts` (startup status log)
- `packages/chat/README.md`

**Change map**

| File        | Change                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `index.ts`  | log: daemon reachable? Slack connected (Socket Mode)? bot user id? officeRepoPath + provider/model? |
| `README.md` | Slack app scopes, Socket Mode tokens, env vars, run instructions                                    |

**Done when**

- [x] Startup prints a readable status block; README documents setup.

## Cross-slice acceptance criteria

- [ ] Mention → office agent starts → final answer posts in the thread. _Pending Slack manual test._
- [ ] Reply (from any channel member) continues the office agent. _Pending Slack manual test._
- [ ] Coding subagent work is supervised and summarized by the office agent; the bridge never relays the child directly. _Pending Slack manual test._
- [ ] Permission prompts and questions are answerable from Slack. _Pending Slack manual test._
- [ ] Mute/unmute/aside/done work. _Pending Slack manual test._
- [x] No double-post after a bridge restart mid-thread (delivery receipts).
- [x] No thread-link loss after a daemon or bridge restart (persisted state).
- [x] No raw Slack Web API call anywhere (Chat SDK only).

## Verification

- `npm run build:chat`
- `npm run typecheck`
- `npm run lint -- packages/chat/src/<file>.ts`
- `npm run format:files -- packages/chat/src/<file>.ts`
- `npx vitest run packages/chat/<test-file> --bail=1` (per file; never the full suite)
- Manual: against an ad-hoc in-process daemon harness (`docs/ad-hoc-daemon-testing.md`) — never
  the main 6767 daemon.

## Implementation notes

- Implemented `packages/chat` as a Socket Mode-only Chat SDK process. Slack calls are routed through `chat` / `@chat-adapter/slack`; there are no direct Slack Web API imports or fetches.
- The state layer is file-backed under `PASEO_CHAT_STATE_DIR` / `$PASEO_HOME/chat-bridge`, with atomic JSON writes and Chat SDK `StateAdapter` persistence.
- Permission buttons use Chat SDK cards/actions. Question prompts are stored as pending per thread and resolved by the next thread reply.
- The bridge intentionally does not watch child-agent focus or stamp chat labels on children; subagents stay behind the office agent.
- The office-brain teardown capture hook is intentionally not implemented yet because the office-brain feature is still scoped as not implemented; `@cto done` archives and unlinks the thread.
- Manual Slack end-to-end verification is still pending because Slack app credentials are required.

## Implementation footprint

- `package.json`, `package-lock.json` — added `packages/chat` workspace and `build:chat`.
- `packages/chat/package.json`, `packages/chat/tsconfig.json`, `packages/chat/README.md` — new package scaffold and operator setup docs.
- `packages/chat/src/config.ts`, `paseo-client.ts`, `index.ts` — boot/config/daemon connection/Chat SDK Slack wiring.
- `packages/chat/src/bridge.ts`, `prompt.ts`, `render.ts`, `permissions.ts` — intake-to-agent flow, timeline-polled output relay, prompt assembly, permission handling.
- `packages/chat/src/intake/slack.ts` — Slack message normalization, commands, context capture, image/file attachments, sender identity.
- `packages/chat/src/state/json-state.ts`, `thread-session-store.ts`, `chat-state-adapter.ts` — durable state, dedup/delivery receipts, Chat SDK state adapter.

## Follow-ups (v2+, do not scope-creep into v1)

- Agent-initiated chat tools and outbound bindings: `chat.startConversation`, `chat.askPerson`,
  `chat.askChannel`, `chat.reply`.
- `inbound-http.ts` + GitHub PR-merge webhook + Resend email intake.
- Remote mode (relay + E2EE), second Chat SDK adapter (Discord/Telegram).
- Optional multi-repo routing (intake profiles + LLM classification).
- Outbound file attachments; concurrency caps; per-channel access policy; richer remote-safe people
  directory sync and ask timeout/cancel semantics.
