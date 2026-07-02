# @getpaseo/chat

Slack bridge for Office. It runs next to the local daemon, listens for Slack mentions/DMs through Chat SDK, starts one office agent per Slack thread, and relays office-agent turns back to Slack.

## Environment

Required:

- `PASEO_CHAT_OFFICE_REPO=/absolute/path/to/office`
- Slack adapter env from `@chat-adapter/slack`:
  - `SLACK_BOT_TOKEN=xoxb-...`
  - Socket mode: `SLACK_APP_TOKEN=xapp-...`
  - HTTP mode: `SLACK_SIGNING_SECRET=...`

Optional:

- `PASEO_CHAT_DAEMON_HOST=localhost:6767`
- `PASEO_PASSWORD=...` if your daemon requires it
- `PASEO_CHAT_DEEP_LINK_BASE_URL=http://localhost:6767`
- `PASEO_CHAT_PROVIDER=pi`
- `PASEO_CHAT_MODEL=openai-codex/gpt-5.5`
- `PASEO_CHAT_MODE_ID=medium`
- `PASEO_CHAT_OFFICE_PROMPT_PATH=/path/to/prompt.md`
- `PASEO_CHAT_ACK_EMOJI=cto`
- `PASEO_CHAT_STATE_DIR=$PASEO_HOME/chat-bridge`
- `PASEO_CHAT_SLACK_MODE=socket` (`socket` or `http`)
- `PASEO_CHAT_HTTP_PORT=8787` for HTTP mode
- `PASEO_CHAT_SERVICE_HOST=127.0.0.1` / `PASEO_CHAT_SERVICE_PORT=8788` for daemon-owned `chat.*` tools
- `PASEO_CHAT_PEOPLE_JSON='{"vivek":"U123..."}'` for person aliases used by `chat.startConversation` / `chat.askPerson`
- `PASEO_CHAT_CHANNELS_JSON='{"growth":"C123..."}'` for optional channel-name aliases; direct channel IDs, names, and Slack permalinks do not need this map
- `PASEO_CHAT_MAX_UPLOAD_BYTES=26214400` for explicit outbound file/image upload limits

## Run

```bash
npm run build:chat
PASEO_CHAT_OFFICE_REPO=/path/to/office \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
node packages/chat/dist/index.js
```

Mention the bot in Slack or DM it. Replies in the same thread continue the Office agent. Agent-initiated `chat.*` tools call the loopback service, authenticated by the generated `$PASEO_CHAT_STATE_DIR/service-token`, so agents never receive Slack tokens and all posts/uploads still go through Chat SDK.

## HTTP mode with a tunnel

```bash
PASEO_CHAT_SLACK_MODE=http \
PASEO_CHAT_HTTP_PORT=8787 \
PASEO_CHAT_OFFICE_REPO=/path/to/office \
SLACK_BOT_TOKEN=xoxb-... \
SLACK_SIGNING_SECRET=... \
node packages/chat/dist/index.js
```

Expose it with a tunnel and configure Slack Event Subscriptions + Interactivity to:

```text
https://<tunnel-host>/slack/events
```
