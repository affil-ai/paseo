# Chat Bridge (Slack / Chat SDK) — Scoping

> **Status: v1 implementation in progress.** `packages/chat` now contains the initial Slack Socket Mode bridge. This doc remains the system design and roadmap; v2 items are still future work.
> Work is scoped across phases — see [Release roadmap](#release-roadmap) — and each feature is
> tagged **v1** / **v2** with a concrete scope, not deferred to "later." The production
> agent-initiated conversation plan lives in [docs/plans/chat-bridge-v2](plans/chat-bridge-v2/prd.md).

## Goal

Let people and Paseo agents talk through chat platforms — Slack first, others later — without
making Slack the product model. A human can @-mention a bot to start or continue an agent, and
an agent can explicitly start or continue a chat with a person when it needs human input. In
both directions, the durable product object is a Paseo **chat binding**, not a Slack thread.

The agent on the other end is **not** a coding-only agent. It is an **"office of CTO" agent**:
a general operator with full org context that can answer questions, do data analysis, take
actions in external systems (Google Sheets, GitHub, CRM, …), _and_ write code when that's
actually what the task needs. The bridge does not know or care which of these a given message
is — it just gets the message into the agent and relays the answer back. All of that
capability comes from the agent's tools (its `executor` MCP for external systems, plus the
native Paseo tool catalog), not from logic in the bridge.

> **The bridge is a transport adapter, not an orchestrator.**
> `external chat thread ⇄ chat binding ⇄ existing or new Paseo agent`.
> It does intake, binding lookup/persistence, output relay, permission/question relay, delivery
> receipts, attachment normalization, and subscriptions. It does **not** route by task type, own
> per-repo profiles, classify intent, decide when to cut a worktree, or talk to Google
> Sheets/GitHub itself. Those are agent decisions, made with the agent's own tools.

The platform-agnostic layer is [Chat SDK](https://chat-sdk.dev) (`chat` core +
`@chat-adapter/*` adapters), which unifies Slack, Discord, Telegram, Teams, Google Chat,
etc. behind one API. One codebase, many platforms.

### Prior art: `affil-ai/t3code`

There is an existing, working implementation of a related idea in the private repo
`affil-ai/t3code` (`apps/server/src/externalIntake/`). It bridges Slack + email + GitHub
into **coding-agent** runs using **the same Chat SDK**. This doc mines t3code for its intake
mechanics, but **deliberately departs from its model**. Three things to note:

- **Carry forward (mechanics):** Slack intake (mentions, DMs, thread linking), dedup,
  subscription lifecycle, mute/unmute, attachments, text cleaning, Slack markdown fix-ups.
  These are correctness/quality details that apply to any bridge.
