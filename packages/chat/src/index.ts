import { Chat, type Chat as ChatRuntime } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { loadConfig, type ResolvedChatBridgeConfig } from "./config.js";
import { connectToPaseoDaemon, resolveChatRepositoryPath } from "./paseo-client.js";
import { ChatBridge } from "./bridge.js";
import { FocusRelay } from "./focus.js";
import { PermissionBridge } from "./permissions.js";
import { FileChatStateAdapter } from "./state/chat-state-adapter.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";
import { startInboundHttpServer } from "./inbound-http.js";
import { EmailIntakeBridge } from "./intake/email-bridge.js";
import { createDefaultEmailClassifier } from "./intake/email-classifier.js";
import { loadOfficePrompt } from "./prompt.js";
import { ChatBridgeService, startChatServiceServer } from "./service.js";

type PaseoDaemonClient = Awaited<ReturnType<typeof connectToPaseoDaemon>>;
type InboundHttpServer = ReturnType<typeof startInboundHttpServer>;

interface EmailIntakes {
  emailIntake: EmailIntakeBridge | null;
}

function startEmailIntakes(input: {
  config: ResolvedChatBridgeConfig;
  chat: ChatRuntime;
  client: PaseoDaemonClient;
  state: ThreadSessionStore;
  bridge: ChatBridge;
}): EmailIntakes {
  const emailIntake = input.config.email
    ? new EmailIntakeBridge({
        email: input.config.email,
        relayMode: input.config.relayMode,
        stateDir: input.config.stateDir,
        maxUploadBytes: input.config.maxUploadBytes,
        officePrompt: loadOfficePrompt(input.config),
        classifier: createDefaultEmailClassifier(),
        chat: input.chat,
        client: input.client,
        store: input.state,
        bridge: input.bridge,
      })
    : null;
  return { emailIntake };
}

function startHttpBridge(input: {
  config: ResolvedChatBridgeConfig;
  chat: ChatRuntime;
  emailIntake: EmailIntakeBridge | null;
}): InboundHttpServer | null {
  if (input.config.slackMode !== "http" && !input.emailIntake) {
    return null;
  }
  return startInboundHttpServer({
    chat: input.chat,
    host: input.config.httpHost,
    port: input.config.httpPort,
    slackWebhookEnabled: input.config.slackMode === "http",
    ...(input.emailIntake && input.config.email?.provider === "resend"
      ? {
          emailWebhook: (rawBody: string, headers: Record<string, string | string[] | undefined>) =>
            input.emailIntake!.handleResendWebhook(rawBody, headers),
        }
      : {}),
  });
}

function logReady(input: {
  config: ResolvedChatBridgeConfig;
  client: PaseoDaemonClient;
  httpServer: InboundHttpServer | null;
  emailIntake: EmailIntakeBridge | null;
}): void {
  const serverInfo = input.client.getLastServerInfoMessage();
  console.log("Office chat bridge v1 ready");
  console.log(`  daemon: ${input.config.daemonHost} (${serverInfo?.serverId ?? "connected"})`);
  console.log(`  office repo: ${input.config.officeRepoPath}`);
  console.log(
    `  provider/model/mode: ${input.config.provider} / ${input.config.model} / ${input.config.modeId}`,
  );
  console.log(`  state: ${input.config.stateDir}`);
  console.log(`  slack mode: ${input.config.slackMode}`);
  console.log(`  relay mode: ${input.config.relayMode}`);
  console.log(
    `  chat service: http://${input.config.serviceHost}:${input.config.servicePort}/chat-bridge/rpc`,
  );
  if (input.httpServer && input.config.slackMode === "http") {
    console.log(`  http: http://${input.config.httpHost}:${input.config.httpPort}/slack/events`);
  }
  if (input.httpServer && input.emailIntake && input.config.email?.provider === "resend") {
    console.log(
      `  email intake: http://${input.config.httpHost}:${input.config.httpPort}/support-email/resend → #${input.config.email?.channelId}`,
    );
  }
}

export async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const client = await connectToPaseoDaemon(baseConfig);
  const config = {
    ...baseConfig,
    officeRepoPath: await resolveChatRepositoryPath(client, baseConfig.repository),
  };
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
    // Email-created sessions never had a live inbound Thread; rehydrate one
    // from the id so permission prompts still reach the Slack thread.
    const thread =
      bridge.getThread(session.externalThreadId) ?? chat.thread(session.externalThreadId);
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
  const { emailIntake } = startEmailIntakes({ config, chat, client, state, bridge });
  const httpServer = startHttpBridge({ config, chat, emailIntake });
  logReady({ config, client, httpServer, emailIntake });

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
