import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { loadConfig } from "./config.js";
import { connectToPaseoDaemon } from "./paseo-client.js";
import { ChatBridge } from "./bridge.js";
import { FocusRelay } from "./focus.js";
import { PermissionBridge } from "./permissions.js";
import { FileChatStateAdapter } from "./state/chat-state-adapter.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";
import { startInboundHttpServer } from "./inbound-http.js";
import { ChatBridgeService, startChatServiceServer } from "./service.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const client = await connectToPaseoDaemon(config);
  const state = new ThreadSessionStore(config.stateDir);
  const chatState = new FileChatStateAdapter(config.stateDir);
  const permissions = new PermissionBridge(client, state);
  const focus = new FocusRelay(client, state);
  const slack = createSlackAdapter({
    mode: config.slackMode === "http" ? "webhook" : "socket",
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  });
  const bridge = new ChatBridge(config, client, state, permissions, focus, slack);
  const chat = new Chat({
    adapters: { slack },
    state: chatState,
    userName: process.env.PASEO_CHAT_BOT_NAME ?? "cto",
    concurrency: "queue",
    dedupeTtlMs: 10 * 60 * 1000,
    streamingUpdateIntervalMs: 500,
    fallbackStreamingPlaceholderText: "Working...",
  });

  permissions.register(chat);
  chat.onNewMention((thread, message) => bridge.handleMessage(thread, message, "mention"));
  chat.onDirectMessage((thread, message) => bridge.handleMessage(thread, message, "dm"));
  chat.onSubscribedMessage((thread, message) =>
    bridge.handleMessage(thread, message, "subscribed"),
  );

  client.on("agent_stream", async (message) => {
    if (message.payload.event.type !== "turn_started") return;
    await bridge.handleAgentTurnStarted(message.payload.agentId, message.payload.seq);
  });

  client.on("agent_permission_request", async (message) => {
    const session = await state.findSessionByAgent(message.payload.agentId);
    if (!session) return;
    const thread = bridge.getThread(session.externalThreadId);
    if (!thread) return;
    await permissions.handlePermission(message, thread, session.externalThreadId);
  });

  await chat.initialize();
  void bridge.recoverRelaysAfterRestart().catch((error) => {
    console.warn("Slack relay recovery failed", error);
  });
  void bridge.expirePendingRequests().catch((error) => {
    console.warn("Chat ask recovery failed", error);
  });
  const askExpiryInterval = setInterval(() => {
    void bridge.expirePendingRequests().catch((error) => {
      console.warn("Chat ask expiry failed", error);
    });
  }, 60_000);
  const service = new ChatBridgeService(chat, client, state, config);
  const serviceServer = await startChatServiceServer({
    service,
    host: config.serviceHost,
    port: config.servicePort,
    tokenPath: config.serviceTokenPath,
  });
  const httpServer =
    config.slackMode === "http"
      ? startInboundHttpServer({ chat, host: config.httpHost, port: config.httpPort })
      : null;
  const serverInfo = client.getLastServerInfoMessage();
  console.log("Office chat bridge v1 ready");
  console.log(`  daemon: ${config.daemonHost} (${serverInfo?.serverId ?? "connected"})`);
  console.log(`  office repo: ${config.officeRepoPath}`);
  console.log(`  provider/model/mode: ${config.provider} / ${config.model} / ${config.modeId}`);
  console.log(`  state: ${config.stateDir}`);
  console.log(`  slack mode: ${config.slackMode}`);
  console.log(`  chat service: http://${config.serviceHost}:${config.servicePort}/chat-bridge/rpc`);
  if (httpServer) {
    console.log(`  http: http://${config.httpHost}:${config.httpPort}/slack/events`);
  }

  const shutdown = async () => {
    clearInterval(askExpiryInterval);
    serviceServer.close();
    httpServer?.close();
    await chat.shutdown().catch(() => {});
    await client.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
