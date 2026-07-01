# Chat Bridge v2 — Agent-Initiated Conversations

Source references: [docs/chat-bridge.md](../../chat-bridge.md), [v1 PRD](../chat-bridge-v1/prd.md), [v1 execution](../chat-bridge-v1/execution.md)
Date created: 2026-06-29

## Problem statement

v1 lets humans start and continue office-agent sessions from Slack. v2 makes the bridge
bidirectional: the office agent can explicitly start or continue chat conversations with people or
channels, while Slack/Chat SDK remains behind the bridge.

The production model is:

```txt
agent tool call -> Paseo chat tool -> packages/chat -> Chat SDK -> Slack
                                      |
                                      v
                              durable ChatBinding
```

The agent should not hold Slack tokens or use raw Slack Web API calls to post. But it **can use its
executor MCP to discover Slack context** — channels it can see, recent threads, channel purposes,
people, and links — then pass those discovered destination references to the Paseo chat tools. The
bridge validates and posts through Chat SDK.

Starting another agent is **not** a chat tool. If the office agent wants a new agent/workspace in a
project, it should use the existing Paseo agent/workspace tools. The chat bridge keeps the same
bound chat thread attached to the office agent instead of creating another chat thread for the
user to juggle or talking to the child directly.

## Goals

- Let the office agent message a person, channel, or existing chat binding through explicit
  `chat.*` tools.
- Let an agent discover available Slack channels/threads using executor MCP, then start
  conversations in channels it has access to — without requiring every channel to be pre-allowlisted.
- Keep Slack tokens and posting mechanics inside `packages/chat` / Chat SDK.
- Persist bindings so replies route back to the correct office agent after restart.
- Support blocking human input with `chat.askPerson` / `chat.askChannel` semantics and
  timeout/cancel/restart recovery.
- Preserve the office-agent-only chat boundary: if the office agent starts another Paseo
  agent/subagent, the existing chat binding stays with the office agent and never exposes the child
  as a chat target.
- Preserve full inbound URLs from Slack even when Slack displays shortened link labels, so agents
  receive the actual destination URL rather than Slack's rendered/truncated text.

## Non-goals

- No raw Slack Web API posting path inside agents or daemon tools.
- No ambient auto-DMs or auto-channel-posts from ordinary assistant text.
- No bridge-owned task routing/classification.
- No chat tool that creates a new agent or workspace.
- No requirement that every postable channel be statically configured up front. Static allowlists
  remain optional policy, not the default destination model.

## Product model

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
      conversationId: string;
      externalThreadId: string;
      officeAgentId: string;
      destination: ChatDestination;
      subscribed: boolean;
      pendingRequestId?: string;
    };
```

A binding has exactly one conversational owner. For inbound sessions that is `rootAgentId` (the
office agent). For outbound conversations that is `officeAgentId` (the office agent that called
the chat tool). The bridge does not store `focusedAgentId`, `activeChildAgentId`, or
`activeWorkAgentId` and does not shift chat ownership when the office agent creates a child/subagent.
Child/coding agents should report to the office agent; they do not own chat bindings.

### Destination references

Agents work with intent-level destinations, not Slack clients:

```ts
type ChatDestination =
  | { kind: "current" }
  | { kind: "person"; key: string }
  | { kind: "channel"; id?: string; name?: string; url?: string }
  | { kind: "conversation"; conversationId: string };
```

Examples:

```ts
chat.reply({ message: "Done — I updated the tracker." });

chat.startConversation({
  destination: { kind: "person", key: "vivek" },
  message: "Can you confirm the Citi distribution plan?",
  subscribe: true,
});

chat.startConversation({
  destination: { kind: "channel", name: "growth" },
  message: "I'm investigating the conversion drop here; reply in this thread with context.",
  subscribe: true,
});

