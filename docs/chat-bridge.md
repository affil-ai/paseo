# Chat Bridge (Slack / Chat SDK) — Scoping

> **Status: scoping / not yet implemented.** This doc captures the design and research
> for a future `packages/chat` bridge so the thinking is tracked. No package, code, or
> config exists yet. Treat every "the bridge does X" below as "the bridge would do X."
> Work is scoped across three phases — see [Release roadmap](#release-roadmap) — and each
> feature is tagged **v1** / **v2** / **v3** with a concrete scope, not deferred to "later."

## Goal

Let you drive Paseo agents from chat platforms — Slack first, others later — the same way
you drive them from the mobile app today. You @-mention a bot, it starts an agent, and the
agent's work **streams** back into the thread in real time; replies in the thread continue
the conversation.

The platform-agnostic layer is [Chat SDK](https://chat-sdk.dev) (`chat` core +
`@chat-adapter/*` adapters), which unifies Slack, Discord, Telegram, Teams, Google Chat,
etc. behind one API. One codebase, many platforms.

### Prior art: `affil-ai/t3code`

There is an existing, working implementation of this exact idea in the private repo
`affil-ai/t3code` (`apps/server/src/externalIntake/`). It bridges Slack + email + GitHub
into coding-agent runs using **the same Chat SDK**. This doc deliberately mines t3code for
its feature set and maps each feature onto Paseo's daemon. Two things to carry forward and
one to improve:

- **Carry forward:** its intake feature set (channels, dedup, thread linking, profiles,
  model-routing tags, LLM route classification, mute/unmute, attachments).
- **Improve:** t3code relays agent output to Slack as a **"first message + final message"**
  pair — it does **not** stream. The Paseo bridge should use Chat SDK's **native Slack
  streaming** (`thread.post(asyncIterable)`) so the thread updates live as the agent works.

## Hard constraint: Chat SDK is the _only_ Slack client

All Slack interaction goes through Chat SDK (`chat` + `@chat-adapter/slack`). The bridge
must **never** call the Slack Web API directly or hold a raw `SLACK_BOT_TOKEN` fetch path.
Everything we need is native to Chat SDK:

| Need                       | Chat SDK API (use this)                                              |
| -------------------------- | -------------------------------------------------------------------- |
| Listen for mentions/DMs    | `bot.onNewMention`, `bot.onDirectMessage`, `bot.onSubscribedMessage` |
| Listen for emoji reactions | `bot.onReaction([...], handler)`                                     |
| Post / stream a message    | `thread.post(content \| asyncIterable)`                              |
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

## Mapping model

- **One chat thread = one Paseo agent = one worktree.**
- Each new thread cuts a fresh worktree from a configured repo + base branch. v1 uses a
  single default repo; multi-repo routing is a scoped follow-up (see Feature: intake profiles).
- The bridge is a **standalone, long-lived Node process** running beside the daemon.

### How t3code concepts map onto Paseo

t3code is built on Effect-TS with its own orchestration engine; Paseo has the daemon. The
translation is direct:

| t3code (Effect orchestration engine)                      | Paseo equivalent (daemon)                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `orchestrationEngine.dispatch({ type: "thread.create" })` | `client.createWorkspace({ source: { kind: "worktree", … } })`       |
| `thread.turn.start` (initial prompt / follow-up)          | `client.createAgent({ initialPrompt })` / `client.sendAgentMessage` |
| `Thread` / `ThreadId` (a run)                             | a Paseo **agent** (`agentId`)                                       |
| `streamDomainEvents` + `Reactor` subscriber               | `client.on("agent_stream", …)`                                      |
| `thread.message-sent` (assistant)                         | `agent_stream` → `timeline { item.type: "assistant_message" }`      |
| `thread.activity-appended` → `user-input.requested`       | `agent_permission_request` (kind `question`)                        |
| `thread.session.status` (running/ready/stopped/error)     | `agent_update` status (`running`/`idle`/`error`) + `waitForFinish`  |
| `ExternalIntegrationRepository` (SQLite tables)           | `thread-agent-store` (file-backed JSON) + dedup/link tables         |
| temporary worktree branch `t3/tmp/<hex>`                  | `createWorkspace` worktree `worktreeSlug` from thread id            |

## Release roadmap

Three shipping phases. v1 is a self-contained, useful product on its own; v2 and v3 are
additive and do not require reworking v1.

### v1 — "Slack drives one agent per thread" (Socket Mode only, no inbound HTTP)

The complete single-repo Slack experience. Everything here works behind Socket Mode, so it
needs **no public URL** and no hosting beyond the box the daemon runs on.

- Slack intake: mentions, DMs, subscribed-thread follow-ups (Feature 1).
- One thread = one agent = one worktree off a single configured repo + base branch.
- Native Slack streaming of each turn (assistant text + tool-call task cards).
- `:eyes:` + configurable project emoji reactions; "task started" card with a deep link.
- Permission prompts → Slack buttons; agent **questions** → numbered card answered by reply.
- Mute / unmute / `aside -` (Feature 2).
- Model-routing tags `[codex]`/`[claude-opus]`/… (cheap power-user ergonomics).
- Assembled initial prompt with a configurable custom agent-instruction block.
- Inbound image attachments → agent.
- Health/config command (Feature 6).
- Start-failure and turn-error messages surfaced to the thread.
- The intake & relay mechanics below: serial-per-thread queue, inbound dedup + **outbound
  delivery receipts**, loop/mention/ambient filtering, channel-vs-DM rules, text cleaning,
  Slack markdown fix-ups, subscription lifecycle, branch/title derivation.
- Idempotency, thread linking, and restart-resilient state (file-backed store).

**v1 exit criteria:** from Slack you can start an agent, watch it work live, answer its
permission prompts, reply to continue it, and mute it — across a daemon or bridge restart.

### v2 — "Multi-repo + webhooks + richer I/O" (introduces a public inbound HTTP server)

The phase that turns the bridge from a single-repo toy into a team tool. The defining new
capability is a **public inbound HTTP listener** (the daemon/bridge is otherwise outbound-
only), which unlocks the webhook-driven features. v2 delivers:

- **Multi-repo intake profiles** — route a message to one of several repos (Feature: profiles).
- **LLM route classification** — pick the repo and "run vs build" provider automatically
  (Feature: classification).
- **PR-merged notifications** — GitHub webhook → `:white_check_mark:` + "merged" message
  (Feature 3).
- **Inbound email intake** (Resend) as a second channel feeding the same pipeline (Feature 4).
- **Bidirectional file attachments** — agent-produced files posted back to the thread.
- **Second chat adapter** (Discord or Telegram) to prove the platform-agnostic seam.
- **Remote deployment mode** — bridge on a different host than the daemon, connecting over the
  Paseo relay with E2EE (the same path the mobile app uses), instead of `127.0.0.1`.

**v2 exit criteria:** a message in any configured channel routes to the right repo, an agent
opens a PR, and the thread is notified when it merges; the bridge runs on a server separate
from the daemon.

### v3 — "Programmatic platform" (the bridge as an orchestration surface)

For when the bridge is itself a building block other systems drive. Still a **single
process** — horizontal scale / multiple instances is a non-goal (see "State storage").

- **Programmatic execution-bridge REST API** — create/continue/interrupt/status runs from an
  external orchestrator, with lifecycle callbacks (Feature 5).
- **Multi-daemon fan-out** — one bridge process fronting several daemons (route by channel or
  profile to a specific host's `DaemonClient`). This is one process talking to many daemons,
  not many bridge processes.
- **Scheduled / proactive intake** — cron-driven agent runs that post into a thread (mirrors
  Paseo's `schedule` + `loop` daemon features), e.g. a nightly triage that DMs a summary.
- **Richer interactivity** — slash commands (`/paseo run …`), modals for structured task
  intake, and reaction-driven actions (`:thumbsup:` to approve, `:x:` to cancel a turn).

## Feature set (external intake)

Scoped from t3code's `externalIntake/`. Each feature is mapped to the Paseo daemon and tagged
with the phase that delivers it (**v1** / **v2** / **v3**). Nothing is left as an open
"later" — every deferred item has a phase and a concrete scope below.

### 1. Slack bot intake — **v1**

The core feature. A bot that listens for and acts on:

- **Direct mentions** (`@bot <task>`) in any channel → starts a new agent + worktree.
- **DMs** → starts a new agent.
- **Subscribed-thread follow-ups** → replies in a thread already linked to an agent
  continue that agent (`sendAgentMessage`).

Chat SDK exposes these as `bot.onNewMention`, `bot.onDirectMessage`, and
`bot.onSubscribedMessage` (the three callbacks t3code registers in `ExternalChat.ts`).

Behaviors to bring across from t3code:

- **Idempotency / dedup:** build an `eventId = "slack:<externalThreadId>:<messageId>"` and
  skip already-processed events. t3code stores receipts in an `external_event_receipts`
  table; the Paseo bridge keeps the same in its store.
- **Thread linking:** `externalThreadId = [teamId:]channelId:threadTs` ↔ `agentId`. This is
  the bridge's central map (`thread-agent-store`).
- **Thread context capture:** on a fresh mention inside an existing human thread, gather
  prior messages (t3code caps at ~30 messages / ~8,000 chars) and prepend them to the
  initial prompt so the agent has context.

Auth: the `@chat-adapter/slack` adapter verifies the Slack signature and runs in Socket Mode
(no public inbound URL). Tokens are consumed by the adapter, not by our code.

#### Reactions on the triggering message — **v1**

When a new agent starts, the bridge reacts to the **original triggering Slack message** (not
a new post) to signal acknowledgement, exactly as t3code does in `ExternalChat.ts`:

1. Add `:eyes:` — "seen, starting work."
   `const sent = thread.createSentMessageFromMessage(message); await sent.addReaction(emoji.eyes)`.
2. If the routed project defines a **custom project emoji**, add it as a _second_ reaction on
   the same message (e.g. `:rocket:` for one repo). In t3code this is `profile.slackEmoji`
   (colons stripped on parse), used both as this reaction **and** as a routing alias (a
   message containing `:rocket:` routes to that profile). v1 (single repo) can hardcode one
   project emoji in config; multi-repo gets it per profile (see intake profiles).
3. On PR merge, add `:white_check_mark:` to the same message (see Feature 3).

All three are `addReaction` calls on a Chat SDK `SentMessage` / via `adapter.addReaction` —
no raw Slack call.

#### "Task started" card — **v1**

Immediately after creating the agent, post a card to the thread (Chat SDK `Card` / `CardText`
/ `Actions` / `LinkButton`). t3code's card:

- **Title:** "Talk to <bot> in this thread"
- **Body:** "I will keep replies here and link the session once it is available."
- **Button:** "Open" (primary) → deep link to the agent's session in the Paseo app/web UI,
  built from a configured base URL + `serverId` + `agentId`.
- **Fallback text** (non-card clients): the same, with the URL inline.

(Paseo deep links follow `/h/[serverId]/agent/[agentId]` per `docs/architecture.md`.)

### 2. Mute / unmute + per-message controls — **v1 (cheap, high-value)**

t3code lets a thread be silenced via `@bot mute` / `quiet` and re-enabled via `unmute` /
`resume replies`, with an `aside - <msg>` prefix to ignore a single message. Mute state is
persisted per thread. Cheap to implement and prevents the bot from being noisy in shared
channels. Store the flag alongside the thread link.

### 3. PR-merged notification — **v2 (first feature needing public inbound HTTP)**

When an agent opens a PR and it later merges, the bridge posts a completion message back to
the thread. t3code's mechanism, to mirror:

1. **Detect + record the PR.** Scan streamed agent `timeline` output for
   `https://github.com/<owner>/<repo>/pull/<number>` and store an artifact link
   `("github_pr", "<owner>/<repo>#<number>") → { threadId, url, title }` in the bridge store.
   (t3code: `extractGitHubPullRequests` + `repository.upsertArtifactLink` in `Reactor.ts`.)
2. **Receive the merge event.** A `POST /github/webhook` endpoint (verified with
   `GITHUB_WEBHOOK_SECRET`, HMAC-SHA256, deduped on `x-github-delivery`) listens for
   `pull_request` events where `merged === true`.
3. **Notify the thread.** Look up the linked thread, add `:white_check_mark:` to the original
   triggering message, and post a message. t3code's exact format:
   > `Merged noted. [PR #42: <title>](<pr-url>) is done.`

This is **notification-only** — it does not start an agent. The `:white_check_mark:` and the
post are pure Chat SDK (`adapter.addReaction`, `thread.post`). It's v2 because, unlike Slack
Socket Mode, the GitHub webhook needs a **public inbound HTTP endpoint** — the shared
`inbound-http` server v2 introduces (see "v2 architecture additions"). The artifact-link
recording (step 1) can land in v1 since it only reads the agent stream; the webhook receiver
(steps 2–3) ships with the HTTP server in v2.

### 4. Inbound email intake (Resend) — **v2**

A second intake channel: inbound support emails become agent threads. t3code's
`POST /support-email/resend` endpoint (Svix-signed via `RESEND_WEBHOOK_SECRET`) is the model.
Concrete v2 scope:

- **Receiver:** a `POST /support-email/resend` route on the v2 `inbound-http` server,
  verifying the Svix signature and deduping on the Resend `email_id`.
- **Fetch + parse:** pull the full message from the Resend API, extract `From`/`To`/`Subject`/
  body and download attachments.
- **Thread linking by email semantics:** key threads off `Message-ID`, `In-Reply-To`,
  `References`, and a `conversation:<sender>:<normalized-subject>` fallback, so an email reply
  continues the same agent (the email analogue of a Slack thread).
- **Routing:** reuse the v2 intake-profile + classification path to pick the repo (an email to
  `support@` can map to a specific profile by recipient address).
- **Prompt assembly:** format the email into the `<triage_prompt>` + `<agent_prompt>` +
  `User request:` structure (see custom system prompt) — t3code's `formatSupportEmailForAgent`.
- **Reply path:** v2 relays agent output to a **linked Slack channel** (Chat SDK), not back to
  the sender by email; outbound email reply is explicitly out of scope (would need an email
  _send_ path, and Chat SDK has no email adapter). Document this asymmetry.

Architecturally this is "a non-Chat-SDK inbound source feeding the same `bridge.handleMessage`
pipeline" — the daemon-facing half is identical to Slack; only the receiver + parsing differ.

### 5. Programmatic / execution-bridge API — **v3**

Let an external orchestrator drive agent runs over HTTP. t3code exposes
`POST /api/execution/runs` (+ `continue`/`interrupt`/`status`) and `POST /api/tasks/materialize`,
all `Bearer`-authed with a shared secret, plus outbound lifecycle callbacks to
`ORCHESTRATOR_BASE_URL`. v3 scope for Paseo:

- A small authed REST surface on the `inbound-http` server mapping 1:1 onto the daemon calls
  the bridge already uses: `runs` → `createWorkspace` + `createAgent`; `continue` →
  `sendAgentMessage`; `interrupt` → the daemon's cancel/stop RPC; `status` →
  `fetchAgent`/`waitForFinish`.
- **Outbound lifecycle callbacks:** POST turn-started / completed / failed and
  first/final assistant message to a configured orchestrator URL, with retry+backoff.
- **Why v3, not v1:** most of this capability _already exists_ as the daemon's own WebSocket
  API and the `paseo` CLI. The REST shim only earns its place when an external system that
  can't speak the daemon protocol must reach in over HTTP. Until then it's redundant — so it
  is deliberately last, and may be dropped if no consumer materializes.

### 6. Health / config endpoint — **v1 (trivial)**

A diagnostics surface for setup. v1 ships it as a **bridge log line + a `paseo`-style status
the operator can read** (is the daemon reachable? is Slack connected via Socket Mode? what's
the bot user id? which repo/profile is configured?). When the v2 `inbound-http` server exists,
promote it to a real `GET /health` route that also reports the computed webhook URLs (mirrors
t3code's `GET /api/external-intake/health`).

## Cross-cutting intake features

These apply across channels and are the genuinely valuable, non-obvious parts of t3code.

### Intake profiles (multi-repo routing) — **v2**

The graduation from single-repo to many. t3code loads `T3_INTAKE_PROFILES_JSON`: an array of
`{ id, title, workspaceRoot, aliases[], defaultBaseRef, setupScript, modelSelection,
slackEmoji, … }`. v2 scope for Paseo:

- A `profiles` config (array) replacing v1's single `repoPath`/`baseBranch`. v1's single repo
  becomes a one-element profile list, so v1 config stays valid (the upgrade is backward
  compatible).
- **Per-profile:** repo path, base branch, default provider/model/mode, project emoji,
  custom agent-prompt block, and routing `aliases` (incl. the emoji as an alias, e.g.
  `:rocket:` routes to that profile).
- **Routing order:** explicit alias/emoji match → LLM classification (below) → **default
  profile** (a `primary: true` flag or a configured default-profile id) → single active repo →
  error listing choices. The chosen profile supplies `cwd` for `createWorkspace` and the
  provider/model/prompt for `createAgent`.
- **Per-profile fields** (from t3code's `IntakeProjectProfile`): `id`, `title`,
  `workspaceRoot` (tilde-expanded), `aliases[]`, `slackEmoji` (doubles as reaction **and**
  routing alias), `primary`, `defaultBaseRef`, `setupScript` (command run on worktree create),
  `modelSelection` (default provider/model/options for this repo), and an email sub-config
  (Feature 4). Precedence for model: inline tag → run-intent classification → profile
  `modelSelection` → global default.
- **Per-profile worktree setup:** run the profile's `setupScript` after worktree creation
  (Paseo's workspace creation already supports a setup step; wire the profile's command into
  it). Keep it in sync if the profile's script changes for an already-created project.

### LLM route classification — **v2 (depends on profiles)**

Auto-pick the repo and provider when the message doesn't name one. t3code calls a model step
(`generateIntakeRoute`) to (a) choose which profile the request targets and (b) detect "run
this" (→ Codex) vs "write this" (→ Claude). v2 scope:

- A single classification call (using a small/fast model) that takes the message + the list of
  profile titles/descriptions and returns `{ profileId, providerHint }`.
- Only invoked when explicit routing (alias/emoji/tag) is absent — explicit always wins.
- Maps `providerHint` to `createAgent({ provider, model, modeId })`; falls back to the
  profile's default provider on low confidence.
- Genuinely useful only once **profiles** exist (nothing to classify into with one repo), so
  it ships in the same phase.

### Custom system prompt / agent instructions — **v1**

The initial prompt sent to the agent is **assembled**, not just the user's raw text. t3code
builds it in layers (`buildExternalIntakeInitialPrompt` in `ExternalIntake.ts`), and the
Paseo bridge should do the same:

```
[ <triage_prompt> … </triage_prompt> ]      ← optional, source/profile-specific
<agent_prompt>
  <base intake instructions>                ← hardcoded bridge constant (EXTERNAL_INTAKE_AGENT_PROMPT)
  <custom per-source / per-project prompt>  ← from config/profile
</agent_prompt>

User request:
<the actual message text (+ captured thread context, attachments)>
```

Sources of the custom text in t3code (carry the shape across):

- A **base** instruction block, always present, owned by the bridge.
- A **per-project / per-source** prompt appended after it — from `profile.supportEmail.agentPrompt`
  or env (`SUPPORT_EMAIL_AGENT_PROMPT`), and for Slack an `initialPromptContext`.
- An optional **triage prompt** block for specific intakes (support email).

For Paseo, the per-project custom prompt is a config field (v1: one value for the single
repo; later: per intake profile). Note this is the _initial-prompt_ layer; if you also want a
persistent daemon/agent system prompt, that's a separate provider concern (Paseo passes
system prompts to providers like Claude/Pi independently) and is **not** something the bridge
sets per message.

### Model-routing tags — **v1 (cheap)**

t3code honors inline tags in the message to force a model: `[codex]`, `[codex-high]`,
`[claude]`, `[claude-opus]`, `[claude-fable]`, `[glm]`, `[kimi]`, etc. Trivial to parse in
the bridge and map to `createAgent({ provider, model, modeId })`. Good v1 ergonomics even
with a single repo.

### Attachments — **v1 inbound images / v2 outbound files**

Inbound (v1): read Slack image attachments via Chat SDK's `attachment.fetchData()` (the
message attachment handle) and pass them to `createAgent`/`sendAgentMessage` (which accept
`images`/`attachments`) — **not** via raw `files.info` + bot token as t3code did. Outbound
(v2): agent-produced files post back with `thread.post({ files: [{ data, filename }] })` —
e.g. a generated diff, screenshot, or report. Both directions stay inside Chat SDK per the
hard constraint above. Inbound images are the v1 minimum; full bidirectional file exchange is
a v2 polish bundled with the richer-I/O work.

## Slack streaming (the upgrade over t3code)

This is the headline improvement. Chat SDK supports **native Slack streaming**, so instead
of t3code's first+final relay, the thread updates live.

**How it works.** `thread.post()` accepts an `AsyncIterable` that yields either plain strings
or structured `StreamChunk` objects. On Slack the SDK uses Slack's native `chatStream` for
smooth real-time edits; on platforms without native streaming it automatically falls back to
post-then-edit / buffered. **No manual capability switch in our code** — we always pass an
iterable.

**`StreamChunk` types** (`import type { StreamChunk } from "chat"`):

| Chunk           | Fields                                     | Use for                                                |
| --------------- | ------------------------------------------ | ------------------------------------------------------ |
| `markdown_text` | `{ text }`                                 | streamed assistant text                                |
| `task_update`   | `{ id, title, status, details?, output? }` | tool calls (status pending/in_progress/complete/error) |
| `plan_update`   | `{ title }`                                | plan-mode title updates                                |

**Mapping Paseo turn events → `StreamChunk`s.** The bridge's `turn-stream.ts` is an async
generator that consumes `client.on("agent_stream", …)` for one agent turn and yields:

- `timeline { item.type: "assistant_message" }` → `{ type: "markdown_text", text }`
  (concatenate consecutive assistant messages — there are no text deltas; assistant text
  arrives as several complete rows).
- `timeline { item.type: "tool_call" }` → `{ type: "task_update", id: callId, title: name,
status: map(item.status) }` where `running→in_progress`, `completed→complete`,
  `failed→error`.
- `timeline { item.type: "reasoning" }` → optional `markdown_text` (or suppress to reduce noise).
- `timeline { item.type: "plan" }` / plan mode → `{ type: "plan_update", title }`.
- `turn_completed | turn_failed | turn_canceled` → **end the generator** (closing the stream).
  `client.waitForFinish(agentId)` is the authoritative backstop to close it.

**Rich options** via `StreamingPlan` (`import { StreamingPlan } from "chat"`): `groupTasks:
"plan" | "timeline"` (group tool cards into one block vs inline), `endWith: [blockKit…]`
(append Block Kit elements — e.g. permission buttons — after the stream stops),
`updateIntervalMs`. Bot-level knobs: `streamingUpdateIntervalMs` (edit throttle, default
500ms), `fallbackStreamingPlaceholderText`.

## Permissions → chat buttons — **v1**

When an agent needs approval the daemon emits `agent_permission_request`. The bridge:

- Listens on `client.on("agent_permission_request", …)`; the request carries `actions[]`
  (each `{ id, label, behavior, variant }`) which map 1:1 to Slack buttons (post them via
  `StreamingPlan.endWith` or a standalone Block Kit message).
- On click, resolves with `client.respondToPermission(agentId, request.id, { behavior,
selectedActionId })`.
- The `question` permission kind is also how interactive "agent asks the user a question"
  flows surface (t3code's `user-input.requested`).
- To guarantee prompts fire, create Claude agents with `modeId: "default"` (not
  `bypassPermissions`); for Codex avoid `full-access` (`approvalPolicy: "never"`).

## Intake & relay mechanics

The smaller, non-obvious behaviors that make the bridge robust — all distilled from t3code's
`ExternalChat.ts` / `ExternalIntake.ts` / `Reactor.ts`. These are correctness/quality
details, not headline features, but skipping them produces double-posts, loops, or dropped
messages. Most are **v1**.

### Concurrency & idempotency — **v1 (correctness-critical)**

- **Serial per thread, parallel across threads.** t3code constructs the Chat SDK bot with
  `concurrency: "queue"` so two messages in the _same_ thread process in order, while
  different threads run concurrently. Mirror this — one agent per thread can't tolerate
  interleaved turns.
- **Inbound dedup, two layers.** (a) Chat SDK's own `dedupeTtlMs` (~10 min) drops Slack's
  webhook retries; (b) our own **event receipts** keyed `slack:<externalThreadId>:<messageId>`
  short-circuit anything already processed. Both matter — Slack retries aggressively.
- **Outbound delivery receipts.** Before _every_ post, check a delivery-receipt key (encodes
  source, phase, threadId, turnId, messageId). Skip if already `completed`. This is what
  prevents double-posting after a restart or event replay. t3code persists these; ours live
  in the file store (see State storage). **This is the outbound twin of inbound dedup and is
  easy to forget.**
- **Per-thread lock.** A short-TTL lock per thread (in our case the in-process mutex from the
  `StateAdapter`) guards the read-modify-write of thread state.

### Loop prevention & message filtering — **v1**

- **Ignore the bot's own and other bots' messages** (Chat SDK's Slack adapter handles the
  `bot_message` subtype; don't re-emit our own posts as intake).
- **Exclude bot/own messages from captured thread context** so the agent isn't fed its own
  prior replies.
- **"Mentions another user" gate (channels only):** if a channel message @-mentions a human
  who isn't the bot, ignore it — it's addressed to that person. DMs bypass this.
- **Ambient-message gate (channels only):** with no existing thread link and no bot mention,
  ignore. In a DM, every message counts as addressed to the bot.

### Channel vs DM differences — **v1**

DMs are more permissive than channels: they skip the "mentions another user" and ambient
gates (a DM is implicitly to the bot), and thread-context capture only applies to threaded
channel replies, not top-level DMs. Treat `mpim` (group DM) like a channel, not a DM.

### Inbound text cleaning — **v1**

Before building the prompt, clean the message: strip client attributions (t3code strips
`"Sent using ChatGPT"`/`<@…|ChatGPT>` trailers — relevant if users relay from other
assistants), strip `<@…>` mention syntax from answers, and append non-image attachments as
`Attachments:\n- name (mime): url` text lines while images go through the native `images`
path. Keep a separate raw-text copy for mention-detection/routing vs. the cleaned text sent
to the agent.

### Output relay rules — **v1 (this is the streaming model's contract)**

t3code posts **only** assistant text + attachments + the question/answer and failure notices
— it deliberately does **not** post tool calls, reasoning, or status changes as messages.
Our streaming model is richer (tool calls become `task_update` cards), but inherit these
rules:

- **No message editing for replies** — assistant relay always posts new (Chat SDK's streaming
  handles in-place edits within a single streamed message; we don't hand-edit prior posts).
- **Final-text dedup:** don't re-post text already streamed; an end-of-turn flush that equals
  what was already shown posts nothing (attachments only).
- **Markdown fix-ups for Slack:** flatten markdown tables to bullet lists and wrap
  `@scope/package` in backticks so Slack doesn't turn them into mentions. (t3code does both;
  cheap, high annoyance-reduction.)
- **No hard length cap** on assistant text in t3code; only thread-context capture (~8k),
  failure detail (~500), and email preview (~2.8k) are truncated. Decide our own Slack-message
  chunking since Slack has block limits.

### Agent errors & question/answer flow — **v1**

- **Start failure → posted.** If creating/continuing an agent throws, post a plain
  `"I couldn't start a task from this message. Reason: <message>"` to the thread (t3code does
  exactly this). This is the one error users see.
- **Turn failure (`turn_failed` / status `error`):** t3code does _not_ post a dedicated
  "failed" message — it just flushes pending text. We should do **better**: surface a short
  "the agent hit an error" line, since our streaming model already tracks turn end. (Decision:
  post a terminal error note; see open questions.)
- **Agent asks a question** (`agent_permission_request` kind `question`, t3code's
  `user-input.requested`): post a numbered question card; the user's next thread reply is the
  answer. t3code strips `<@…>` from the answer and supports single-answer-applies-to-all vs
  `Q1: … Q2: …` multi-answer. Submission-failure also gets a notice. This rides the same
  permission plumbing as buttons.

### Subscription lifecycle — **v1**

Call `thread.subscribe()` at the start of processing every message (idempotent), so follow-up
replies route via `onSubscribedMessage`. The subscription set is persisted (our
`StateAdapter`), so a restart doesn't stop the bot following live threads.

### Worktree & title details — **v1**

- **Branch name:** generate `paseo-chat/<short-hex>` (t3code uses `t3code/<8 hex>`) as the
  `worktreeSlug`; the daemon's `createWorkspace` owns actual branch creation.
- **Base ref refresh:** fetch the base branch from origin before branching (t3code passes
  `refreshBaseFromOrigin: true`) so worktrees start from current `main`.
- **Setup script:** run the configured per-repo setup command after worktree creation
  (Paseo's workspace setup step). t3code does **not** block the first turn on it completing.
- **Thread title seed:** derive the agent title from the first line of the message (cap ~120
  chars); follow-ups keep the original title.

### Deep links — **v1**

Build a link back to the agent in the Paseo app/web UI (`/h/[serverId]/agent/[agentId]`) for
the "task started" card and any "open in Paseo" affordance — the analogue of t3code's
`t3ThreadUrl`. Needs a configured app base URL.

## Proposed package layout (design sketch — not built)

```
packages/chat/
  package.json            # @getpaseo/chat, private, ESM; deps: chat, @chat-adapter/slack,
                          #   @getpaseo/client, @getpaseo/protocol, ws — no DB/Redis dependency
  tsconfig.json           # extends ../../tsconfig.base.json, NodeNext (cli pattern)
  src/
    index.ts              # boot: load config, connect daemon, construct Chat + adapters, register handlers
    config.ts             # env: repoPath, baseBranch, provider, model, modeId, projectEmoji,
                          #   customAgentPrompt, deepLinkBaseUrl, daemon host/password, stateDir
                          #   (Slack tokens are read by @chat-adapter/slack, not by us)
    paseo-client.ts       # connect() helper mirroring packages/cli/src/utils/client.ts (reconnect: enabled)
    bridge.ts             # core: handleMessage — filters/gates, new-thread vs follow-up, routing, dedup
    state/
      json-state.ts       # [v1] shared atomic JSON load/save + write-queue (mirrors loop-service.ts)
      chat-state-adapter.ts # [v1] file-backed Chat SDK StateAdapter (subscriptions/cache persisted; locks in-process)
      thread-agent-store.ts # [v1] domain store: thread↔{agentId,workspaceId,muted}, event + delivery receipts, artifacts
    turn-stream.ts        # one agent turn → AsyncIterable<StreamChunk> for thread.post()
    render.ts             # AgentTimelineItem / ToolCallDetail → StreamChunk; Slack markdown fix-ups (tables, @scope)
    permissions.ts        # agent_permission_request → buttons (kind tool) / question card (kind question) → respond
    intake/
      slack.ts            # [v1] Slack glue: mute/aside parsing, attribution strip, context capture, reactions,
                          #   channel-vs-DM gates, mentions-other-user filter, answer normalization
      tags.ts             # [v1] model-routing tag parser ([codex], [claude-opus], …)
      profiles.ts         # [v2] multi-repo profile loading + alias/emoji routing
      classify.ts         # [v2] LLM route classification (profile + provider hint)
      github-webhook.ts   # [v2] PR-merged notifications (needs inbound-http)
      email-resend.ts     # [v2] inbound email receiver + parser
      execution-api.ts    # [v3] programmatic REST surface + lifecycle callbacks
    inbound-http.ts       # [v2] public HTTP server hosting webhook/email/health/exec routes
  README.md               # operational setup (Slack app scopes, Socket Mode tokens, env)
```

The package `README.md` would be operational setup; this doc is the system-level design. The
`[v1]/[v2]/[v3]` tags show when each module lands; v1 ships only the untagged-as-later files.
State (both Chat SDK's and ours) is **file-backed, following Paseo's own persistence
pattern** — no external database — see "State storage" below.

## Architecture additions per phase

**v1** is exactly the diagram above: an outbound-only process (`DaemonClient` over
`127.0.0.1`, Slack over Socket Mode), file-backed state (see "State storage"), and the
turn-stream/render/permissions glue. No inbound listener, no HTTP server, no database.

**v2 introduces an inbound HTTP server (`inbound-http.ts`).** This is the one structural
change in the project's life: the bridge goes from purely outbound to also _accepting_
requests. It hosts the GitHub webhook, the Resend email webhook, the promoted `/health`
route, and (in v3) the execution API. It must run behind TLS / a tunnel with per-route
signature verification (HMAC for GitHub, Svix for Resend). v2 also adds:

- `intake/profiles.ts` + `intake/classify.ts` — routing a message to one of N repos.
- A **second Chat SDK adapter** (`@chat-adapter/discord` or `…/telegram`) registered in
  `index.ts` alongside Slack — no bridge-core changes, which validates the platform-agnostic
  seam. Streaming/fallback differences are handled by Chat SDK (Discord = post+edit, etc.).
- **Remote mode** — `paseo-client.ts` gains a relay+E2EE connection path (the mobile app's
  pattern; `DaemonClient` already supports `e2ee` + relay URL) so the bridge can run on a
  different host than the daemon. v1's `127.0.0.1` path stays the default.

**v3 adds the programmatic surface.** `intake/execution-api.ts` exposes the REST API and
lifecycle callbacks on the v2 `inbound-http` server. (The bridge stays a **single process** —
running multiple instances is explicitly a non-goal; see "State storage".)

## State storage

State management is **proper from day 1, with no external database** — it follows Paseo's own
file-based persistence pattern (atomic JSON writes + Zod validation under `$PASEO_HOME`, see
[data-model.md](data-model.md)). This keeps the bridge consistent with the local-first daemon
and adds **zero new runtime dependencies** (no Redis, no Postgres). Durability and atomic
writes do not require a database for a single-process service; the only thing a database would
add — coordination across multiple processes — is something the bridge deliberately does not
need (it runs as one process; multi-instance is a non-goal).

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

   The lock methods are the only ones that aren't persisted — and correctly so. Locks exist to
   stop two _processes_ double-handling one event; with a single process an in-memory mutex is
   the complete, correct implementation, not a shortcut. Subscriptions and cache **are**
   persisted, so a restart never loses which threads the bot follows.

2. **Our domain store** (`thread-agent-store.ts`) — the bridge's own data:
   `externalThreadId → { agentId, workspaceId, muted, createdAt }`, event-receipt dedup keys,
   and (v2) PR artifact links. Keep the logical tables t3code used (`external_thread_links`,
   `external_event_receipts`, `artifact_links`) as JSON collections.

**Implementation — reuse Paseo's primitives, don't reinvent:**

- **Atomic writes:** use `writeJsonFileAtomic` from `packages/server/src/server/atomic-file.ts`
  (temp-file + rename). Either import it or copy the ~20-line helper into `state/json-state.ts`
  (the bridge is a separate package; a tiny local copy avoids a server dependency).
- **No torn concurrent writes:** serialize saves through an in-memory write queue, exactly as
  `loop-service.ts` does.
- **Validation:** Zod schema per store, parsed on load, with optional-field defaults for
  forward-compat (Paseo's no-migrations convention).
- **Templates to copy:** `packages/server/src/server/schedule/store.ts` and
  `push/token-store.ts` are the closest existing single-file stores.
- **Location:** under `$PASEO_HOME/chat-bridge/` (e.g. `state.json`, `chat-sdk-state.json`),
  or a configurable `stateDir`.

**Cost / risk:** ~150–250 lines total, zero new dependencies. The one external coupling is the
Chat SDK `StateAdapter` interface itself — Chat SDK is beta, so **pin the version** and treat
an interface change as a small, contained fix. (If a genuine multi-process need ever appeared,
swapping in `@chat-adapter/state-redis` is a one-line change because it's the same interface —
but that is explicitly not a goal and nothing should be designed around it.)

## Flow (v1, Slack, streaming)

**New thread** (`bot.onNewMention` / `onDirectMessage`):

1. Dedup on `eventId`; if seen, stop.
2. `thread.subscribe()`.
3. Parse model-routing tags; capture human-thread context if present.
4. `client.createWorkspace({ source: { kind: "worktree", cwd: repoPath, worktreeSlug, baseBranch } })`.
5. `client.createAgent({ provider, model, modeId, workspaceId, initialPrompt, images })`.
6. Persist `threadId → { agentId, workspaceId }`; react `:eyes:` (+ project emoji if
   configured) on the triggering message; post the "task started" card.
7. `await thread.post(turnStream(agentId))` — streams the turn live.

**Reply** (`bot.onSubscribedMessage`): dedup → look up `agentId` (respect `muted`) →
`client.sendAgentMessage(agentId, text)` → `await thread.post(turnStream(agentId))`.

**Permission mid-turn:** the `turn-stream` surfaces buttons (via `endWith`); the click handler
calls `respondToPermission`, the agent continues, the stream resumes.

## Research gotchas to preserve

- **Use the low-level `DaemonClient`, not the `PaseoClient` facade.** Import from
  `@getpaseo/client/internal/daemon-client` (as the CLI does). The high-level facade
  (`packages/client/src/index.ts`) has **no raw stream subscription and no permission
  handling**, both of which the bridge needs.
- **Worktree creation is workspace-first.** Mirror `packages/cli/src/commands/agent/run.ts`:
  `createWorkspace({ source: { kind: "worktree", cwd, worktreeSlug, baseBranch } })` → pass
  the resulting `workspaceId` into `createAgent`. (Not `createAgent({ worktreeName })`.)
- **No assistant text deltas.** Assistant output arrives as multiple complete `timeline`
  events with `item.type: "assistant_message"`; concatenate them. `assistant_chunk` exists in
  the protocol but is not emitted on the non-voice path.
- **Turn boundaries from the stream; completion from an RPC.** A turn is `turn_started` →
  N× `timeline` → `turn_completed | turn_failed | turn_canceled`. `client.waitForFinish(
agentId, timeoutMs)` is the authoritative completion signal; `agent_update` `status: "idle"`
  is secondary. `turnId` is internal-only and stripped at the wire — group by the start/end
  stream events, not by `turnId`.
- **Permissions are low-level only.** Listen on `agent_permission_request`; resolve via
  `respondToPermission(agentId, request.id, { behavior, selectedActionId })`. Pending requests
  also appear on `AgentSnapshotPayload.pendingPermissions`.
- **Chat SDK streaming + fallback is automatic.** `thread.post(asyncIterable)` streams
  natively on Slack and falls back elsewhere; we never branch on platform capability.
- **Chat SDK is the only Slack client — no raw token calls.** Reactions
  (`sentMessage.addReaction` / `adapter.addReaction`), cards, posting, file upload
  (`thread.post({ files })`), and inbound attachment reads (`attachment.fetchData()`) are all
  native. t3code reached around to `files.getUploadURLExternal/completeUploadExternal`,
  `files.info`, and raw `url_private` fetches — **do not replicate those**; use the Chat SDK
  equivalents. Reactions/cards/posting were already pure Chat SDK in t3code.
- **Monorepo fit:** `@getpaseo/chat`, ESM, `module`/`moduleResolution: NodeNext`, tests via
  `vitest`. Tooling is **oxlint + oxfmt** (the Biome mention in CLAUDE.md is historical). No
  turbo — add `build:chat` after `build:client`; `typecheck`/`test` are picked up by the
  `--workspaces --if-present` fan-out.
- **`@getpaseo/client` is "not a stable SDK"** (its README says so). The bridge lives
  in-monorepo to move in lockstep rather than break as an external consumer.
- **t3code reference, not import.** t3code is a separate repo on a different stack (Effect-TS,
  its own orchestration engine). Reuse its _design and feature decisions_, not its code; the
  Paseo bridge re-expresses them against the daemon.

## Reference pointers

- [architecture.md](architecture.md) — client/daemon model, WebSocket protocol, agent lifecycle.
- `packages/cli/src/utils/client.ts` — the daemon connection pattern to mirror.
- `packages/cli/src/commands/agent/run.ts` — workspace-first worktree + create-agent sequence.
- `packages/protocol/src/messages.ts` — `AgentStreamEventPayload`, `AgentTimelineItem`,
  `ToolCallDetail`, `AgentPermissionRequest`/response schemas.
- `packages/client/src/daemon-client.ts` — `DaemonClient` methods: `createWorkspace`,
  `createAgent`, `sendAgentMessage`, `waitForFinish`, `on(...)`, `respondToPermission`.
- `affil-ai/t3code` `apps/server/src/externalIntake/` — prior implementation: `ExternalChat.ts`
  (Slack callbacks), `ExternalIntake.ts` (routing, tags, mute), `Reactor.ts` (output relay),
  `http.ts` (webhook routes + signature verification), `profiles.ts` (multi-repo profiles).
- [Chat SDK streaming docs](https://chat-sdk.dev/docs/streaming) — `StreamChunk`, `StreamingPlan`.

## Decisions (resolved by the roadmap)

What were open questions now have answers tied to a phase:

- **Teardown policy → v1.** A thread's agent is archived (`client.archiveAgent`) and its store
  entry dropped when the agent reaches a terminal `closed` state, or on an explicit
  `@bot done` / thread-archive signal. The worktree follows Paseo's normal workspace teardown.
  Idle agents are left alive so a later reply can resume them (agents persist in
  `~/.paseo/agents/`); a configurable idle-archive sweep is a v2 nicety.
- **Output noise → v1 default, tunable.** Stream `assistant_message` text always; render
  `tool_call`s as `task_update` cards with `groupTasks: "plan"` so they collapse into one
  block; **suppress `reasoning` by default** (config flag to show it). This keeps threads
  readable without losing the action log.
- **Error surfacing → v1, and better than t3code.** Post start failures (couldn't create the
  agent) and **turn errors** (`turn_failed` / status `error`) as a short thread message.
  t3code only posts the former; we post both, since our turn-stream already observes turn end.
- **Multi-repo + LLM routing → v2.** Single configured repo in v1; intake profiles +
  classification in v2 (see those features). v1 config is forward-compatible (it becomes a
  one-element profile list).
- **State backend → file-backed from v1, no database, ever (for the single-process design).**
  A custom file-backed Chat SDK `StateAdapter` + our own JSON domain store, both using
  `writeJsonFileAtomic` + Zod (see "State storage"). No Redis/Postgres dependency. t3code used
  SQLite tables (`external_thread_links`, `external_event_receipts`, `artifact_links`); we keep
  the same logical tables as JSON collections. Redis would only matter for multiple bridge
  processes, which is a non-goal.
- **Public-inbound hosting → v2.** v1 is Socket Mode only (no inbound URL, runs anywhere). The
  `inbound-http` server (GitHub/email/health/exec) arrives in v2 behind TLS/a tunnel with
  per-route signature verification. This is the deliberate boundary between v1 and v2.

## Remaining open questions (genuinely undecided)

- **Concurrency caps:** should one channel/user be limited to N concurrent agents (and one
  repo to N worktrees) to avoid runaway resource use? Likely a v2 config knob.
- **Secrets/permission posture in shared channels:** anyone in a channel can drive an agent
  with full tool access — what guardrails (allowlist of users, default `plan` mode in public
  channels, per-channel mode policy)? Decide before any non-trivial deployment.
- **Second adapter choice for v2:** Discord vs Telegram first — driven by which you actually
  use.
