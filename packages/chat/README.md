# @getpaseo/chat

Slack bridge for Office. It runs next to the local daemon, listens for Slack mentions/DMs through Chat SDK, starts one office agent per Slack thread, and relays office-agent turns back to Slack.

## Environment

Required:

- A Paseo workspace marked as the chat repo from the workspace sidebar menu. Every Slack-created office-agent workspace uses that repo.
- Slack adapter env from `@chat-adapter/slack`:
  - `SLACK_BOT_TOKEN=xoxb-...`
  - Socket mode: `SLACK_APP_TOKEN=xapp-...`
  - HTTP mode: `SLACK_SIGNING_SECRET=...`

Optional:

- `PASEO_CHAT_ENABLED=true` in the Docker image starts the chat bridge sidecar alongside the daemon
- `PASEO_CHAT_DAEMON_HOST=localhost:6767`
- `PASEO_PASSWORD=...` if your daemon requires it
- `PASEO_CHAT_DEEP_LINK_BASE_URL=http://localhost:6767`
- `PASEO_CHAT_PROVIDER=pi`
- `PASEO_CHAT_MODEL=openrouter/anthropic/claude-fable-5`
- `PASEO_CHAT_MODE_ID=` (empty by default; Pi does not need a mode)
- `PASEO_CHAT_THINKING_OPTION_ID=high`
- `PASEO_CHAT_OFFICE_PROMPT_PATH=/path/to/prompt.md` — custom instructions injected after the built-in chat bridge prompt. In the office deployment this points to `/home/olumbe/code/office/prompts/chat/slack-office-agent.md`.
- `PASEO_CHAT_ACK_EMOJI=cto`
- `PASEO_CHAT_STATE_DIR=$PASEO_HOME/chat-bridge`
- `PASEO_CHAT_SLACK_MODE=socket` (`socket` or `http`)
- `PASEO_CHAT_RELAY_MODE=auto` (`auto` posts first/final assistant text automatically; `manual` requires the office agent to call `chat.send`)
- `PASEO_CHAT_HTTP_PORT=8787` for HTTP mode
- `PASEO_CHAT_SERVICE_HOST=127.0.0.1` / `PASEO_CHAT_SERVICE_PORT=8788` for daemon-owned `chat.*` tools
- `PASEO_CHAT_PEOPLE_JSON='{"vivek":"U123..."}'` for person aliases used by `chat.send` / `chat.ask`
- `PASEO_CHAT_CHANNELS_JSON='{"growth":"C123..."}'` for optional channel-name aliases; direct channel IDs, names, and Slack permalinks do not need this map
- `PASEO_CHAT_MAX_UPLOAD_BYTES=26214400` for explicit outbound file/image upload limits

## Run

```bash
npm run build:chat
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
node packages/chat/dist/index.js
```

Mention the bot in Slack or DM it. Replies in the same thread continue the Office agent. In `PASEO_CHAT_RELAY_MODE=auto`, the bridge automatically relays first/final assistant text to the thread; if the office agent explicitly calls `chat.send` for that same binding, the explicit tool post suppresses the active auto relay for that turn. In `PASEO_CHAT_RELAY_MODE=manual`, assistant text is never auto-posted and the office agent must call `chat.send` to send Slack-visible text and/or files.

Agent-initiated `chat.*` tools call the loopback service, authenticated by the generated `$PASEO_CHAT_STATE_DIR/service-token`, so agents never receive Slack tokens and all posts/uploads still go through Chat SDK. The daemon only exposes `chat.*` tools to agents stamped with the chat office-agent label; coding subagents do not receive those tools.

## HTTP mode with a tunnel

```bash
PASEO_CHAT_SLACK_MODE=http \
PASEO_CHAT_HTTP_PORT=8787 \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_SIGNING_SECRET=... \
node packages/chat/dist/index.js
```

Expose it with a tunnel and configure Slack Event Subscriptions + Interactivity to:

```text
https://<tunnel-host>/slack/events
```

## Email intake (Resend)

Inbound support emails can start office agents through a Resend webhook. Each new email conversation posts an announcement thread into a configured Slack channel; the agent's first/final output relays there, replies in that Slack thread steer the same agent, and email replies (matched via `Message-ID` / `In-Reply-To` / `References`, plus a sender+subject fallback for internal forwards) continue the same agent instead of starting a new one. Outbound email replies are out of scope — Slack is the human reply surface.

Configure it from the app under **Settings → Office chat → Email intake** (stored as `chat.email` in `$PASEO_HOME/config.json`; no env vars):

- **Resend API key** — fetches full messages and attachments.
- **Resend webhook secret** — the Svix `whsec_…` signing secret; requests are rejected without a valid signature.
- **Slack channel** — name or `C…` id of the announce channel (names resolve through `PASEO_CHAT_CHANNELS_JSON` when set). Invite the bot to the channel.
- **Support address** (optional) — excluded from conversation matching; its domain marks internal senders for forward detection.

All three required fields enable the feature; partial config logs a warning and disables it. The inbound HTTP server starts whenever email intake is configured (even in Slack Socket Mode) and serves `POST /support-email/resend`. Point the Resend `email.received` webhook at that route on the bridge's public host. Restart the bridge after changing settings.

In Resend: verify the receiving domain (MX records), add an inbound route for the support address, and create the webhook subscription for `email.received`.
