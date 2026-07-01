# Chat Bridge v1 — Product Requirements

Source references: [docs/chat-bridge.md](../../chat-bridge.md), [docs/office-brain.md](../../office-brain.md)
Date created: 2026-06-27

> Branch note: chat bridge work is in this worktree on `cto/generalized-chat-bridge`. PR #5 in
> `affil-ai/paseo` is currently `feature/cloudflare-access-user-email` (Cloudflare Access email),
> not the chat bridge PR.

## Problem statement

The office-of-CTO agent can only be driven from the Paseo app/CLI/desktop today. We want to
drive it from **Slack** — @-mention a bot, hand it a task, get concise thread updates,
and reply to continue — without any change to the daemon or core packages. The bridge is a new
standalone process that speaks Chat SDK on one side and the daemon WebSocket protocol on the
other.

This is **v1 only**: the complete single-agent Slack experience over Socket Mode, no public
inbound HTTP, no database. Webhooks, email intake, remote mode, agent-initiated chat tools, and
optional multi-repo routing are explicitly v2 and out of scope here.

## Goals

- Tag `@cto` (the bot) in a channel or DM → a new office agent starts in a fresh Paseo
  workspace and the bridge posts the first complete assistant text block plus the final assistant
  text block back into the Slack thread.
- Reply in a linked thread → continues the same office agent.
- When the office agent spawns a coding subagent, the thread stays attached to the office agent;
  the bridge does not route replies to or relay output from the child.
- Permission prompts and agent questions surface as Slack buttons / numbered cards.
- The bridge survives a daemon or bridge restart without double-posting or losing thread links.

## User stories

- As a founder, I tag `@cto investigate why trial conversion dropped` in `#growth` and watch it
  pull data, reason, and answer — all in the thread.
- As a founder, I tag `@cto fix the onboarding crash and open a PR`; the office agent delegates
  to a coding subagent in a worktree, supervises it, and reports the result back in the thread
  itself.
- As any channel member, I reply in a running thread to steer it — without re-mentioning the
  bot.
- As a founder, I say `@cto mute` to silence a noisy thread, and `@cto done` to wrap it up
  (which also triggers memory capture).

## Product decisions (locked)

- **One thread = one workspace = one office agent**, on a single configured `directory`
  workspace backed by the office repo. No per-thread worktree at intake.
- **Default provider is `pi`**, backing model **Codex `gpt-5.5` (medium)**. No per-message
  model-routing tags; the office agent picks other models itself when delegating.
- **Worktrees are agent-initiated only** — the bridge never cuts one.
- **Office-agent-only chat boundary**: the bridge never routes replies to child agents, never
  polls child timelines, and never tracks active child work.
- **Multiplayer**: any channel member can steer the office agent; identity is attached per
  message.
- **Chat SDK is the only Slack client** — no raw Slack Web API calls.
- **State is file-backed** under `$PASEO_HOME/chat-bridge/` — no database.
- **Teardown** (`@cto done` / archive) is the office brain's capture trigger.

## Out of scope (v1)

- Agent-initiated chat tools (`chat.startConversation`, `chat.askPerson`, `chat.askChannel`,
  `chat.reply`) — v2.
- Public inbound HTTP server (GitHub PR-merge webhook, Resend email intake) — v2.
- Remote deployment over relay+E2EE — v2 (v1 is `127.0.0.1` only).
- Multi-repo intake profiles + LLM route classification — v2, optional.
- Outbound file attachments (agent → Slack files) — v2 (inbound images/files are in v1).
- Public programmatic REST API / multi-daemon fan-out — dropped.
- The office brain's capture/lint _implementation_ — this plan only fires the teardown
  trigger; the brain workflow is scoped in [office-brain.md](../../office-brain.md).

## Success criteria

From Slack you can: start the office agent, get first/final assistant updates, have it delegate
code work to a coding subagent while the thread remains attached to the office agent, answer its
permission prompts, reply (as any channel member) to continue it, mute it, and wrap it with
`@cto done` — all surviving a daemon or bridge restart with no double-posts.

## Open questions

- Concurrency caps per channel/user — deferred to v2 config knob.
- Shared-channel access posture: confirm-first permission mode is v1; per-channel allowlist /
  plan-only public-channel mode is a v2 knob.
