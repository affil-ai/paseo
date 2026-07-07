import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

const DEFAULT_DAEMON_HOST = "localhost:6767";

export type ChatRelayMode = "auto" | "manual";
export type ChatEmailProvider = "resend" | "none";

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
  PASEO_CHAT_EMAIL_PROVIDER: z.string().optional(),
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
  provider: "resend";
  channelId: string;
  supportAddress?: string;
}

export interface ResendChatEmailConfig extends BaseChatEmailConfig {
  provider: "resend";
  apiKey: string;
  webhookSecret: string;
}

export type ChatEmailConfig = ResendChatEmailConfig;

export interface ChatRepositoryConfig {
  projectId?: string;
  projectRootPath: string;
  projectDisplayName?: string;
}

function inferEmailProvider(input: {
  provider?: string | undefined;
  hasResendConfig: boolean;
}): string {
  if (input.provider?.trim()) return input.provider.trim().toLowerCase();
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
  provider: string | undefined,
  email: z.infer<typeof chatEmailSchema>,
  channels: Record<string, string>,
  warn: (message: string) => void = (message) => console.warn(message),
): ChatEmailConfig | null {
  const { resendApiKey, resendWebhookSecret, channel } = email;
  const hasResendConfig = Boolean(resendApiKey || resendWebhookSecret);
  const resolvedProvider = inferEmailProvider({ provider, hasResendConfig });
  if (resolvedProvider === "none") return null;
  if (resolvedProvider !== "resend") {
    warn(`Email intake is disabled: unsupported provider "${resolvedProvider}".`);
    return null;
  }
  const channelId = resolveEmailChannelId(channel, channels, warn);
  if (!channelId) return null;
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
    email: resolveEmailConfig(parsed.PASEO_CHAT_EMAIL_PROVIDER, persistedEmail, channels),
    repository: resolveRepositoryConfig(persistedRepository),
    maxUploadBytes: parsed.PASEO_CHAT_MAX_UPLOAD_BYTES,
  };
}