- **Drop (the coding-specific model):** t3code is built around "one Slack thread = one coding
  run = one worktree/branch", with a bridge-owned router that picks a repo, classifies
  "run vs build", and creates a worktree per thread. **We do not do this.** Worktree creation
  is an agent decision, not an intake invariant. Multi-repo profiles and route classification
  are not core to the design (see [Optional routing](#optional-routing-not-core)).
- **Improve (threading):** t3code's core shape — first visible assistant response and final
  response as thread replies — is the right Slack UX for now. The Paseo bridge polls the
  daemon timeline and posts complete assistant text blocks only, never partial stream chunks.

## Slack reply contract

Slack output must stay in the user's message thread:

- Always send assistant output as replies to the Slack message thread, never as new top-level messages.
- Do **not** post intermediate assistant/tool output in Slack v1; it is too noisy and Slack's native streaming error UI is confusing.
- Post the first complete assistant text block for a turn, then post the final assistant text block when the agent stops. If first and final are the same text, post it only once.
- Fetch assistant text from the daemon's canonical timeline and post complete assistant text blocks as normal thread replies. Do not use native Slack streaming.
- Slack-bound markdown converts valid GitHub/Markdown table blocks into native Slack table blocks; the Paseo UI keeps rendering the original markdown.
- If a Slack-bound chat tool message expands to multiple posts because it contains multiple tables, file uploads stay attached to the first emitted post.

Manual relay mode keeps progress updates explicit: the office agent calls `chat.send` for
Slack-visible text and/or files instead of relying on automatic final-message relay. The bridge
does not enforce missing final replies in manual mode: it does not post bridge-authored fallback
text to Slack and does not send reminder/follow-up prompts back to the agent. The Slack thread
receives only agent-authored `chat.*` deliveries on this path. The prompt still instructs the
office agent to end each Slack turn with a final `chat.send`, except when the Slack user
explicitly asks not to receive another message.

Slack input should match the app's default send behavior:

- If a human replies while the bound office agent is still running, the follow-up interrupts the
  active turn and starts the new prompt, just like pressing Enter in the Paseo UI.
- Pi allows only one active provider turn at a time, so the daemon/provider interrupt path must
  acknowledge cancellation before starting the replacement turn; otherwise `A Pi turn is already
active` can leave the agent in an error state.

## Hard constraint: Chat SDK is the _only_ Slack client

All Slack interaction goes through Chat SDK (`chat` + `@chat-adapter/slack`). The bridge
must **never** call the Slack Web API directly or hold a raw `SLACK_BOT_TOKEN` fetch path.
Everything we need is native to Chat SDK:

| Need                       | Chat SDK API (use this)                                              |
| -------------------------- | -------------------------------------------------------------------- |
| Listen for mentions/DMs    | `bot.onNewMention`, `bot.onDirectMessage`, `bot.onSubscribedMessage` |
| Listen for emoji reactions | `bot.onReaction([...], handler)`                                     |
| Post a message             | `thread.post(...)` / `adapter.postMessage(...)` through Chat SDK     |
| Add a reaction             | `sentMessage.addReaction(emoji.eyes)` / `event.adapter.addReaction`  |
| Cross-platform emoji names | `import { emoji } from "chat"` (e.g. `emoji.eyes`, `emoji.check`)    |
| Rich cards / buttons       | `Card`, `CardText`, `Actions`, `LinkButton` from `chat`              |
| Send files (agent → Slack) | `thread.post({ markdown, files: [{ data, filename }] })`             |
| Read inbound attachments   | `attachment.fetchData()` on the message attachment handle            |
| Signature verification     | handled inside `@chat-adapter/slack` (Socket Mode / signing secret)  |

> **t3code cautionary note.** t3code reached around Chat SDK to the raw Slack Web API in a
> few places — `files.getUploadURLExternal` / `files.completeUploadExternal` (upload),
> `files.info`, and direct `url_private` bearer fetches (download fallbacks) in
> `ExternalChat.ts`. **We do not copy those.** Chat SDK's `thread.post({ files })` and
> `attachment.fetchData()` cover upload and download natively; if a corner case isn't
> covered, the answer is to file it against Chat SDK / use a supported option, not to add a
> raw token path. Reactions, cards, and posting were already pure Chat SDK in t3code
> (`sentMessage.addReaction`, `thread.post`) — we keep that.

## Core concept: the bridge is just another daemon client

The mobile app is not special. It is a WebSocket client of the local daemon, and so are the
CLI and desktop app (see [architecture.md](architecture.md)). A chat bridge is **the same
protocol with chat as the input/output surface** — not a change to the daemon or any core
package. It sits in the same top row as the app and CLI:

```
  Mobile app ─┐
  CLI ────────┤  all speak the same daemon WebSocket protocol
  Desktop ────┤
  Chat bridge ┘  ← Chat SDK on one side, @getpaseo/client on the other
              ▼
         Paseo daemon (127.0.0.1:6767)
```

Because the bridge runs on the **same machine** as the daemon, it connects to
`ws://127.0.0.1:6767` directly — no relay, no E2EE.

Crucially, anything the bridge creates is a **normal Paseo agent**, so it shows up everywhere
the app/CLI/desktop look: the sidebar agent list, the timeline view, deep links. A Slack
thread and the Paseo UI are two windows onto the _same_ agent — start a task from Slack,
finish it from your phone. See [UI model](#ui-model) for the full picture.

## Bidirectional binding model

Stop thinking of the bridge as only `Slack thread → newly-created Paseo agent`. The core model is
bidirectional:

```txt
external chat thread <-> chat binding <-> existing or new Paseo agent
```

`packages/chat` owns transport concerns: Chat SDK adapter setup, inbound event handling,
subscriptions, Slack/thread identity mapping, attachment normalization, inbound dedupe, outbound
delivery receipts, thread-agent bindings, and permission/question bridging. Chat SDK stays because
it handles Slack Socket Mode/webhooks, `thread.post`, cross-platform posting/streaming
abstractions, attachments, reactions/cards, and future Discord/Teams/etc. But Chat SDK is **not**
the durable domain model; Paseo's file-backed chat bridge state is.

### Binding kinds

```ts
type ChatBinding =
  | {
      kind: "inbound-session";
      externalThreadId: string;
      rootAgentId: string;
    }
  | {
      kind: "outbound-conversation";
      externalThreadId: string;
      officeAgentId: string;
      pendingRequestId?: string;
      subscribed: boolean;
    };
```

Current v1 code has the first shape as `ThreadSession { rootAgentId, activeRelayId, muted }`
in `ThreadSessionStore`. Evolve that store into the union above rather than treating Chat SDK
subscription state as the product state.

### Routing rules

- Human starts a new DM, mention, or unclaimed Slack thread → create a new office agent and an
  `inbound-session` binding.
- Existing bound external thread → route replies to the bound office agent (`rootAgentId` /
  `officeAgentId`).
- The office agent starts an outbound conversation → create or reuse a Slack DM/thread, post via
  Chat SDK, and bind replies back to that same office agent (`outbound-conversation`). No new
  Paseo agent is created, and child/coding agents cannot own chat bindings.
- The office agent creates another Paseo agent/workspace using existing Paseo tools → the chat
  binding stays attached to the office agent. Chat tools do not create agents, and chat replies
  never target the spawned agent directly.

### Office-agent-visible chat tools

The office agent must not use raw Slack APIs or tokens. It should receive person/thread primitives
through a Paseo-owned tool surface, for example:

```ts
chat.send({ destination: { kind: "person", key: "vivek" }, message: "..." });
chat.send({ files: [{ path: "/tmp/chart.png" }] });
chat.ask({ destination: { kind: "person", key: "vivek" }, question: "..." });
```

Recommended implementation for Paseo's current architecture: expose these as **daemon-owned
Paseo/MCP tools backed by a chat service API**, not as bridge-local Slack tools. The daemon already
owns the agent tool catalog and audit trail; `packages/chat` owns transport. A local
`ChatBridgeService` can register with the daemon over the existing WebSocket/client path (or a
small local RPC) so the daemon tool calls `packages/chat`, and `packages/chat` uses Chat SDK to
post + persist the binding. This keeps the office agent on stable `chat.*` primitives, keeps Slack
tokens inside the bridge, and avoids coupling the agent runtime to one adapter. The daemon only
registers `chat.*` tools for agents stamped with `paseo.chat-thread-id` and rejects delegated
agents carrying `paseo.parent-agent-id`; child/coding agents report to the office agent, and the
office agent decides what to say externally.

### Outbound modes

1. **Fire-and-subscribe / office-agent conversation.** The office agent sends a message to a
   person; bridge creates or reuses a Slack DM/thread; replies route back to that same office agent
   via `client.sendAgentMessage(...)`. Use for quick async input, file requests, or permission
   confirmations. No new Paseo agent.
2. **Ask-and-wait / office-agent blocking question.** `chat.ask(...)` posts a question and
   stores a pending request. The reply is routed back to the same office agent, with timeout/cancel
   semantics. Still the same office agent; the current task is waiting for human input.
3. **Artifact reply / explicit upload.** `chat.send(...)` uploads generated local artifacts (CSV,
   PDF, screenshot, chart, etc.) to the current or selected chat conversation through Chat SDK.
   Uploads are explicit tool calls; the bridge does not scrape assistant text for file paths.
4. **New agents stay behind the office agent.** If the office agent wants a new agent/workspace,
   it uses normal Paseo tools (`create_agent`, `create_worktree`, etc.). The bridge keeps talking
   only to the office agent. Chat tools never create agents.

### People resolution and guardrails

- Resolve `person: "vivek"` through bridge/daemon config: aliases, Slack user IDs, emails, and
  optionally `memory/people/*.md` metadata. The office agent sees people keys; raw Slack tokens and
  adapter user IDs stay behind the bridge.
- Persist outbound bindings and pending `chat.ask` requests under `$PASEO_HOME/chat-bridge/`
  with the same atomic JSON + Zod pattern as inbound sessions. On restart, reload bindings,
  subscriptions, pending request deadlines, and delivery receipts; expired asks resolve as
  timeout/canceled rather than hanging forever.
- Outbound contact requires an explicit `chat.*` tool call. Ordinary assistant messages must not
  ambiently DM people or upload files. Record an audit trail (agent id, requester, person,
  external thread id, message/file preview, timestamp) and support an optional allowlist per
  workspace/person/channel.

## Task model

The model is deliberately simple:

- **One inbound chat thread = one Paseo workspace = one long-lived "office agent."** Agent-initiated outbound conversations bind to the office agent. If that agent starts another Paseo agent/workspace, Slack still talks only to the office agent; no extra chat thread is created by default.
- The office agent's workspace is a **`directory` workspace** backed by the configured **office
  repo** — the CTO-office repo that holds the agent's schema (`AGENTS.md`), memory, and shared
  skills (see [office-brain.md](office-brain.md)). It sits alongside your other product repos,
  so the agent's `cwd` is the office repo but it can `cd` into any sibling repo, read across the
  whole org, run scripts, and use its `executor` MCP for external systems. It is **not** a
  worktree and **not** tied to one product repo.
- **Worktrees are created only if the agent itself decides a task needs isolated code
  changes** — using its `create_worktree` + `create_agent` Paseo tools (see
  [Execution model](#execution-model)). The bridge never cuts a worktree, but the office
  prompt tells the agent to infer code-editing intent from ordinary requests so non-technical
  users do not need to ask for a subagent explicitly.
- The bridge is a **standalone, long-lived Node process** running beside the daemon.

The thread is the continuity unit. Each new thread gets a fresh office agent with its own
context window, so two parallel Slack threads never bleed into each other. Replies in a thread
continue that thread's agent (`sendAgentMessage`).

### How t3code concepts map onto Paseo

t3code is built on Effect-TS with its own orchestration engine; Paseo has the daemon. The
translation is direct — but note the model differs (no per-thread worktree):

| t3code (Effect orchestration engine)                      | Paseo equivalent (daemon)                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `orchestrationEngine.dispatch({ type: "thread.create" })` | `client.createWorkspace({ source: { kind: "directory", path } })`   |
| (t3code always cuts a worktree per thread)                | **no worktree at intake**; the agent cuts one only if it needs to   |
| `thread.turn.start` (initial prompt / follow-up)          | `client.createAgent({ initialPrompt })` / `client.sendAgentMessage` |
| `Thread` / `ThreadId` (a run)                             | a Paseo **agent** (`agentId`)                                       |
| `streamDomainEvents` + `Reactor` subscriber               | `client.on("agent_stream", …)`                                      |
| `thread.message-sent` (assistant)                         | `agent_stream` → `timeline { item.type: "assistant_message" }`      |
| `thread.activity-appended` → `user-input.requested`       | `agent_permission_request` (kind `question`)                        |
| `thread.session.status` (running/ready/stopped/error)     | `agent_update` status (`running`/`idle`/`error`) + `waitForFinish`  |
| `ExternalIntegrationRepository` (SQLite tables)           | `thread-session-store` (file-backed JSON) + dedup/link tables       |
| bridge-owned repo routing / "run vs build" classifier     | **dropped**; the agent decides, with its own tools                  |

## Execution model

This is the heart of the redesign: **the agent is the router.** The bridge hands the message
to one capable agent and that agent decides how to fulfill it, because it has both its
`executor` MCP (external systems) and the native Paseo tool catalog
(`packages/server/src/server/agent/tools/paseo-tools.ts`).

The office agent can, on its own:

- **Answer / analyze** directly (a question, a summary, a data pull via `executor` MCP).
- **Take an external action** (update a Google Sheet, file a ticket, post an update) via
  `executor` MCP, asking for confirmation first on destructive/external writes.
- **Inspect code in place** by `cd`-ing into a sibling repo from its office-repo workspace — no
  worktree needed for read-only questions or quick investigation.
- **Delegate code changes to a coding subagent** when a task requires modifying code — fix,
  refactor, cleanup, implement, test, or behavior change. The agent infers this from user
  intent (for example, "clean up the affil repo") and calls `create_worktree` + `create_agent`
  with `relationship: { kind: "subagent" }`, which cuts a worktree off the right repo and
  spawns a child agent stamped with `paseo.parent-agent-id` (see
  [agent-lifecycle.md](agent-lifecycle.md)).
- **Run terminals, schedules, heartbeats** via the Paseo tools (`create_terminal`,
  `create_schedule`, …) for recurring / proactive office work.

The Paseo tool catalog the agent gets includes (non-exhaustive): `create_agent`,
`send_agent_prompt`, `wait_for_agent`, `cancel_agent`, `create_worktree`, `list_worktrees`,
`create_terminal`, `capture_terminal`, `create_schedule`, `create_heartbeat`,
`set_agent_mode`, `respond_to_permission`. This is why no "router / profiles / execution
modes" layer is needed in the bridge — the agent already has the primitives.

### Office-agent-only chat boundary

The chat bridge interfaces with **one agent per binding: the office agent**. When the office
agent spawns a coding subagent, the bridge does not track that child as chat state, does not poll
its timeline, does not route replies to it, and does not expose a "focused agent" concept in
Slack. The office agent remains the conversational supervisor and the only agent the bridge sends
messages to.

```ts
type ThreadSession = {
  externalThreadId: string;
  rootAgentId: string; // the office agent — always
  // ...dedup keys, muted, artifacts, timestamps (see State storage)
};
```

Rules (all decided):

- **Stable conversation owner.** Replies in a bound Slack thread always call
  `sendAgentMessage(rootAgentId, …)` for inbound sessions, or `sendAgentMessage(officeAgentId, …)`
  for agent-initiated outbound conversations.
- **No child chat tracking.** The bridge does not persist `focusedAgentId`,
  `activeChildAgentId`, or `activeWorkAgentId`. A child agent is a normal Paseo subagent visible
  in the app's subagents track/worktree UI, not a chat endpoint.
- **No child output relay.** Child progress reaches Slack only if the office agent summarizes it in
  its own assistant messages. The bridge never streams or polls a child timeline directly.
- **No escape hatch.** Because Slack never leaves the office agent, there is no `@cto ↑` command
  and no **Back to office agent** button.

## UI model

Because the office agent is a normal Paseo agent, the work surfaces cleanly in the app/desktop
sidebar. The office repo shows up as a **Project** ("office") and each thread becomes a
workspace row under it:

```
▾ office                            ← project (the office repo)
   ▸ "Update partner tracker"       ← workspace = thread A   [office agent, idle]
   ▾ "Fix onboarding crash"  ●      ← workspace = thread B   [office agent]
       └ subagents track:
           🔧 coding · fix-onboarding  ● running
   ▸ "Why is trial conv down?"      ← workspace = thread C   [office agent, idle]

▾ product-repo                      ← a sibling product repo
   ▸ main
   ▸ fix-onboarding  ●              ← worktree workspace (the SAME coding subagent)
```

- **Project = the office repo.** One sidebar group ("office").
- **Workspace = one Slack thread.** A `directory` workspace on the office repo's `cwd`, titled
  from the thread topic. Multiple workspaces share the same `cwd` — which Paseo supports (`glossary.md`,
  `architecture.md` "right-sidebar boundary") — staying independent (own tabs, agents, title)
  while sharing directory-backed surfaces (file explorer, git status).
- **Office agent = one tab** in that workspace; its **subagents track** lists the coding
  children it spawned.
- **A coding subagent shows up in two places, both correct:**
  1. In the office agent's **subagents track** (it was created with
     `relationship: { kind: "subagent" }`, so it carries `paseo.parent-agent-id`). This is the
     authoritative "which office agent owns this" view.
  2. As a **worktree workspace under the real repo's project** (keyed by git remote) — e.g. a
     `fix-onboarding` row under the relevant product repo, exactly where code work belongs.

  So the _office_ side groups by thread; the _code_ side groups by repo; the parent→child
  relationship links them.

### Telling work apart at a glance

- **Subagents track** — authoritative parent↔child view.
- **Workspace status bucket** — a running subagent lights up the _parent's_ workspace row
  (`agent-lifecycle.md`: running subagents contribute `running` to the parent's owning
  workspace), so thread B shows an activity dot while its coding child runs.
- **Worktree name** — visible under the repo's project.
- **`paseo.chat-thread-id` label (new).** The bridge stamps the office agent it creates with a
  `paseo.chat-thread-id` label. Because the bridge does not interface with child agents, it does
  not stamp or relay children; child association comes from the normal parent/subagent relation in
  the Paseo UI.
- **`paseo.chat-source` label.** The bridge also stamps the office agent with the source used for
  user-message attribution in Paseo. Current values are `slack` for direct Slack intake and
  `support` for support-email sessions that announce into Slack. UI code must resolve this through
  `getChatUserMessageSourceFromLabels()` rather than parsing prompt text or Slack thread ids.

## Release roadmap

Two shipping phases. v1 is a self-contained, useful product on its own; v2 is additive and
does not require reworking v1.

### v1 — "Slack drives one office agent per thread"

The complete single-agent Slack experience. v1 can run behind Socket Mode or the current Slack
Events HTTP mode, but the product scope is still Slack-only intake into one office agent per
thread. v1 is intentionally **thin** — the intelligence lives in the agent and its prompt, not the
bridge.

- Slack intake: mentions, DMs, subscribed-thread follow-ups (Feature 1).
- One inbound thread = one workspace = one office agent, on a single configured `directory`
  workspace (the office repo). **No per-thread worktree, no repo routing, no classifier.**
- Timeline-polled Slack relay: first complete assistant text block plus final assistant text block; no native Slack streaming.
- **Office-agent-only chat boundary:** replies and relay stay on the office agent even when it
  delegates to subagents (see [Office-agent-only chat boundary](#office-agent-only-chat-boundary)).
- `:eyes:` acknowledgement reaction; compact "Working on it" card with a `View chat` deep-link button.
- Permission prompts → Slack buttons; agent **questions** → numbered card answered by reply.
- Mute / unmute / `aside -` (Feature 2).
- Configurable **default provider** — **Pi**, with a backing model of **Codex `gpt-5.5`
  (medium)** — used for every office agent the bridge creates.
- Assembled initial prompt with the configurable **office system prompt** block.
- Inbound image and file attachments → agent.
- `paseo.chat-thread-id` label stamped on the office agent.
- Health/config command (Feature 5).
- Start-failure and turn-error messages surfaced to the thread.
- The intake & relay mechanics below: serial-per-thread queue, inbound dedup + **outbound
  delivery receipts**, loop/mention/ambient filtering, channel-vs-DM rules, text cleaning,
  Slack markdown fix-ups, subscription lifecycle, thread title derivation.
- Idempotency, thread linking, and restart-resilient state (file-backed store).

**v1 exit criteria:** from Slack you can start the office agent, ask it to answer/analyze/act,
receive first/final assistant updates, have it delegate code work to a coding subagent while Slack
continues talking only to the office agent, answer the office agent's permission prompts, reply to
continue it, and mute it. From an agent, an explicit same-agent outbound chat tool can message a
configured person and bind replies back to the office agent. Both inbound and outbound bindings
survive a daemon or bridge restart.

### v2 — "Agent-initiated chat + richer I/O + more channels + remote"

The defining new capability is a durable **bidirectional chat surface**: the office agent can
explicitly start/reply/ask/upload through chat tools, and the bridge can ingest more event sources
than Slack messages. v2 delivers:

- **PR-merged notifications** — GitHub webhook → `:white_check_mark:` + "merged" message
  posted into the originating thread (Feature 3).
- **Inbound email intake** (Resend) as a second channel feeding the same pipeline (Feature 4).
- **Agent-initiated chat tools** — `chat.send` and `chat.ask`, with executor-discovered channel
  destinations, durable outbound bindings, pending asks, restart recovery, and audit records.
- **Bidirectional file attachments** — agent-produced files/images posted back to the thread via
  explicit `chat.send` file uploads and Chat SDK uploads.
- **Second chat adapter** (Discord or Telegram) to prove the platform-agnostic seam.
- **Remote deployment mode** — bridge on a different host than the daemon, connecting over the
  Paseo relay with E2EE (the same path the mobile app uses), instead of `127.0.0.1`.
- **Optional routing** (intake profiles + LLM classification) — see
  [Optional routing](#optional-routing-not-core). This is _not_ core to the model; it is only
  worth adding if a single office agent on the office repo proves insufficient.

**v2 exit criteria:** the office agent can start and continue subscribed Slack conversations,
ask blocking human questions, upload generated files/images, receive PR-merge notifications, ingest
email threads into the same office-agent model, and run from a host separate from the daemon.

## Feature set (external intake)

Scoped from t3code's `externalIntake/`. Each feature is mapped to the Paseo daemon and tagged
with the phase that delivers it (**v1** / **v2**).

### 1. Slack bot intake — **v1**

The core feature. A bot that listens for and acts on:

- **Direct mentions** (`@bot <task>`) in any channel → starts a new office agent + workspace.
- **DMs** → starts a new office agent.
- **Subscribed-thread follow-ups** → replies in a thread already linked to an agent
  continue the office agent (`sendAgentMessage`).

Chat SDK exposes these as `bot.onNewMention`, `bot.onDirectMessage`, and
`bot.onSubscribedMessage` (the three callbacks t3code registers in `ExternalChat.ts`).

Behaviors to bring across from t3code:

- **Idempotency / dedup:** build an `eventId = "slack:<externalThreadId>:<messageId>"` and
  skip already-processed events. t3code stores receipts in an `external_event_receipts`
  table; the Paseo bridge keeps the same in its store.
- **Thread linking:** `externalThreadId = [teamId:]channelId:threadTs` ↔ the `ThreadSession`
  (`rootAgentId`). This is the bridge's central map.
- **Thread context capture:** on a fresh mention inside an existing human thread, gather
  prior messages (t3code caps at ~30 messages / ~8,000 chars) and prepend them to the
  initial prompt so the agent has context.

Auth: the `@chat-adapter/slack` adapter verifies the Slack signature and runs in Socket Mode
(no public inbound URL). Tokens are consumed by the adapter, not by our code.

#### Sender identity — **v1**

The agent must know **who sent each message** — "add this to the tracker" carries different
weight from the CEO than a contractor, and the office brain's capture is only useful if it
records _who_ decided/asked what (see [office-brain.md](office-brain.md) → Who's talking). The
bridge resolves the Slack `user` id and prepends a compact identity line to the assembled prompt
(and to every `sendAgentMessage` follow-up):

```
Jane Doe (@jane): message text
```

- Resolution (`user` id → display name / handle) is via Chat SDK, looked up once and cached —
  **no raw Slack Web API call** (per the hard constraint). Keep the per-message prompt compact:
  `Name (@handle): message`; do not repeat people-file lookup hints, raw Slack IDs, or separate
  `From:` / `User reply:` labels on every turn.
- **Identity is attached per message, not per thread.** Because anyone in the channel can steer
  a running session (see below), a follow-up may come from a different person than the starter;
  each turn carries its own sender.

#### Multiplayer steering — **v1**

Once a session is active in a thread, it belongs to **everyone in the channel**, not just the
person who started it (the same model Claude Tag uses — see
[Prior art](#prior-art-claude-tag)). Any channel member can reply in the thread to add context,
redirect, answer a question, or pick up the result — the bridge routes their reply to the
office agent via `sendAgentMessage`, tagged with that sender's identity. No re-mention
required; `onSubscribedMessage` already fires for any thread participant. The "Open in Paseo"
deep link on each delivery is the shared, read-only record of the full tool-call timeline that
anyone in the channel can open.

#### Reactions on the triggering message — **v1**

When a new office agent starts, the bridge reacts to the **original triggering Slack message**
(not a new post) to signal acknowledgement:

1. Add `:eyes:` — "seen, starting work."
   `const sent = thread.createSentMessageFromMessage(message); await sent.addReaction(emoji.eyes)`.
2. (Optional) a configurable acknowledgement emoji as a second reaction.
3. On PR merge (v2), add `:white_check_mark:` to the same message (see Feature 3).

All are `addReaction` calls on a Chat SDK `SentMessage` / via `adapter.addReaction` — no raw
Slack call. (Note: t3code's _per-repo_ `slackEmoji` routing alias is dropped along with the
repo-profile model; emoji are acknowledgement-only here unless optional routing is added.)

#### "Task started" card — **v1**

Immediately after creating the agent, post a card to the thread (Chat SDK `Card` / `CardText`
/ `Actions` / `LinkButton`):

- **Title:** "Talk to <bot> in this thread"
- **Body:** "I'll keep replies here and link the session once it's available."
- **Button:** "Open" (primary) → deep link to the agent's session in the Paseo app/web UI,
  built from a configured base URL + `serverId` + `workspaceId` + `agentId`.
- **Fallback text** (non-card clients): the same, with the URL inline.

Paseo chat deep links point at the concrete workspace route with an agent-open intent: `/h/[serverId]/workspace/[workspaceId]?open=agent:[agentId]`.

### 2. Mute / unmute + per-message controls — **v1 (cheap, high-value)**

A thread can be silenced via `@bot mute` / `quiet` and re-enabled via `@bot unmute` /
`resume replies`, with an `aside - <msg>` prefix to ignore a single message. Mute state is
persisted per thread. The bridge acknowledges mute/unmute with a reaction on the command message
(`:mute:` / `:sound:` with `:no_bell:` / `:bell:` fallbacks), not a chat reply. While muted,
ambient/subscribed replies are ignored, but an explicit bot mention still gets through so users
can wake or direct the agent without first unmuting. Cheap to implement and prevents the bot from
being noisy in shared channels. Store the flag on the `ThreadSession`.

### 3. PR-merged notification — **v2 (first feature needing public inbound HTTP)**

When the office agent (or a coding subagent it spawned) opens a PR and it later merges, the
bridge posts a completion message back to the thread:

1. **Detect + record the PR.** Scan the projected agent timeline (of whichever agent is being
   relayed) for `https://github.com/<owner>/<repo>/pull/<number>` and store an artifact link
   `("github_pr", "<owner>/<repo>#<number>") → { externalThreadId, url, title }`. The
   artifact-link recording can land in v1 since it only reads persisted timeline rows.
2. **Receive the merge event.** A `POST /github/webhook` endpoint (verified with
   `GITHUB_WEBHOOK_SECRET`, HMAC-SHA256, deduped on `x-github-delivery`) listens for
   `pull_request` events where `merged === true`.
3. **Notify the thread.** Look up the linked thread, add `:white_check_mark:` to the original
   triggering message, and post: `Merged noted. [PR #42: <title>](<pr-url>) is done.`

This is **notification-only** — it does not start an agent. It's v2 because the GitHub webhook
needs a **public inbound HTTP endpoint** — the shared `inbound-http` server v2 introduces.

### 4. Inbound email intake (Resend) — **shipped**

A second intake channel: inbound emails become office-agent threads, feeding the same
pipeline. Modeled on t3code's `POST /support-email/resend` endpoint. As implemented:

- **Receiver:** `POST /support-email/resend` in `inbound-http.ts`, verifying the Svix
  signature and deduping on the Resend `email_id`. The HTTP server now starts whenever email
  intake is configured, independent of the Slack mode. Orchestration lives in
  `src/intake/email-bridge.ts`; the pure ported logic (Svix verify, id derivation, parsing,
  formatting) in `src/intake/email-resend.ts`.
- **Config:** settings, not env vars — `chat.email` (`resendApiKey`, `resendWebhookSecret`,
  `channel`, optional `supportAddress`) in `$PASEO_HOME/config.json`, edited from the app's
  Settings → Office chat → Email intake section. Feature enabled only when the required trio
  is present; partial config warns and disables.
- **Binding model:** each new email conversation posts an announcement into the configured
  Slack channel, and that Slack thread becomes the primary `inbound-session` binding — all
  existing relay/mute/permission/steering machinery works unchanged, and replies in the Slack
  thread steer the same agent via the normal subscribed-message path. A persisted `emailLinks`
  map (`thread-session-store.ts`) resolves email external ids to that binding.
- **Thread linking by email semantics:** threads key off `Message-ID`, `In-Reply-To`,
  `References`, and a `conversation:<sender>:<normalized-subject>` fallback (lookup-gated to
  internal-sender forward-like emails), so an email reply continues the same agent. If a
  matched id is among the email's _own_ ids, it's a webhook redelivery → dedup, not a
  follow-up turn.
- **Fetch + parse:** the full message and attachments come from the Resend API; attachments
  store under the bridge state dir, images ride the native `images` path.
- **Prompt assembly:** the formatted email feeds the office-prompt structure with an
  email-specific source instruction plus a built-in generic triage instruction; operator
  customization stays in the office prompt.
- **Reply path:** agent output relays to the linked Slack announce thread, never back to the
  sender by email; outbound email reply is explicitly out of scope (Chat SDK has no email
  adapter).

### 5. Health / config endpoint — **v1 (trivial)**

A diagnostics surface for setup. v1 ships it as a **bridge log line + a `paseo`-style status
the operator can read** (is the daemon reachable? is Slack connected via Socket Mode? what's
the bot user id? which workspace folder + provider is configured?). When the v2 `inbound-http`
server exists, promote it to a real `GET /health` route that also reports the computed webhook
URLs.

### 6. Agent-initiated chat — **v2**

The office agent can explicitly contact people or channels through `chat.*` tools without raw
Slack APIs/tokens. This is v2 scope: `chat.send` posts text and/or files through Chat SDK and
persists an `outbound-conversation` binding so replies go back to the same office agent;
`chat.ask` adds pending waits with timeout/cancel/restart semantics. The office agent can use
executor MCP to discover channels it can access, then pass those destinations to the chat tools.

Chat tools intentionally do **not** create agents. If the office agent needs a new workspace/agent
in a project, it uses the normal Paseo agent/workspace tools; the bridge keeps the same chat thread
pointed at the office agent. Every outbound chat tool call records an audit entry.
Ordinary assistant text is not interpreted as a request to DM someone.

## Standing work (routines)

The office agent can set up its own recurring work — "every weekday at 9am Pacific post a
status of open threads", "watch these channels and summarize daily", "ping me when PR #482's CI
finishes" — _itself_, via its `create_schedule` / `create_heartbeat` Paseo tools. Nothing in the
bridge is required for this, so it's not a bridge feature. One gotcha the office prompt should
encode: **schedules default to UTC** — the agent must require an explicit timezone ("9am
Pacific") and confirm the scheduled time back, since "9am" alone is ambiguous.

## Office system prompt — **v1**

Slack-created office agents receive durable bridge behavior as a provider `systemPrompt`, since
the bridge offloads routing and delivery decisions to the agent:

```
systemPrompt:
  <base intake instructions>          ← hardcoded bridge constant
  <Slack relay-mode instructions>     ← auto/manual delivery contract
  <custom office prompt>              ← from config (promptPath)

initialPrompt:
  <captured thread context, if any>
  <per-message source line>
  <sender>: <the actual message text>
```

Set the custom prompt with `PASEO_CHAT_OFFICE_PROMPT_PATH`; the office deployment uses the structured office-repo path `/home/olumbe/code/office/prompts/chat/slack-office-agent.md`.

The custom office prompt is where you encode the operator's identity and guardrails, e.g.:

- "You are my office-of-CTO agent with full org context."
- "Use your `executor` MCP for external systems (Google Sheets, GitHub, CRM, …)."
- "Use Paseo tools (`create_worktree` + `create_agent`) to delegate code changes to a coding
  subagent **only when a task genuinely needs isolated edits** — don't cut a worktree for
  reading, analysis, or one-off inspection."
- "Ask for confirmation before destructive or external write actions."
- "Summarize actions clearly back to the thread."

The per-message initial prompt should carry only message-specific context. Do not put durable
Slack delivery rules there; update the system prompt builder instead.

## Default provider — **v1**

The bridge creates every office agent with a single configured default: **provider `pi`**, with
a backing model of **Codex `gpt-5.5` (medium)**. There is no per-message model selection — no
inline `[codex]`/`[claude-opus]` routing tags. If a task needs a different model, the office
agent chooses it _itself_ when it spawns a coding subagent (`create_agent` with a different
provider/model), exactly as it decides everything else. The bridge's job is transport, not
model routing. The default is config (`provider` / `model` / `modeId` in `config.ts`) so it can
be changed in one place.

## Attachments — **v1 inbound images/files / v2 outbound files**

Inbound (v1): read Slack image/file attachments via Chat SDK's `attachment.fetchData()` and pass
images through `images` and non-image files through `attachments` as local `uploaded_file`
references — **not** via raw `files.info` + bot token. If an attachment cannot be fetched, include
its name/type/URL in the prompt as text. Outbound (v2): agent-produced files post back with
`thread.post({ files: [{ data, filename }] })` — e.g. a generated report, diff, or screenshot.
Both directions stay inside Chat SDK per the hard constraint above.

## Optional routing (not core)

t3code's multi-repo **intake profiles** and **LLM route classification** are deliberately
**not part of the core model**. A single office agent on the office repo can already reach every
project and decide what to do. These are listed only as _optional v2 add-ons_ if one office
agent proves insufficient (e.g. you want different default providers/prompts per channel, or
strict per-channel isolation):

- **Channel/alias → agent config** map: pick provider/model/office-prompt/workspace-folder by
  channel or an inline alias. This is config, not a bridge-owned router.
- **LLM classification** of which config to use when none is named. Lowest priority; explicit
  alias/tag always wins; the default office agent is the fallback.

If added, this must not reintroduce bridge-owned worktree creation or "run vs build"
classification — those remain agent decisions.

## Slack output relay (timeline polling, no streaming)

Slack v1 intentionally does **not** display intermediate assistant/tool output: native Slack
streaming can show confusing error chrome, and partial messages are too noisy for the desired
thread UX. Relay behavior is selected by `PASEO_CHAT_RELAY_MODE`:

- `auto` (default): the bridge polls the daemon timeline and automatically posts first/final
  assistant text to the bound Slack thread.
- `manual`: the bridge never auto-posts assistant text; the office agent must call `chat.send`
  to send Slack-visible text and/or files.

In `auto` mode, the bridge posts only two kinds of normal thread replies:

1. The first complete assistant text block for the turn.
2. The final assistant text block after the agent reaches a terminal state.

If the first and final text are identical, the bridge posts once. Tool calls, reasoning, plan
updates, and partial assistant chunks are never posted to Slack.

**How it works.** For Slack-originated turns, `bridge.ts` records the timeline sequence number
before sending the prompt. For UI-originated turns on an agent that is linked to a Slack thread,
the bridge observes `turn_started` and starts the same relay. A background relay polls
`fetchAgentTimeline(..., { projection: "canonical" })` for assistant messages at or after that
sequence. It posts the first complete assistant block once it is no longer the newest row (or
the agent has stopped), then keeps polling until the office agent is no longer
`initializing`/`running` and posts the last assistant block as the final reply. Auto-relay posts
are audited in the chat bridge state. If the office agent explicitly posts to the same binding
with a `chat.*` tool while an auto relay is active, that tool post suppresses the active auto
relay for the turn so Slack has one source of truth.

If native Slack streaming is ever reintroduced, it must be behind an explicit product decision
and preserve the reply contract above: no top-level messages, no duplicate final text, and no
Slack error chrome exposed as the primary response.

## Permissions → chat buttons — **v1**

When an agent needs approval the daemon emits `agent_permission_request`. The bridge:

- Listens on `client.on("agent_permission_request", …)`; the request carries `actions[]`
  (each `{ id, label, behavior, variant }`) which map 1:1 to Slack buttons posted as normal
  Chat SDK card/action messages.
- On click, resolves with `client.respondToPermission(agentId, request.id, { behavior,
selectedActionId })` — for the office agent.
- The `question` permission kind is also how interactive "agent asks the user a question"
  flows surface (t3code's `user-input.requested`).
- To guarantee prompts fire, create office agents with a permission-prompting mode (Claude
  `modeId: "default"`, not `bypassPermissions`; Codex avoid `full-access`). This matters more
  here than in t3code because the office agent takes **external actions** (Sheets, CRM), not
  just code edits — confirmation gating is the safety boundary.

## Intake & relay mechanics

The smaller, non-obvious behaviors that make the bridge robust — distilled from t3code's
`ExternalChat.ts` / `ExternalIntake.ts` / `Reactor.ts`. These are correctness/quality details;
skipping them produces double-posts, loops, or dropped messages. Most are **v1**.

### Concurrency & idempotency — **v1 (correctness-critical)**

- **Short serial intake, background relay.** Construct the Chat SDK bot with
  `concurrency: "queue"` so state updates for the same thread process in order, but keep the
  handler short: dedupe, mutate state, send the message to the daemon, start a background relay,
  and return. Do not wait for the agent turn inside the Slack handler; otherwise follow-up
  Slack replies cannot interrupt an active turn.
- **Inbound dedup, two layers.** (a) Chat SDK's own `dedupeTtlMs` (~10 min) drops Slack's
  webhook retries; (b) our own **event receipts** keyed `slack:<externalThreadId>:<messageId>`
  short-circuit anything already processed.
- **Outbound delivery receipts + active relay guard.** Before _every_ post, check a
  delivery-receipt key (encodes source, phase, threadId, turnId, messageId). Skip if already
  `completed`. Each session also stores `activeRelayId`; background relays must re-read the
  session before posting and drop stale output if a newer Slack message has superseded them. On
  bridge startup, persisted sessions are inspected and any running/stale relay is resumed with a
  final-only recovery relay, so an agent that finishes after a bridge restart still posts its
  completion back to Slack. This prevents double-posting after retries and prevents interrupted
  turns from posting stale final answers.
- **Per-thread lock.** A short-TTL lock per thread (the in-process mutex from the
  `StateAdapter`) guards the read-modify-write of thread state.

### Loop prevention & message filtering — **v1**

- **Ignore the bot's own and other bots' messages** (Chat SDK's Slack adapter handles the
  `bot_message` subtype; don't re-emit our own posts as intake).
- **Exclude bot/own messages from captured thread context** so the agent isn't fed its own
  prior replies.
- **"Mentions another user" gate (channels only):** if a channel message @-mentions a human
  who isn't the bot, ignore it. DMs bypass this.
- **Ambient-message gate (channels only):** with no existing thread link and no bot mention,
  ignore. In a DM, every message counts as addressed to the bot.

### Channel vs DM differences — **v1**

DMs are more permissive than channels: they skip the "mentions another user" and ambient
gates, and thread-context capture only applies to threaded channel replies, not top-level DMs.
Treat `mpim` (group DM) like a channel, not a DM.

### Inbound text cleaning — **v1**

Before building the prompt, clean the message: strip the bot's own mention (`<@U…>` / `@U…`), resolve other Slack user mentions to readable handles/names, strip client attributions, fetch Slack attachments through Chat SDK, pass images through the native `images` path, pass fetched non-image files as `uploaded_file` attachments, and append unfetchable non-image attachments as `Attachments:\n- name (mime): url` text lines. Keep a separate raw-text copy for mention-detection/routing vs. the cleaned text sent to the agent.

### Output relay rules — **v1**

- **First + final assistant replies per user turn.** Do not post intermediate assistant/tool chunks. Poll the projected daemon timeline, post the first complete assistant text block, then post the final assistant text block when the agent stops. If they match, post once.
- **No message editing for replies** — assistant relay always posts a normal thread reply; we
  don't hand-edit prior posts.
- **Outbound dedup:** delivery receipts prevent re-posting after retries/restarts.
- **Slack-friendly response style:** the office prompt tells agents to use short Slack-friendly Markdown, prefer bullets over tables, mention people by handle only when notification is intended, and never emit raw Slack IDs / `<@U…>` syntax unless explicitly asked.
- **Markdown fix-ups for Slack:** flatten markdown tables into Slack-readable bullet lists and wrap
  `@scope/package` in backticks so Slack doesn't turn them into mentions.
- **Decide Slack-message chunking** since Slack has block limits (t3code applied no hard length
  cap on assistant text; only context/preview fields were truncated).

### Agent errors & question/answer flow — **v1**

- **Start failure → posted.** If creating/continuing an agent throws, post
  `"I couldn't start a task from this message. Reason: <message>"` to the thread.
- **Turn failure (`status: "error"`):** post a short "the agent hit an error" line when timeline polling observes the agent stopped in an error state.
- **Office agent asks a question** (`agent_permission_request` kind `question`): post a numbered
  question card; the user's next thread reply is the answer (strip `<@…>`; support
  single-answer-applies-to-all vs `Q1: … Q2: …`). Rides the same permission plumbing as buttons,
  against the office agent.

### Subscription lifecycle — **v1**

Call `thread.subscribe()` at the start of processing every message (idempotent), so follow-up
replies route via `onSubscribedMessage`. The subscription set is persisted (our
`StateAdapter`), so a restart doesn't stop the bot following live threads.

### Workspace, worktree & title details — **v1**

- **Office workspace:** `createWorkspace({ source: { kind: "directory", path: <chat repo> } })`
  where `<chat repo>` is the workspace marked as the chat repo from the Paseo workspace sidebar
  menu. No branch, no base-ref refresh, no setup script runs at intake.
- **Worktrees are agent-initiated only.** When the office agent decides to delegate code work,
  _it_ calls `create_worktree` (Paseo's worktree workflow handles branch creation, base-ref
  refresh, and any repo setup). The bridge does not pass `worktreeSlug` or `baseBranch` at
  intake.
- **Thread title seed:** derive the office agent's workspace/agent title from the first line of
  the message (cap ~120 chars); follow-ups keep the original title.

### Deep links — **v1**

Build a link back to the office agent in the Paseo app/web UI (`/h/[serverId]/workspace/[workspaceId]?open=agent:[agentId]`)
for the compact "Working on it" card and its `View chat` affordance. Needs a configured app base
URL. The bridge links to the owning office workspace and does not link directly to child agents from chat.

## Proposed package layout (design sketch — not built)

```
packages/chat/
  package.json            # @getpaseo/chat, private, ESM; deps: chat, @chat-adapter/slack,
                          #   @getpaseo/client, @getpaseo/protocol, ws — no DB/Redis dependency
  tsconfig.json           # extends ../../tsconfig.base.json, NodeNext (cli pattern)
  src/
    index.ts              # boot: load config, connect daemon, construct Chat + adapters, register handlers
    config.ts             # env: officeRepoPath (the office repo), provider (default pi), model
                          #   (default codex gpt-5.5), modeId (default medium), ackEmoji,
                          #   officePromptPath, deepLinkBaseUrl, daemon host/password, stateDir
                          #   (Slack tokens are read by @chat-adapter/slack, not by us)
    paseo-client.ts       # connect() helper mirroring packages/cli/src/utils/client.ts (reconnect: enabled)
    bridge.ts             # core: handleMessage — filters/gates, new-thread vs follow-up, dedup,
                          #   timeline-polling output relay
    state/
      json-state.ts       # [v1] shared atomic JSON load/save + write-queue (mirrors loop-service.ts)
      chat-state-adapter.ts # [v1] file-backed Chat SDK StateAdapter (subscriptions/cache persisted; locks in-process)
      thread-session-store.ts # [v1] domain store: ChatBinding/ThreadSession (inbound-session,
                          #   outbound-conversation), pending asks, event + delivery receipts, artifacts
    render.ts             # Slack markdown fix-ups for projected assistant text
    permissions.ts        # agent_permission_request → buttons (kind tool) / question card (kind question)
    intake/
      slack.ts            # [v1] Slack glue: mute/aside parsing, attribution strip, context capture, reactions,
                          #   channel-vs-DM gates, mentions-other-user filter, answer normalization, sender identity
      routing.ts          # [v2, optional] channel/alias → agent config (NOT a worktree/repo router)
      github-webhook.ts   # [v2] PR-merged notifications (needs inbound-http)
      email-resend.ts     # [v2] inbound email receiver + parser
    inbound-http.ts       # [v2] public HTTP server hosting webhook/email/health routes
  README.md               # operational setup (Slack app scopes, Socket Mode tokens, env)
```

The package `README.md` would be operational setup; this doc is the system-level design. The
`[v1]/[v2]` tags show when each module lands. State (both Chat SDK's and ours) is
**file-backed, following Paseo's own persistence pattern** — no external database — see
"State storage".

## Architecture additions per phase

**v1** is exactly the diagram in [Core concept](#core-concept-the-bridge-is-just-another-daemon-client):
an outbound-only process (`DaemonClient` over `127.0.0.1`, Slack over Socket Mode), file-backed
state, and the timeline-relay/render/permissions glue. No inbound listener, no HTTP server,
no database.

**v2 introduces an inbound HTTP server (`inbound-http.ts`).** This is the one structural
change in the project's life: the bridge goes from purely outbound to also _accepting_
requests. It hosts the GitHub webhook, the Resend email webhook, the promoted `/health` route,
It must run behind TLS / a tunnel with per-route signature verification (HMAC for GitHub, Svix
for Resend). v2 also adds the optional routing config, a second Chat SDK adapter, and remote
(relay+E2EE) mode. The bridge stays a **single process** — running multiple instances is
explicitly a non-goal.

## State storage

State management is **proper from day 1, with no external database** — it follows Paseo's own
file-based persistence pattern (atomic JSON writes + Zod validation under `$PASEO_HOME`, see
[data-model.md](data-model.md)). Zero new runtime dependencies (no Redis, no Postgres).
Durability and atomic writes do not require a database for a single-process service; the only
thing a database would add — coordination across multiple processes — is something the bridge
deliberately does not need (it runs as one process; multi-instance is a non-goal).

There are **two logical state stores, both file-backed:**

1. **Chat SDK's own state — a custom file-backed `StateAdapter`** (`chat-state-adapter.ts`)
   passed as `state:` to the `Chat` constructor. Chat SDK defines a small `StateAdapter`
   interface (~11 methods); we implement it instead of pulling in `@chat-adapter/state-redis`:

   | StateAdapter method                                                            | File-backed implementation                                                                          |
   | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
   | `connect()` / `disconnect()`                                                   | no-op (or open/flush the JSON file)                                                                 |
   | `subscribe` / `unsubscribe` / `isSubscribed(threadId)`                         | a persisted `Set<threadId>` in JSON                                                                 |
   | `get<T>` / `set<T>(key,value,ttlMs?)` / `delete(key)`                          | JSON KV storing `{ value, expiresAt }`; lazy-expire on read                                         |
   | `acquireLock(threadId, ttlMs)` / `releaseLock` / `extendLock` → `Lock \| null` | **in-process keyed async mutex** (returns a `{ threadId, token, expiresAt }` `Lock`); not persisted |

   Locks exist to stop two _processes_ double-handling one event; with a single process an
   in-memory mutex is the complete, correct implementation. Subscriptions and cache **are**
   persisted, so a restart never loses which threads the bot follows.

2. **Our domain store** (`thread-session-store.ts`) — the bridge's own data:
   `externalThreadId → ChatBinding`, pending `chat.ask` waits, event-receipt dedup keys,
   outbound delivery receipts, audit records, and (v2) PR artifact links. Keep the logical tables
   t3code used (`external_thread_links`, `external_event_receipts`, `artifact_links`) as JSON
   collections, but make the domain shape explicit: inbound sessions have `rootAgentId`; outbound conversations have `officeAgentId`,
   `subscribed`, and optional `pendingRequestId`.

**Implementation — reuse Paseo's primitives, don't reinvent:**

- **Atomic writes:** use `writeJsonFileAtomic` from `packages/server/src/server/atomic-file.ts`
  (temp-file + rename), or copy the ~20-line helper into `state/json-state.ts`.
- **No torn concurrent writes:** serialize saves through an in-memory write queue, exactly as
  `loop-service.ts` does.
- **Validation:** Zod schema per store, parsed on load, with optional-field defaults for
  forward-compat (Paseo's no-migrations convention).
- **Templates to copy:** `packages/server/src/server/schedule/store.ts` and
  `push/token-store.ts` are the closest existing single-file stores.
- **Location:** under `$PASEO_HOME/chat-bridge/` (e.g. `state.json`, `chat-sdk-state.json`),
  or a configurable `stateDir`.

**Cost / risk:** ~150–250 lines total, zero new dependencies. The one external coupling is the
Chat SDK `StateAdapter` interface — Chat SDK is beta, so **pin the version** and treat an
interface change as a small, contained fix.

## Flow (v1, Slack, timeline polling)

**New thread** (`bot.onNewMention` / `onDirectMessage`):

1. Dedup on `eventId`; if seen, stop.
2. `thread.subscribe()`.
3. Resolve sender identity; capture human-thread context if present.
4. `client.createWorkspace({ source: { kind: "directory", path: <office repo path from config> } })`.
5. `client.createAgent({ provider: "pi", model: "openai-codex/gpt-5.5", modeId: "medium", workspaceId, initialPrompt, images, labels: { "paseo.chat-thread-id": externalThreadId, "paseo.chat-source": "slack" } })`
   (provider/model/mode come from config; the default is Pi + Codex gpt-5.5 medium).
6. Persist `ThreadSession { rootAgentId: agentId }`; react `:eyes:` on
   the triggering message; post the compact "Working on it" card with a `View chat` button.
7. Poll the office agent's projected timeline. Post the first complete assistant text block,
   keep polling until the agent stops, then post the final assistant text block. If the agent
   spawns a coding subagent mid-turn, the bridge does not track or relay that child; the office
   agent remains responsible for summarizing progress back to Slack.

**Reply** (`bot.onSubscribedMessage`): dedup → look up `ThreadSession` (respect `muted`, except explicit bot mentions bypass mute) →
`client.sendAgentMessage(rootAgentId, text)` → poll projected timeline → post first complete assistant text and final assistant text.

**Permission mid-turn:** office-agent permission requests are posted as standalone buttons/cards;
the click handler calls `respondToPermission` on the office agent, the agent continues, and the
bridge still posts only the first complete assistant text and final assistant text for the turn.

## Research gotchas to preserve

- **Use the low-level `DaemonClient`, not the `PaseoClient` facade.** Import from
  `@getpaseo/client/internal/daemon-client` (as the CLI does). The bridge needs timeline
  fetching, permission handling, and agent-control RPCs in one place.
- **Workspace creation for the office agent is `directory`-backed.** Use
  `createWorkspace({ source: { kind: "directory", path } })` and pass the resulting
  `workspaceId` into `createAgent`. Worktree creation is **not** done by the bridge — it's a
  Paseo tool (`create_worktree`) the agent calls.
- **The agent owns task decisions.** Routing, tool selection, worktree-vs-no-worktree,
  Sheets/GitHub/etc. all happen inside the agent (via `executor` MCP + Paseo tools). Do not
  rebuild any of this in the bridge.
- **No assistant text deltas.** Assistant output in the projected timeline arrives as complete
  `assistant_message` rows. Poll the timeline and post only complete blocks; never relay
  partial text.
- **Turn relay is timeline-polled.** Capture the timeline sequence before sending a prompt,
  then poll projected timeline entries at or after that sequence. Agent status from the
  timeline tells the bridge when the final assistant block is ready.
- **Subagent relationship stays in Paseo, not chat.** Spawned coding agents carry
  `paseo.parent-agent-id` (set by `create_agent` with `relationship: { kind: "subagent" }`) so
  the Paseo UI can show them in the office agent's subagents track. The chat bridge does not
  observe them as chat targets or stamp them with chat labels.
- **Permissions are low-level only.** Listen on `agent_permission_request`; resolve via
  `respondToPermission(agentId, request.id, { behavior, selectedActionId })`. Pending requests
  also appear on `AgentSnapshotPayload.pendingPermissions`.
- **Do not use Chat SDK native streaming for assistant replies.** Post normal messages with
  `thread.post({ markdown })` / `adapter.postMessage(...)` only, so Slack never shows partial
  chunks or streaming error chrome.
- **Chat SDK is the only Slack client — no raw token calls.** Reactions, cards, posting, file
  upload (`thread.post({ files })`), and inbound attachment reads (`attachment.fetchData()`)
  are all native. Do not replicate t3code's raw `files.*` / `url_private` paths.
- **Monorepo fit:** `@getpaseo/chat`, ESM, `module`/`moduleResolution: NodeNext`, tests via
  `vitest`. Tooling is **oxlint + oxfmt**. Add `build:chat` after `build:client`.
- **`@getpaseo/client` is "not a stable SDK"** — the bridge lives in-monorepo to move in
  lockstep rather than break as an external consumer.
- **t3code reference, not import.** Reuse its intake _mechanics_ and feature decisions, not its
  code or its coding-only/worktree-per-thread model. The Paseo bridge re-expresses the
  mechanics against the daemon and replaces the model with the office-agent design above.

## Reference pointers

- [architecture.md](architecture.md) — client/daemon model, WebSocket protocol, agent lifecycle.
- [agent-lifecycle.md](agent-lifecycle.md) — subagents, `paseo.parent-agent-id`, the subagents
  track, parent/child status and archive cascade (the basis for the UI model).
- `packages/cli/src/utils/client.ts` — the daemon connection pattern to mirror.
- `packages/cli/src/commands/agent/run.ts` — create-agent sequence (note: the office agent uses
  a `directory` workspace, not the run command's worktree path).
- `packages/server/src/server/agent/tools/paseo-tools.ts` — the tool catalog the office agent
  uses to delegate (`create_worktree`, `create_agent`, terminals, schedules, …).
- `packages/protocol/src/messages.ts` — `WorkspaceCreateRequest` (`source.kind`),
  `AgentStreamEventPayload`, `AgentTimelineItem`, `ToolCallDetail`,
  `AgentPermissionRequest`/response schemas.
- `packages/client/src/daemon-client.ts` — `DaemonClient` methods: `createWorkspace`,
  `createAgent`, `sendAgentMessage`, `waitForFinish`, `on(...)`, `respondToPermission`.
- `affil-ai/t3code` `apps/server/src/externalIntake/` — prior implementation, mined for intake
  mechanics only: `ExternalChat.ts` (Slack callbacks), `ExternalIntake.ts` (tags, mute),
  `Reactor.ts` (output relay), `http.ts` (webhook routes + signature verification).
- Chat SDK posting docs — normal `thread.post({ markdown })` / `adapter.postMessage(...)` replies.

## Decisions (resolved)

- **The bridge is a transport adapter, not an orchestrator → v1.** It does intake, thread↔agent
  mapping, timeline-polled output relay, and permission relay. Routing/tools/worktree decisions live
  in the agent. This is the core model change from t3code.
- **One thread = one workspace = one office agent on a configured `directory` folder → v1.**
  No per-thread worktree, no per-repo profiles, no classifier. The office repo sits alongside
  the other product repos; the agent reaches across them.
- **Worktrees are agent-initiated → v1.** The agent calls `create_worktree` + `create_agent`
  only when a task needs isolated code changes.
- **Office-agent-only chat boundary → v1.** The bridge never routes Slack replies to child
  agents, never polls child timelines, and never tracks active child work. Subagents remain normal
  Paseo UI/lifecycle objects owned by the office agent.
- **UI surfacing → v1.** The office repo is a Project; each thread is a `directory` workspace;
  coding subagents appear both in the office agent's subagents track and as a worktree workspace
  under the real repo's project. The bridge stamps `paseo.chat-thread-id` only on the office
  agent; child grouping comes from `paseo.parent-agent-id`.
- **Teardown policy → v1.** A thread's office agent is archived (`client.archiveAgent`) and its
  store entry dropped on an explicit `@bot done` / thread-archive signal or when it reaches a
  terminal `closed` state. Idle agents are left alive so a later reply can resume them. Archive
  cascades to subagents (`agent-lifecycle.md`). **Teardown is also the office brain's capture
  trigger** — before archiving, the office agent writes what was decided/done/learned into its
  memory; see [office-brain.md](office-brain.md).
- **Output noise → v1 default, tunable.** Stream `assistant_message` text always; render
  `tool_call`s as `task_update` cards with `groupTasks: "plan"`; **suppress `reasoning` by
  default** (config flag to show it).
- **Error surfacing → v1.** Post both start failures and turn errors as short thread messages.
- **State backend → file-backed from v1, no database, ever (single-process design).** Custom
  file-backed Chat SDK `StateAdapter` + our own JSON `thread-session-store`, both using
  `writeJsonFileAtomic` + Zod.
- **Multi-repo profiles + LLM routing → dropped from the core model; optional v2 only.** A
  single office agent suffices; routing is config (channel/alias → agent config), never a
  bridge-owned worktree/repo router. See [Optional routing](#optional-routing-not-core).
- **Public-inbound hosting → v2.** v1 is Socket Mode only. The `inbound-http` server arrives in
  v2 behind TLS/a tunnel with per-route signature verification.
- **Sender identity + multiplayer steering → v1.** The bridge resolves the Slack sender per
  message and prepends an identity block; anyone in the channel can steer the office agent.
  See [Sender identity](#sender-identity--v1) and [office-brain.md](office-brain.md).
- **Shared-channel access posture → principles now, enforcement v2.** Adopt Claude Tag's
  Agent-Proxy principles without building a proxy: (a) the office agent runs in a
  **confirm-first permission mode** for external writes (Claude `modeId: "default"`, not
  `bypassPermissions`) so destructive Sheets/CRM/code actions surface as Slack buttons; (b)
  credentials live in `executor` MCP / the daemon, **never echoed to the channel or the model's
  output**; (c) for a 4-person startup the channel membership _is_ the allowlist — a per-channel
  user allowlist and a default `plan`-only mode for any _public_ channel are a v2 config knob.
  Attribution is clean by construction: actions are logged in the Paseo agent timeline (the
  "Open in Paseo" link) and tagged with the resolved sender.

## Prior art: Claude Tag

Anthropic's [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) (Jun 2026) is
the hosted version of this bridge: `@Claude` in a Slack channel starts a working session that
streams a checklist back into the thread, remembers channel context, runs scheduled routines,
and acts through admin-connected tools. It validates the whole direction (reportedly 65% of
Anthropic's product team's code, and spreading to metrics/support/incident work). What this
design borrows vs. where it diverges:

**Borrow:**

- **Multiplayer threads** — a session belongs to the channel, anyone can steer (now
  [v1](#multiplayer-steering--v1)).
- **Routines vocabulary** — scheduled job / watch channels / follow-PR (the office agent does
  these itself; see [Standing work](#standing-work-routines)).
- **Read-only session record** — their "Open session in Claude" link is our
  `/h/[serverId]/workspace/[workspaceId]?open=agent:[agentId]` deep link, free from the daemon.
- **Agent-Proxy principles** — deny-by-default external access, credentials never exposed to
  the model, service-account-style attribution (folded into the access-posture decision above).

**Diverge (our differentiators):**

- **Local-first, not a hosted sandbox.** Work runs on _your_ daemon in _your_ `directory`
  workspace with _your_ keys — no Anthropic-hosted ephemeral sandbox, no inference markup, no
  vendor lock. This is the core product bet (`product.md`).
- **Multi-provider.** The office agent can be Pi/Codex/Claude/etc. and can spawn coding
  subagents on any provider; Claude Tag is Opus-only.
- **Inspectable memory.** Our brain is OKF markdown in git (diffable, portable,
  full-text-searchable) rather than an opaque per-channel store. See
  [office-brain.md](office-brain.md#prior-art-claude-tag).
- **One shared brain**, not per-channel memory — right for a small team where context should
  flow.

## Remaining open questions (genuinely undecided)

- **Concurrency caps:** should one channel/user be limited to N concurrent office agents to
  avoid runaway resource use? Likely a v2 config knob.
- **Second adapter choice for v2:** Discord vs Telegram first — driven by which you actually
  use.
