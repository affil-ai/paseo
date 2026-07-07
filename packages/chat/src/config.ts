import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

const DEFAULT_DAEMON_HOST = "localhost:6767";

export type ChatRelayMode = "auto" | "manual";
export type ChatEmailProvider = "gmail" | "resend" | "none";

function resolveHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolvePaseoHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(resolveHome(env.PASEO_HOME?.trim() || "~/.paseo"));
}

function parseJsonMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const parsed = z.record(z.string(), z.string()).parse(JSON.parse(value));
  return Object.fromEntries(
    Object.entries(parsed).map(([key, entry]) => [key.toLowerCase(), entry]),
  );
}

const envSchema = z.object({
  PASEO_CHAT_PROVIDER: z.string().default("pi"),
  PASEO_CHAT_MODEL: z.string().default("openai-codex/gpt-5.5"),
  PASEO_CHAT_MODE_ID: z.string().default("medium"),
  PASEO_CHAT_ACK_EMOJI: z.string().optional(),
  PASEO_CHAT_OFFICE_PROMPT_PATH: z.string().optional(),
  PASEO_CHAT_DEEP_LINK_BASE_URL: z.string().default("http://localhost:6767"),
  PASEO_CHAT_DAEMON_HOST: z.string().default(DEFAULT_DAEMON_HOST),
  PASEO_CHAT_STATE_DIR: z.string().optional(),
  PASEO_CHAT_SHOW_REASONING: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
  PASEO_CHAT_RELAY_MODE: z.enum(["auto", "manual"]).default("auto"),
  PASEO_CHAT_SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
  PASEO_CHAT_HTTP_HOST: z.string().default("127.0.0.1"),
  PASEO_CHAT_HTTP_PORT: z.coerce.number().int().positive().default(8787),
  PASEO_CHAT_SERVICE_HOST: z.string().default("127.0.0.1"),
  PASEO_CHAT_SERVICE_PORT: z.coerce.number().int().positive().default(8788),
  PASEO_CHAT_EMAIL_PROVIDER: z.enum(["gmail", "resend", "none"]).optional(),
  PASEO_CHAT_EMAIL_INBOX: z.string().optional(),
  GMAIL_OAUTH_CLIENT_ID: z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  GMAIL_WEBHOOK_TOKEN: z.string().optional(),
  PASEO_CHAT_PEOPLE_JSON: z.string().optional(),
  PASEO_CHAT_CHANNELS_JSON: z.string().optional(),
  PASEO_CHAT_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  PASEO_PASSWORD: z.string().optional(),
  PASEO_HOME: z.string().optional(),
});

const chatDefaultsSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    modeId: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .partial();

const chatEmailSchema = z
  .object({
    resendApiKey: z.string().min(1).optional(),
    resendWebhookSecret: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    supportAddress: z.string().min(1).optional(),
  })
  .partial();

const chatRepositorySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    projectRootPath: z.string().min(1).optional(),
    projectDisplayName: z.string().min(1).optional(),
  })
  .partial();

function loadPersistedChatDefaults(paseoHome: string) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(paseoHome, "config.json"), "utf8"));
    return chatDefaultsSchema.parse(parsed?.chat?.defaults ?? {});
  } catch {
    return {};
  }
}

function loadPersistedChatEmail(paseoHome: string) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(paseoHome, "config.json"), "utf8"));
    return chatEmailSchema.parse(parsed?.chat?.email ?? {});
  } catch {
    return {};
  }
}

function loadPersistedChatRepository(paseoHome: string) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(paseoHome, "config.json"), "utf8"));
    return chatRepositorySchema.parse(parsed?.chat?.repository ?? {});
  } catch {
    return {};
  }
}

interface BaseChatEmailConfig {
  provider: "gmail" | "resend";
  channelId: string;
  supportAddress?: string;
}

export interface ResendChatEmailConfig extends BaseChatEmailConfig {
  provider: "resend";
  apiKey: string;
  webhookSecret: string;
}

export interface GmailChatEmailConfig extends BaseChatEmailConfig {
  provider: "gmail";
  inboxEmail: string;
  oauthClientId: string;
  oauthClientSecret: string;
  refreshToken: string;
  pubsubTopic: string;
  webhookToken: string;
}

