# Chat Bridge v1 — Product Requirements

Source references: [docs/chat-bridge.md](../../chat-bridge.md), [docs/office-brain.md](../../office-brain.md)
Date created: 2026-06-27

## Problem statement

The office-of-CTO agent can only be driven from the Paseo app/CLI/desktop today. We want to
drive it from **Slack** — @-mention a bot, hand it a task, watch it work live in the thread,
and reply to continue — without any change to the daemon or core packages. The bridge is a new
standalone process that speaks Chat SDK on one side and the daemon WebSocket protocol on the
other.

This is **v1 only**: the complete single-agent Slack experience over Socket Mode, no public
inbound HTTP, no database. Webhooks, email intake, remote mode, and optional multi-repo routing
are explicitly v2 and out of scope here.

## Goals

- Tag `@cto` (the bot) in a channel or DM → a new office agent starts in a fresh Paseo
  workspace and its turn **streams live** back into the Slack thread.
- Reply in a linked thread → continues the same office agent.
- When the office agent spawns a coding subagent, the thread **follows that child** (focus
  relay), then returns to the office agent when the child finishes.
- Permission prompts and agent questions surface as Slack buttons / numbered cards.
- The bridge survives a daemon or bridge restart without double-posting or losing thread links.

## User stories

- As a founder, I tag `@cto investigate why trial conversion dropped` in `#growth` and watch it
  pull data, reason, and answer — all in the thread.
- As a founder, I tag `@cto fix the onboarding crash and open a PR`; the office agent delegates
  to a coding subagent in a worktree, and the thread shows that child's work, then "opened PR
  #42".
- As any channel member, I reply in a running thread to steer it — without re-mentioning the
  bot.
- As a founder, I reply `@cto ↑` to pull focus back to the supervisor while a child keeps
  running.
- As a founder, I say `@cto mute` to silence a noisy thread, and `@cto done` to wrap it up
  (which also triggers memory capture).

## Product decisions (locked)

- **One thread = one workspace = one office agent**, on a single configured `directory`
  workspace backed by the office repo. No per-thread worktree at intake.
- **Default provider is `pi`**, backing model **Codex `gpt-5.5` (medium)**. No per-message
  model-routing tags; the office agent picks other models itself when delegating.
- **Worktrees are agent-initiated only** — the bridge never cuts one.
- **Focus relay**: one focused child at a time, no sub-subagents, escape hatch `@cto ↑`,
  auto-return to the office agent on child completion.
- **Multiplayer**: any channel member can steer the focused agent; identity is attached per
  message.
- **Chat SDK is the only Slack client** — no raw Slack Web API calls.
- **State is file-backed** under `$PASEO_HOME/chat-bridge/` — no database.
- **Teardown** (`@cto done` / archive) is the office brain's capture trigger.

## Out of scope (v1)

- Public inbound HTTP server (GitHub PR-merge webhook, Resend email intake) — v2.
- Remote deployment over relay+E2EE — v2 (v1 is `127.0.0.1` only).
- Multi-repo intake profiles + LLM route classification — v2, optional.
- Outbound file attachments (agent → Slack files) — v2 (inbound images are in v1).
- Programmatic REST API / multi-daemon fan-out — dropped (was v3).
- The office brain's capture/lint _implementation_ — this plan only fires the teardown
  trigger; the brain workflow is scoped in [office-brain.md](../../office-brain.md).

## Success criteria

From Slack you can: start the office agent, watch it work live, have it delegate code work to a
coding subagent and watch the thread follow that child and come back, answer its permission
prompts, reply (as any channel member) to continue it, mute it, and wrap it with `@cto done` —
all surviving a daemon or bridge restart with no double-posts.

## Open questions

- Escape-hatch affordance: text command `@cto ↑` only, or also a "talk to supervisor" Block Kit
  button via `StreamingPlan.endWith`? (Lean: both.)
- Concurrency caps per channel/user — deferred to v2 config knob.
- Shared-channel access posture: confirm-first permission mode is v1; per-channel allowlist /
  plan-only public-channel mode is a v2 knob.
