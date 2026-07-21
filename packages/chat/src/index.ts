import { Chat, type Adapter, type Chat as ChatRuntime } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { loadConfig, type ResolvedChatBridgeConfig } from "./config.js";
import { connectToPaseoDaemon, resolveChatRepositoryPath } from "./paseo-client.js";
import { ChatBridge } from "./bridge.js";
import { FocusRelay } from "./focus.js";
import { PermissionBridge } from "./permissions.js";
import { FileChatStateAdapter } from "./state/chat-state-adapter.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";
import { startInboundHttpServer } from "./inbound-http.js";
import { GithubMergeNotifier } from "./github.js";
import { EmailIntakeBridge } from "./intake/email-bridge.js";
import { createDefaultEmailClassifier } from "./intake/email-classifier.js";
import { loadOfficePrompt } from "./prompt.js";
import { ChatBridgeService, startChatServiceServer } from "./service.js";
import { OfficeAdapter, type OfficeTurnRegistration } from "./office-adapter.js";
import { OfficeTimelineRelay } from "./office-timeline-relay.js";
import { OfficeAgentLinksReporter } from "./office-links.js";
import { CHAT_THREAD_LABEL, getBindingOwnerAgentId } from "./state/thread-session-store.js";

type PaseoDaemonClient = Awaited<ReturnType<typeof connectToPaseoDaemon>>;
type InboundHttpServer = ReturnType<typeof startInboundHttpServer>;

interface EmailIntakes {
  emailIntake: EmailIntakeBridge | null;
}