export type ChatEmailConfig = ResendChatEmailConfig | GmailChatEmailConfig;

interface GmailEmailEnv {
  inboxEmail?: string | undefined;
  oauthClientId?: string | undefined;
  oauthClientSecret?: string | undefined;
  refreshToken?: string | undefined;
  pubsubTopic?: string | undefined;
  webhookToken?: string | undefined;
}

export interface ChatRepositoryConfig {
  projectId?: string;
  projectRootPath: string;
  projectDisplayName?: string;
}

function inferEmailProvider(input: {
  provider?: ChatEmailProvider | undefined;
  hasGmailConfig: boolean;
  hasResendConfig: boolean;
}): ChatEmailProvider {
  if (input.provider) return input.provider;
  if (input.hasGmailConfig) return "gmail";
  if (input.hasResendConfig) return "resend";
  return "none";
}

function resolveEmailChannelId(
  channel: string | undefined,
  channels: Record<string, string>,
  warn: (message: string) => void,
): string | null {
  if (!channel) {
    warn("Email intake is disabled: chat.email.channel is not configured.");
    return null;
  }
  const channelName = channel.replace(/^#/, "");
  return channels[channelName.toLowerCase()] ?? channelName;
}

function resolveGmailEmailConfig(
  env: GmailEmailEnv,
  channelId: string,
  warn: (message: string) => void,
): GmailChatEmailConfig | null {
  const required = {
    inboxEmail: env.inboxEmail?.trim(),
    oauthClientId: env.oauthClientId?.trim(),
    oauthClientSecret: env.oauthClientSecret?.trim(),
    refreshToken: env.refreshToken?.trim(),
    pubsubTopic: env.pubsubTopic?.trim(),
    webhookToken: env.webhookToken?.trim(),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    warn(`Gmail email intake is disabled: missing ${missing.join(", ")}.`);
    return null;
  }
  return {
    provider: "gmail",
    channelId,
    inboxEmail: required.inboxEmail!,
    oauthClientId: required.oauthClientId!,
    oauthClientSecret: required.oauthClientSecret!,
    refreshToken: required.refreshToken!,
    pubsubTopic: required.pubsubTopic!,
    webhookToken: required.webhookToken!,
    supportAddress: required.inboxEmail!.toLowerCase(),
  };
}

function resolveResendEmailConfig(
  email: z.infer<typeof chatEmailSchema>,
  channelId: string,
  warn: (message: string) => void,
): ResendChatEmailConfig | null {
  const { resendApiKey, resendWebhookSecret } = email;
  if (!resendApiKey || !resendWebhookSecret) {
    const missing = [
      ...(resendApiKey ? [] : ["resendApiKey"]),
      ...(resendWebhookSecret ? [] : ["resendWebhookSecret"]),
    ];
    warn(
      `Email intake is disabled: chat.email settings are incomplete (missing: ${missing.join(", ")})`,
    );
    return null;
  }
  return {
    provider: "resend",
    apiKey: resendApiKey,
    webhookSecret: resendWebhookSecret,
    channelId,
    ...(email.supportAddress ? { supportAddress: email.supportAddress.toLowerCase() } : {}),
  };
}

export function resolveEmailConfig(
  provider: ChatEmailProvider | undefined,
  email: z.infer<typeof chatEmailSchema>,
  env: GmailEmailEnv,
  channels: Record<string, string>,
  warn: (message: string) => void = (message) => console.warn(message),
): ChatEmailConfig | null {
  const { resendApiKey, resendWebhookSecret, channel } = email;
  const gmailValues = [
    env.inboxEmail,
    env.oauthClientId,
    env.oauthClientSecret,
    env.refreshToken,
    env.pubsubTopic,
    env.webhookToken,
  ];
  const hasGmailConfig = gmailValues.some((value) => value?.trim());
  const hasResendConfig = Boolean(resendApiKey || resendWebhookSecret);
  const resolvedProvider = inferEmailProvider({ provider, hasGmailConfig, hasResendConfig });
  if (resolvedProvider === "none") return null;
  const channelId = resolveEmailChannelId(channel, channels, warn);
  if (!channelId) return null;

  if (resolvedProvider === "gmail") {
    return resolveGmailEmailConfig(env, channelId, warn);
  }

  return resolveResendEmailConfig(email, channelId, warn);
}

export function resolveRepositoryConfig(
  repository: z.infer<typeof chatRepositorySchema>,
): ChatRepositoryConfig | null {
  const projectRootPath = repository.projectRootPath?.trim();
  if (!projectRootPath) return null;
  return {
    ...(repository.projectId?.trim() ? { projectId: repository.projectId.trim() } : {}),
    projectRootPath,
    ...(repository.projectDisplayName?.trim()
      ? { projectDisplayName: repository.projectDisplayName.trim() }
      : {}),
  };
}

export type ChatBridgeConfig = ReturnType<typeof loadConfig>;
export type ResolvedChatBridgeConfig = ChatBridgeConfig & { officeRepoPath: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const paseoHome = resolvePaseoHome(env);
  const persistedDefaults = loadPersistedChatDefaults(paseoHome);
  const persistedEmail = loadPersistedChatEmail(paseoHome);
  const persistedRepository = loadPersistedChatRepository(paseoHome);
  const channels = parseJsonMap(parsed.PASEO_CHAT_CHANNELS_JSON);
  return {
    provider: persistedDefaults.provider ?? parsed.PASEO_CHAT_PROVIDER,
    model: persistedDefaults.model ?? parsed.PASEO_CHAT_MODEL,
    modeId: persistedDefaults.modeId ?? parsed.PASEO_CHAT_MODE_ID,
    thinkingOptionId: persistedDefaults.thinkingOptionId,
    ackEmoji: parsed.PASEO_CHAT_ACK_EMOJI,
    officePromptPath: parsed.PASEO_CHAT_OFFICE_PROMPT_PATH
      ? path.resolve(resolveHome(parsed.PASEO_CHAT_OFFICE_PROMPT_PATH))
      : undefined,
    deepLinkBaseUrl: parsed.PASEO_CHAT_DEEP_LINK_BASE_URL.replace(/\/$/, ""),
    daemonHost: parsed.PASEO_CHAT_DAEMON_HOST,
    daemonPassword: parsed.PASEO_PASSWORD,
    paseoHome,
    stateDir: path.resolve(
      resolveHome(parsed.PASEO_CHAT_STATE_DIR ?? path.join(paseoHome, "chat-bridge")),
    ),
    showReasoning: parsed.PASEO_CHAT_SHOW_REASONING ?? false,
    relayMode: parsed.PASEO_CHAT_RELAY_MODE,
    slackMode: parsed.PASEO_CHAT_SLACK_MODE,
    httpHost: parsed.PASEO_CHAT_HTTP_HOST,
    httpPort: parsed.PASEO_CHAT_HTTP_PORT,
    serviceHost: parsed.PASEO_CHAT_SERVICE_HOST,
    servicePort: parsed.PASEO_CHAT_SERVICE_PORT,
    serviceTokenPath: path.join(
      path.resolve(resolveHome(parsed.PASEO_CHAT_STATE_DIR ?? path.join(paseoHome, "chat-bridge"))),
      "service-token",
    ),
    people: parseJsonMap(parsed.PASEO_CHAT_PEOPLE_JSON),
    channels,
    email: resolveEmailConfig(
      parsed.PASEO_CHAT_EMAIL_PROVIDER,
      persistedEmail,
      {
        inboxEmail: parsed.PASEO_CHAT_EMAIL_INBOX,
        oauthClientId: parsed.GMAIL_OAUTH_CLIENT_ID,
        oauthClientSecret: parsed.GMAIL_OAUTH_CLIENT_SECRET,
        refreshToken: parsed.GMAIL_REFRESH_TOKEN,
        pubsubTopic: parsed.GMAIL_PUBSUB_TOPIC,
        webhookToken: parsed.GMAIL_WEBHOOK_TOKEN,
      },
      channels,
    ),
    repository: resolveRepositoryConfig(persistedRepository),
    maxUploadBytes: parsed.PASEO_CHAT_MAX_UPLOAD_BYTES,
  };
}
