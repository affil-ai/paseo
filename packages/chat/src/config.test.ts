import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveEmailConfig, resolveRepositoryConfig } from "./config.js";

const tempDirs: string[] = [];

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveEmailConfig", () => {
  it("returns null without warning when nothing is configured", () => {
    const warnings: string[] = [];
    expect(
      resolveEmailConfig(undefined, {}, {}, (message: string) => warnings.push(message)),
    ).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("warns and disables when only some fields are set", () => {
    const warnings: string[] = [];
    const resolved = resolveEmailConfig(
      undefined,
      { resendApiKey: "re_123" },
      {},
      (message: string) => warnings.push(message),
    );
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("chat.email.channel");
  });

  it("resolves a channel name through the channels map", () => {
    const resolved = resolveEmailConfig(
      "resend",
      {
        resendApiKey: "re_123",
        resendWebhookSecret: "whsec_abc",
        channel: "#Support-Emails",
        supportAddress: "Support@Affil.ai",
      },
      { "support-emails": "C123456" },
    );
    expect(resolved).toEqual({
      provider: "resend",
      apiKey: "re_123",
      webhookSecret: "whsec_abc",
      channelId: "C123456",
      supportAddress: "support@affil.ai",
    });
  });

  it("passes through a raw channel id when no map entry exists", () => {
    const resolved = resolveEmailConfig(
      "resend",
      { resendApiKey: "re_123", resendWebhookSecret: "whsec_abc", channel: "C987654" },
      {},
    );
    expect(resolved?.channelId).toBe("C987654");
    expect(resolved?.supportAddress).toBeUndefined();
  });

  it("warns and disables unsupported legacy providers", () => {
    const warnings: string[] = [];
    const resolved = resolveEmailConfig(
      "gmail",
      { resendApiKey: "re_123", resendWebhookSecret: "whsec_abc", channel: "support-emails" },
      { "support-emails": "C42" },
      (message: string) => warnings.push(message),
    );
    expect(resolved).toBeNull();
    expect(warnings[0]).toContain('unsupported provider "gmail"');
  });
});

describe("loadConfig GitHub webhook", () => {
  it("reads the GitHub webhook secret from env", async () => {
    const home = await createTempHome();
    const config = loadConfig({
      PASEO_HOME: home,
      PASEO_CHAT_GITHUB_WEBHOOK_SECRET: " whsec_123 ",
    } as NodeJS.ProcessEnv);

    expect(config.githubWebhookSecret).toBe("whsec_123");
  });
});

describe("loadConfig Office adapter", () => {
  it("keeps Slack as the default channel adapter", async () => {
    const home = await createTempHome();
    const config = loadConfig({ PASEO_HOME: home } as NodeJS.ProcessEnv);

    expect(config.channelAdapter).toBe("slack");
    expect(config.officeAdapter).toBeNull();
  });

  it("requires and resolves the Office ingress and callback credentials", async () => {
    const home = await createTempHome();
    expect(() =>
      loadConfig({
        PASEO_HOME: home,
        PASEO_CHAT_CHANNEL_ADAPTER: "office",
      } as NodeJS.ProcessEnv),
    ).toThrow("PASEO_CHAT_OFFICE_TOKEN");

    const config = loadConfig({
      PASEO_HOME: home,
      PASEO_CHAT_CHANNEL_ADAPTER: "office",
      PASEO_CHAT_OFFICE_TOKEN: " ingress-token ",
      PASEO_CHAT_OFFICE_CALLBACK_KEY_ID: " callback-key ",
      PASEO_CHAT_OFFICE_CALLBACK_SECRET: " callback-secret ",
    } as NodeJS.ProcessEnv);
    expect(config.officeAdapter).toEqual({
      inboundToken: "ingress-token",
      callbackKeyId: "callback-key",
      callbackSecret: "callback-secret",
    });
  });
});

describe("loadConfig chat.email", () => {
  it("reads chat.email from the persisted config.json", async () => {
    const home = await createTempHome();
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        chat: {
          email: {
            resendApiKey: "re_123",
            resendWebhookSecret: "whsec_abc",
            channel: "support-emails",
          },
        },
      }),
    );
    const config = loadConfig({
      PASEO_HOME: home,
      PASEO_CHAT_CHANNELS_JSON: JSON.stringify({ "support-emails": "C42" }),
    } as NodeJS.ProcessEnv);
    expect(config.email).toEqual({
      provider: "resend",
      apiKey: "re_123",
      webhookSecret: "whsec_abc",
      channelId: "C42",
    });
  });

  it("leaves email null when config.json has no chat.email", async () => {
    const home = await createTempHome();
    await writeFile(join(home, "config.json"), JSON.stringify({ chat: {} }));
    const config = loadConfig({ PASEO_HOME: home } as NodeJS.ProcessEnv);
    expect(config.email).toBeNull();
  });
});