function startEmailIntakes(input: {
  config: ResolvedChatBridgeConfig;
  chat: ChatRuntime;
  slack: SlackAdapter | null;
  client: PaseoDaemonClient;
  state: ThreadSessionStore;
  bridge: ChatBridge;
}): EmailIntakes {
  const slack = input.slack;
  const classifier = input.config.emailClassifier
    ? createDefaultEmailClassifier(input.config.emailClassifier)
    : undefined;
  const emailIntake =
    input.config.email && slack
      ? new EmailIntakeBridge({
          email: input.config.email,
          relayMode: input.config.relayMode,
          stateDir: input.config.stateDir,
          maxUploadBytes: input.config.maxUploadBytes,
          officePrompt: loadOfficePrompt(input.config),
          ...(classifier ? { classifier } : {}),
          chat: {
            postChannelMessage: (channelId, message) =>
              slack.postChannelMessage(channelId, message),
            thread: (threadId) => input.chat.thread(threadId),
          },
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
  githubMergeNotifier: GithubMergeNotifier | null;
  officeWebhookEnabled: boolean;
}): InboundHttpServer | null {
  if (
    (input.config.channelAdapter !== "slack" || input.config.slackMode !== "http") &&
    !input.officeWebhookEnabled &&
    !input.emailIntake &&
    !input.githubMergeNotifier
  ) {
    return null;
  }
  return startInboundHttpServer({
    chat: input.chat,
    host: input.config.httpHost,
    port: input.config.httpPort,
    slackWebhookEnabled:
      input.config.channelAdapter === "slack" && input.config.slackMode === "http",
    officeWebhookEnabled: input.officeWebhookEnabled,
    ...(input.emailIntake && input.config.email?.provider === "resend"
      ? {
          emailWebhook: (rawBody: string, headers: Record<string, string | string[] | undefined>) =>
            input.emailIntake!.handleResendWebhook(rawBody, headers),
        }
      : {}),
    ...(input.githubMergeNotifier
      ? {
          githubWebhook: (
            rawBody: Buffer,
            headers: Record<string, string | string[] | undefined>,
          ) => input.githubMergeNotifier!.handleWebhook(rawBody, headers),
        }
      : {}),
  });
}

function logReady(input: {
  config: ResolvedChatBridgeConfig;
  client: PaseoDaemonClient;
  httpServer: InboundHttpServer | null;
  emailIntake: EmailIntakeBridge | null;
  githubMergeNotifier: GithubMergeNotifier | null;
  channelAdapter: "slack" | "office";
}): void {
  const serverInfo = input.client.getLastServerInfoMessage();
  console.log("Office chat bridge v1 ready");
  console.log(`  daemon: ${input.config.daemonHost} (${serverInfo?.serverId ?? "connected"})`);
  console.log(`  office repo: ${input.config.officeRepoPath}`);
  console.log(
    `  provider/model/mode: ${input.config.provider} / ${input.config.model} / ${input.config.modeId}`,
  );
  console.log(`  state: ${input.config.stateDir}`);
  console.log(`  channel adapter: ${input.channelAdapter}`);
  if (input.channelAdapter === "slack") console.log(`  slack mode: ${input.config.slackMode}`);
  console.log(`  relay mode: ${input.config.relayMode}`);
  console.log(
    `  chat service: http://${input.config.serviceHost}:${input.config.servicePort}/chat-bridge/rpc`,
  );
  if (input.httpServer && input.channelAdapter === "slack" && input.config.slackMode === "http") {
    console.log(`  http: http://${input.config.httpHost}:${input.config.httpPort}/slack/events`);
  }
  if (input.httpServer && input.channelAdapter === "office") {
    console.log(
      `  office webhook: http://${input.config.httpHost}:${input.config.httpPort}/chat/webhooks/office`,
    );
  }
  if (input.httpServer && input.githubMergeNotifier) {
    console.log(
      `  github webhook: http://${input.config.httpHost}:${input.config.httpPort}/github/webhook`,
    );
  }
  if (input.httpServer && input.emailIntake && input.config.email?.provider === "resend") {
    console.log(
      `  email intake: http://${input.config.httpHost}:${input.config.httpPort}/support-email/resend → #${input.config.email?.channelId}`,
    );
    if (input.config.emailClassifier) {
      console.log(
        `  email classifier: ${input.config.emailClassifier.provider} / ${input.config.emailClassifier.model} / ${input.config.emailClassifier.thinkingOptionId}`,
      );
    } else {
      console.log("  email classifier: disabled");
    }
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
  let officeTimelineRelay: OfficeTimelineRelay | null = null;
  const persistOfficeTurn = async (input: OfficeTurnRegistration & { agentId: string }) => {
    await state.updateSession(input.threadId, (session) => {
      session.lastCallbackUrl = input.callbackUrl;
      const { threadId: _threadId, ...turn } = input;
      session.activeOfficeTurn = turn;
    });
    if (input.version === 1) return;
    const session = await state.getSession(input.threadId);
    await state.registerOfficeRelay({
      externalThreadId: input.threadId,
      bindingId: input.bindingId,
      agentId: input.agentId,
      callbackUrl: input.callbackUrl,
      acknowledgedSeq: session?.officeRelay ? session.officeRelay.acknowledgedSeq : 0,
    });
    void officeTimelineRelay?.wake(input.agentId).catch((error) => {
      console.warn("Office timeline catch-up failed after accepting a turn", {
        agentId: input.agentId,
        receiptId: input.receiptId,
        error,
      });
    });
  };
  const office = config.officeAdapter
    ? new OfficeAdapter({
        ...config.officeAdapter,
        // This callback deliberately keeps receipt reservation, binding recovery, and relay
        // registration in one transaction-like flow so retries remain idempotent.
        // oxlint-disable-next-line complexity
        onTurnReceived: async (input) => {
          if (input.version === 1) {
            const existing = await state.getSession(input.threadId);
            if (!existing && input.agentId) {
              const now = new Date().toISOString();
              await state.upsertSession({
                kind: "inbound-session",
                externalThreadId: input.threadId,
                rootAgentId: input.agentId,
                muted: false,
                activeRelayId: null,
                title: input.title ?? null,
                createdAt: now,
                updatedAt: now,
              });
            } else if (
              existing &&
              input.agentId &&
              getBindingOwnerAgentId(existing) !== input.agentId
            ) {
              throw new Error("OFFICE_AGENT_MISMATCH");
            }
            return existing?.activeOfficeTurn?.receiptId === input.receiptId
              ? "alreadyReceived"
              : "received";
          }
          const receiptOutcome = await state.reserveOfficeDispatch({
            receiptId: input.receiptId,
            runId: input.runId,
            payloadDigest: input.payloadDigest,
          });
          let existing = await state.getSession(input.threadId);
          if (!existing && !input.agentId && receiptOutcome === "alreadyReceived") {
            const recovered = await client.fetchAgents({
              filter: { labels: { [CHAT_THREAD_LABEL]: input.threadId } },
              page: { limit: 2 },
            });
            if (recovered.entries.length > 1) throw new Error("OFFICE_AGENT_BINDING_CONFLICT");
            const agent = recovered.entries[0]?.agent;
            if (agent) {
              const now = new Date().toISOString();
              await state.upsertSession({
                kind: "inbound-session",
                externalThreadId: input.threadId,
                rootAgentId: agent.id,
                ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
                muted: false,
                activeRelayId: null,
                title: input.title ?? agent.title ?? null,
                createdAt: now,
                updatedAt: now,
              });
              existing = await state.getSession(input.threadId);
            }
          }
          if (!existing) {
            if (!input.agentId) return "received";
            const now = new Date().toISOString();
            await state.upsertSession({
              kind: "inbound-session",
              externalThreadId: input.threadId,
              rootAgentId: input.agentId,
              muted: false,
              activeRelayId: null,
              title: input.title ?? null,
              createdAt: now,
              updatedAt: now,
            });
            existing = await state.getSession(input.threadId);
          } else if (input.agentId && getBindingOwnerAgentId(existing) !== input.agentId) {
            throw new Error("OFFICE_AGENT_MISMATCH");
          }
          if (existing && input.agentId && !existing.officeRelay) {
            const timeline = await client.fetchAgentTimeline(input.agentId, {
              direction: "tail",
              projection: "projected",
              limit: 1,
            });
            await state.registerOfficeRelay({
              externalThreadId: input.threadId,
              bindingId: input.bindingId,
              agentId: input.agentId,
              callbackUrl: input.callbackUrl,
              acknowledgedSeq: Math.max(0, timeline.window.nextSeq - 1),
            });
          }
          return receiptOutcome;
        },
        onTurnBound: persistOfficeTurn,
        onTurnCompleted: async (threadId, providerTurnId) => {
          await state.updateSession(threadId, (session) => {
            if (
              session.activeOfficeTurn?.version === 1 &&
              session.activeOfficeTurn.providerTurnId === providerTurnId
            )
              session.activeOfficeTurn = undefined;
          });
        },
        resolveAgentId: async (threadId) => {
          const session = await state.getSession(threadId);
          return session ? getBindingOwnerAgentId(session) : null;
        },
        resolveTurn: async (threadId) =>
          (await state.getSession(threadId))?.activeOfficeTurn ?? null,
        resolveRelay: async (threadId) => (await state.getSession(threadId))?.officeRelay ?? null,
        registerRelay: async (input) => {
          const externalThreadId = `office:${input.bindingId}`;
          let session = await state.getSession(externalThreadId);
          if (!session) {
            const legacy = await state.findSessionByAgent(input.agentId);
            const now = new Date().toISOString();
            await state.upsertSession({
              kind: "inbound-session",
              externalThreadId,
              rootAgentId: input.agentId,
              ...(legacy?.kind === "inbound-session" && legacy.workspaceId
                ? { workspaceId: legacy.workspaceId }
                : {}),
              muted: false,
              activeRelayId: null,
              title: legacy?.title ?? null,
              createdAt: now,
              updatedAt: now,
            });
            session = await state.getSession(externalThreadId);
          }
          if (!session || getBindingOwnerAgentId(session) !== input.agentId)
            throw new Error("OFFICE_AGENT_MISMATCH");
          const timeline = await client.fetchAgentTimeline(input.agentId, {
            direction: "tail",
            projection: "projected",
            limit: 1,
          });
          return state.registerOfficeRelay({
            externalThreadId,
            bindingId: input.bindingId,
            agentId: input.agentId,
            callbackUrl: input.callbackUrl,
            acknowledgedSeq: Math.max(0, timeline.window.nextSeq - 1),
          });
        },
        cancelTurn: async (input) => {
          const session = await state.getSession(`office:${input.bindingId}`);
          if (!session || getBindingOwnerAgentId(session) !== input.agentId)
            throw new Error("OFFICE_AGENT_MISMATCH");
          await client.cancelAgent(input.agentId);
          return "accepted";
        },
      })
    : null;
  const slack =
    config.channelAdapter === "slack"
      ? createSlackAdapter({
          mode: config.slackMode === "http" ? "webhook" : "socket",
          botToken: process.env.SLACK_BOT_TOKEN,
          appToken: process.env.SLACK_APP_TOKEN,
          signingSecret: process.env.SLACK_SIGNING_SECRET,
        })
      : null;
  const activeAdapter: Adapter = office ?? slack!;
  const bridge = new ChatBridge(config, client, state, permissions, focus, activeAdapter);
  officeTimelineRelay = office ? new OfficeTimelineRelay(client, state, office) : null;
  const chat = new Chat({
    adapters: office ? { office } : { slack: slack! },
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
    const event = message.payload.event;
    if (officeTimelineRelay) {
      let terminal:
        | { kind: "completed" }
        | { kind: "failed"; errorCode: string }
        | { kind: "canceled"; errorCode: string }
        | undefined;
      if (event.type === "turn_completed") {
        terminal = { kind: "completed" };
      } else if (event.type === "turn_failed") {
        terminal = { kind: "failed", errorCode: event.code ?? event.error };
      } else if (event.type === "turn_canceled") {
        terminal = { kind: "canceled", errorCode: event.reason };
      }
      if (event.type === "timeline" || event.type === "turn_started" || terminal) {
        await officeTimelineRelay.wake(message.payload.agentId, terminal).catch((error) => {
          console.warn("Office timeline relay failed", {
            agentId: message.payload.agentId,
            eventType: event.type,
            error,
          });
        });
      }
      return;
    }
    if (event.type === "turn_started")
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
  void officeTimelineRelay?.recover().catch((error) => {
    console.warn("Office timeline relay recovery failed", error);
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
  const agentLinksReporter = config.officeAdapter
    ? new OfficeAgentLinksReporter({
        client,
        store: state,
        callbackKeyId: config.officeAdapter.callbackKeyId,
        callbackSecret: config.officeAdapter.callbackSecret,
        deepLinkBaseUrl: config.deepLinkBaseUrl,
      })
    : null;
  agentLinksReporter?.start();
  const { emailIntake } = startEmailIntakes({ config, chat, slack, client, state, bridge });
  const githubMergeNotifier = config.githubWebhookSecret
    ? new GithubMergeNotifier(config.githubWebhookSecret, state, client)
    : null;
  const httpServer = startHttpBridge({
    config,
    chat,
    emailIntake,
    githubMergeNotifier,
    officeWebhookEnabled: Boolean(office),
  });
  logReady({
    config,
    client,
    httpServer,
    emailIntake,
    githubMergeNotifier,
    channelAdapter: config.channelAdapter,
  });

  const shutdown = async () => {
    clearInterval(askExpiryInterval);
    agentLinksReporter?.stop();
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
