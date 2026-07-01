# Chat Bridge v1 — Research

Source references: [docs/chat-bridge.md](../../chat-bridge.md) (full design), code paths below
Date created: 2026-06-27

Facts are grounded in the current repo. Recommendations are marked **REC**.

## Daemon client (the daemon-facing half)

- **Use the low-level `DaemonClient`, not the `PaseoClient` facade.** Import:
  `import { DaemonClient } from "@getpaseo/client/internal/daemon-client"` — exported via
  `packages/client/package.json` `"./internal/daemon-client"`. The facade lacks raw stream
  subscription and permission handling.
- **Connection pattern to mirror:** `packages/cli/src/utils/client.ts`. It builds the WS URL
  (`buildDaemonWebSocketUrl`), uses `ws`'s `WebSocket`, a generated client id
  (`getOrCreateCliClientId`), and `DEFAULT_HOST = "localhost:6767"`. v1 connects to
  `127.0.0.1` directly — no relay, no E2EE.
- **Relevant `DaemonClient` methods** (`packages/client/src/daemon-client.ts`):
  - `createWorkspace(input, requestId?)` — `input.source` is a discriminated union; for the
    office agent use `{ kind: "directory", path }` (`messages.ts:1749`). Returns
    `WorkspaceCreatePayload` with `workspaceId`.
  - `createAgent(options: CreateAgentRequestOptions)` — options include `provider`, `config`
    (model/mode via `resolveAgentConfig`), `workspaceId`, `initialPrompt`, `images`, `labels`.
    Returns `AgentSnapshotPayload` (`.id` is the `agentId`).
  - `sendAgentMessage(agentId, text, options?)` — `options?.images` / `attachments` supported.
  - `respondToPermission(agentId, requestId, { behavior, selectedActionId })`.
  - `waitForFinish(agentId, timeout?)` — authoritative completion signal (subscribes to
    `agent_update` internally).
  - `archiveAgent(agentId)` — soft delete; cascades to subagents (`agent-lifecycle.md`).
  - `on(type, handler)` — typed event subscription. Relevant events: `agent_stream`,
    `agent_update`, `agent_permission_request`.

## Streaming + turn boundaries

- **No assistant text deltas.** Assistant output arrives as multiple complete `timeline` rows
  with `item.type: "assistant_message"`; concatenate.
- **Turn boundary:** `turn_started` → N× `timeline` → `turn_completed | turn_failed |
turn_canceled`. `turnId` is stripped at the wire — group by start/end stream events.
- **`waitForFinish(agentId)` is the authoritative turn-close backstop** alongside the stream
  end events.
- Timeline item types we map: `assistant_message`, `tool_call` (with `status`), `reasoning`,
  `plan`. Schemas in `packages/protocol/src/messages.ts` (`AgentTimelineItem`,
  `ToolCallDetail`, `AgentStreamEventPayload`).

## Subagents (office-agent-only boundary)

- `create_agent` with `relationship: { kind: "subagent" }` stamps `paseo.parent-agent-id` on
  the child; surfaced as `agent.parentAgentId` (`agent-lifecycle.md:22`).
- Parent stays `idle` while the child runs (status is literal). The bridge does **not** compensate
  by switching to the child. Slack remains attached to the office agent, which supervises and
  summarizes child work.
- The office agent creates children **itself** via its Paseo tools (`create_worktree` +
  `create_agent`). The bridge does not initiate worktrees and does not track children as chat
  state.
- **REC:** the bridge stamps a `paseo.chat-thread-id` label on the office agent only. Child
  association comes from the normal parent/subagent relationship in the UI.

## Permissions

- Daemon emits `agent_permission_request` with `actions[]` (`{ id, label, behavior, variant }`)
  → map 1:1 to Slack buttons.
- Resolve via `respondToPermission(agentId, request.id, { behavior, selectedActionId })`.
- The `question` permission kind is how "agent asks the user a question" surfaces.
- **REC:** create office agents in a permission-prompting mode (Claude `modeId: "default"`, not
  `bypassPermissions`; Codex avoid `full-access`) so external-action confirmations fire.

## State persistence (file-backed, no DB)

- **Atomic writes:** `writeJsonFileAtomic(filePath, value)` in
  `packages/server/src/server/atomic-file.ts:23` (temp-file + rename). The bridge is a separate
  package; **REC:** copy the ~20-line helper into `state/json-state.ts` to avoid a server dep.
- **Serialize saves** through an in-memory write queue, as `loop-service.ts` does.
- **Validation:** Zod schema per store, parsed on load, optional-field defaults (no migrations).
- **Closest templates:** `packages/server/src/server/schedule/store.ts`,
  `push/token-store.ts`.
- **Chat SDK state:** implement a custom file-backed `StateAdapter` (~11 methods) rather than
  pulling `@chat-adapter/state-redis`. Subscriptions + KV cache persist to JSON; locks are an
  in-process keyed async mutex (single process → correct).

## Chat SDK (the Slack-facing half)

- All Slack I/O via `chat` + `@chat-adapter/slack`. Callbacks: `bot.onNewMention`,
  `bot.onDirectMessage`, `bot.onSubscribedMessage`. Reactions via `sentMessage.addReaction` /
  `adapter.addReaction`. Assistant replies use normal `thread.post({ markdown })` /
  `adapter.postMessage(...)` calls; do not use Chat SDK native streaming for v1.
- **Concurrency:** construct the bot with `concurrency: "queue"` (serial per thread, parallel
  across threads).
- **Dedup:** Chat SDK `dedupeTtlMs` (~10 min) + our own event-receipt keys.
- Chat SDK is **beta** — **REC:** pin the version; treat `StateAdapter` interface changes as a
  small contained fix.
- Sender identity: resolve Slack `user` id → display name/handle via Chat SDK (cached). No raw
  Slack Web API call.

## Monorepo fit

- `@getpaseo/chat`, private, ESM, `moduleResolution: NodeNext` (cli pattern), tests via
  `vitest`. Tooling: **oxlint + oxfmt** (run via `npm run lint` / `npm run format`).
- Add `build:chat` after `build:client`; `typecheck`/`test` picked up by the workspace fan-out.
- `@getpaseo/client` is "not a stable SDK" — living in-monorepo keeps the bridge in lockstep.

## Constraints / risks

- **Protocol compat:** the bridge only consumes existing daemon RPCs/events; no new wire
  messages needed for v1. No protocol changes.
- **No daemon restart:** never restart the main daemon on 6767 to test (it manages running
  agents). Use an ad-hoc in-process daemon harness for tests (`docs/ad-hoc-daemon-testing.md`).
- **Chat SDK beta drift** is the main external risk — mitigated by version pinning.
- **Double-posting after restart** is the classic correctness trap — mitigated by outbound
  delivery receipts (the outbound twin of inbound dedup).

## Recommended direction

Build the bridge as the thin transport adapter described in `docs/chat-bridge.md`: a
`DaemonClient` over `127.0.0.1`, Chat SDK over Socket Mode, file-backed state, and glue modules
for timeline polling, Slack rendering, and permissions. Everything intelligent lives in the
office agent and its prompt.
