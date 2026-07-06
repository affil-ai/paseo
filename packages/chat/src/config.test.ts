import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveEmailConfig } from "./config.js";

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
    expect(resolveEmailConfig({}, {}, (message) => warnings.push(message))).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("warns and disables when only some fields are set", () => {
    const warnings: string[] = [];
    const resolved = resolveEmailConfig({ resendApiKey: "re_123" }, {}, (message) =>
      warnings.push(message),
    );
    expect(resolved).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resendWebhookSecret");
    expect(warnings[0]).toContain("channel");
    expect(warnings[0]).not.toContain("resendApiKey,");
  });

  it("resolves a channel name through the channels map", () => {
    const resolved = resolveEmailConfig(
      {
        resendApiKey: "re_123",
        resendWebhookSecret: "whsec_abc",
        channel: "#Support-Emails",
        supportAddress: "Support@Affil.ai",
      },
      { "support-emails": "C123456" },
    );
    expect(resolved).toEqual({
      apiKey: "re_123",
      webhookSecret: "whsec_abc",
      channelId: "C123456",
      supportAddress: "support@affil.ai",
    });
  });

  it("passes through a raw channel id when no map entry exists", () => {
    const resolved = resolveEmailConfig(
      { resendApiKey: "re_123", resendWebhookSecret: "whsec_abc", channel: "C987654" },
      {},
    );
    expect(resolved?.channelId).toBe("C987654");
    expect(resolved?.supportAddress).toBeUndefined();
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