chat.askChannel({
  destination: { kind: "channel", id: "C123..." },
  question: "Does anyone know whether this partner changed tracking links yesterday?",
  timeoutMinutes: 90,
});
```

For channel conversations, `startConversation` posts a **new top-level channel message** and then
subscribes to the created thread. Replies in that thread route back to the office agent.
For an existing thread, the office agent uses `conversationId` or a Slack permalink discovered via
executor MCP and normalized by the chat tool.

## Slack URL preservation

Slack may render pasted links as shortened display labels (for example, a long Facebook URL shown
as `facebook.com/p/Aunt-Kara-Mo…`). Chat SDK normalizes Slack messages with both `message.text`
and `message.links`; the bridge must treat `message.links[*].url` as the authoritative URL source
for agent prompts and reply routing context.

Requirements:

- When normalizing inbound Slack messages, include every `message.links[*].url` in the prompt unless
  the exact URL already appears in the cleaned text.
- Do not rely on `message.text` alone for URLs; it may contain Slack's display label rather than the
  full destination.
- Preserve a user's visible text as-is, but append a compact `Links:` section with full URLs when
  needed.
- This applies to v2 outbound-conversation replies too: once the bridge subscribes to a thread it
  started, human replies in that thread must use the same URL-preserving normalization path as v1
  inbound sessions.

## How the office agent knows where to message

The office agent should have three ways to select a destination:

1. **Current binding** — if the office agent was started from Slack or already owns an outbound
   conversation, `chat.reply({ message })` replies to the current/default binding.
2. **Configured people aliases** — `person: "vivek"` resolves through people config and/or office
   memory metadata to a Slack DM target.
3. **Executor-discovered channels/threads** — the office agent uses executor MCP Slack tools to
   search or list accessible Slack channels, inspect channel names/purposes/recent
   messages/permalinks, then passes a channel ID/name/permalink to `chat.startConversation`,
   `chat.askChannel`, or `chat.reply`.

This is intentionally not a locked-down channel allowlist. Production policy is **capability and
audit based**:

- If the executor can discover a channel and the Chat SDK bot can post there, the chat tool may post.
- Optional deny/allow policy can restrict sensitive channels, but it is not required for ordinary
  usage.
- Every outbound post is audited with office agent, destination, message preview, and resolved
  external thread.

## Subscription model

Subscription has two layers:

1. **Transport subscription** — Chat SDK `thread.subscribe()` ensures future external replies fire
   `onSubscribedMessage`. This is persisted through the bridge's Chat SDK `StateAdapter`.
2. **Product binding** — `ChatBinding` says which office agent owns the external thread and should
   receive replies.

On restart, the bridge loads both stores:

- Chat SDK subscription state: which external threads to listen to.
- Paseo chat bindings: where each external reply should route.
- Pending asks: deadlines and wait handles.
- Delivery receipts: whether outbound posts already completed.

If a subscribed thread has no binding, the bridge should ignore it or log a recoverable warning;
subscription alone never implies ownership.

## Routing rules

- Human new DM/mention/unclaimed thread → create `inbound-session` and new office agent.
- Human reply in bound inbound thread → route to `rootAgentId`.
- Human reply in bound outbound same-agent thread → route to `officeAgentId`.
- Office agent `chat.reply()` without `conversationId` → resolve default binding for the office
  agent; error if none or ambiguous.
- Office agent `chat.startConversation(destination=person|channel)` → post through Chat SDK,
  subscribe, store `outbound-conversation`, route replies back to the office agent.
- Office agent `chat.askPerson` / `chat.askChannel` → same as start conversation plus pending request;
  reply resolves the wait, timeout/cancel resolves explicitly.
- Office agent creates another Paseo agent/workspace using existing Paseo tools → the binding
  remains attached to the office agent. No new chat thread is created unless the office agent
  separately calls `chat.startConversation` for a different audience.

## Permission and privacy posture

Outbound contact must be explicit tool use. The production guardrails are:

- The model cannot DM/post by merely writing text in an assistant response.
- Tools show destination + message preview in the agent timeline.
- Optional confirmation policy can apply by destination type, channel privacy, audience size, or
  sensitive regexes.
- Optional denylist/allowlist policy exists, but normal channel posting is not limited to a static
  allowlist.
- No raw Slack tokens exposed to agents.
- If channel posting fails because the bot is not in the channel or lacks access, return a clear
  tool error with suggested next steps.

## Success criteria

- The office agent can discover a Slack channel through executor MCP, start a new subscribed thread
  in that channel via `chat.startConversation`, and receive replies back into the same office
  agent.
- The office agent can ask a person or channel a blocking question and resume when someone replies,
  across a bridge restart.
- `chat.reply()` replies to the current/default binding without the agent knowing Slack IDs.
- Channel posts are audited and not restricted to a hardcoded allowlist by default.
- If the office agent starts a new Paseo agent/workspace, the current chat thread stays attached
  to the office agent instead of creating a second chat thread or routing replies to the child.