describe("loadConfig chat.defaults", () => {
  it("defaults chat-created agents to Pi with OpenRouter Fable 5 high thinking", async () => {
    const home = await createTempHome();
    const config = loadConfig({ PASEO_HOME: home } as NodeJS.ProcessEnv);
    expect(config.provider).toBe("pi");
    expect(config.model).toBe("openrouter/anthropic/claude-fable-5");
    expect(config.modeId).toBe("");
    expect(config.thinkingOptionId).toBe("high");
  });

  it("lets persisted chat defaults override environment defaults", async () => {
    const home = await createTempHome();
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        chat: {
          defaults: {
            provider: "codex",
            model: "gpt-5.4-mini",
            modeId: "auto",
            thinkingOptionId: "low",
          },
        },
      }),
    );
    const config = loadConfig({
      PASEO_HOME: home,
      PASEO_CHAT_PROVIDER: "pi",
      PASEO_CHAT_MODEL: "openrouter/anthropic/claude-fable-5",
      PASEO_CHAT_MODE_ID: "",
      PASEO_CHAT_THINKING_OPTION_ID: "high",
    } as NodeJS.ProcessEnv);
    expect(config.provider).toBe("codex");
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.modeId).toBe("auto");
    expect(config.thinkingOptionId).toBe("low");
  });

  it("allows the chat thinking default to be set from the environment", async () => {
    const home = await createTempHome();
    const config = loadConfig({
      PASEO_HOME: home,
      PASEO_CHAT_THINKING_OPTION_ID: "xhigh",
    } as NodeJS.ProcessEnv);
    expect(config.thinkingOptionId).toBe("xhigh");
  });
});

describe("loadConfig chat.email classifier", () => {
  it("defaults to Pi with OpenRouter Sonnet 5", async () => {
    const home = await createTempHome();
    await writeFile(join(home, "config.json"), JSON.stringify({ chat: {} }));

    const config = loadConfig({ PASEO_HOME: home } as NodeJS.ProcessEnv);

    expect(config.emailClassifier).toEqual({
      provider: "pi",
      model: "openrouter/anthropic/claude-sonnet-5",
      thinkingOptionId: "off",
      timeoutMs: 60_000,
    });
  });

  it("can disable or override the classifier through env", async () => {
    const home = await createTempHome();
    await writeFile(join(home, "config.json"), JSON.stringify({ chat: {} }));

    expect(
      loadConfig({
        PASEO_HOME: home,
        PASEO_CHAT_EMAIL_CLASSIFIER_PROVIDER: "none",
      } as NodeJS.ProcessEnv).emailClassifier,
    ).toBeNull();

    expect(
      loadConfig({
        PASEO_HOME: home,
        PASEO_CHAT_EMAIL_CLASSIFIER_MODEL: "openrouter/anthropic/claude-sonnet-5",
        PASEO_CHAT_EMAIL_CLASSIFIER_THINKING_OPTION_ID: "minimal",
        PASEO_CHAT_EMAIL_CLASSIFIER_TIMEOUT_MS: "45000",
        PASEO_CHAT_EMAIL_CLASSIFIER_COMMAND: "/usr/local/bin/pi",
      } as NodeJS.ProcessEnv).emailClassifier,
    ).toEqual({
      provider: "pi",
      model: "openrouter/anthropic/claude-sonnet-5",
      thinkingOptionId: "minimal",
      timeoutMs: 45_000,
      command: "/usr/local/bin/pi",
    });
  });
});

describe("resolveRepositoryConfig", () => {
  it("returns null when no project root is configured", () => {
    expect(resolveRepositoryConfig({ projectId: "paseo" })).toBeNull();
  });

  it("trims the configured project repository", () => {
    expect(
      resolveRepositoryConfig({
        projectId: " affil-ai/paseo ",
        projectRootPath: " /workspace/paseo ",
        projectDisplayName: " Paseo ",
      }),
    ).toEqual({
      projectId: "affil-ai/paseo",
      projectRootPath: "/workspace/paseo",
      projectDisplayName: "Paseo",
    });
  });
});

describe("loadConfig chat.repository", () => {
  it("reads chat.repository from the persisted config.json", async () => {
    const home = await createTempHome();
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        chat: {
          repository: {
            projectId: "affil-ai/paseo",
            projectRootPath: "/workspace/paseo",
            projectDisplayName: "Paseo",
          },
        },
      }),
    );
    const config = loadConfig({ PASEO_HOME: home } as NodeJS.ProcessEnv);
    expect(config.repository).toEqual({
      projectId: "affil-ai/paseo",
      projectRootPath: "/workspace/paseo",
      projectDisplayName: "Paseo",
    });
  });
});
