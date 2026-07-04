import os from "node:os";
import path from "node:path";
import { z } from "zod";

const DEFAULT_DAEMON_HOST = "localhost:6767";

export type ChatRelayMode = "auto" | "manual";

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
  PASEO_CHAT_OFFICE_REPO: z.string().min(1),
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

export type ChatBridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const paseoHome = resolvePaseoHome(env);
  return {
    officeRepoPath: path.resolve(resolveHome(parsed.PASEO_CHAT_OFFICE_REPO)),
    provider: parsed.PASEO_CHAT_PROVIDER,
    model: parsed.PASEO_CHAT_MODEL,
    modeId: parsed.PASEO_CHAT_MODE_ID,
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
    channels: parseJsonMap(parsed.PASEO_CHAT_CHANNELS_JSON),
    maxUploadBytes: parsed.PASEO_CHAT_MAX_UPLOAD_BYTES,
  };
}
