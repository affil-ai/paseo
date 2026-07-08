import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractGithubPrLinks, GithubMergeNotifier } from "./github.js";
import { ThreadSessionStore } from "./state/thread-session-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-github-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function signature(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function mergedPrPayload() {
  return {
    action: "closed",
    repository: { name: "paseo", full_name: "affil-ai/paseo", owner: { login: "affil-ai" } },
    pull_request: {
      merged: true,
      number: 123,
      title: "Office agent fix",
      html_url: "https://github.com/affil-ai/paseo/pull/123",
    },
  };
}

describe("GitHub PR tracking", () => {
  it("extracts and de-duplicates GitHub PR links", () => {
    expect(
      extractGithubPrLinks(
        "See https://github.com/Affil-AI/paseo/pull/123 and https://github.com/affil-ai/paseo/pull/123/files.",
      ),
    ).toEqual([
      {
        key: "affil-ai/paseo#123",
        owner: "affil-ai",
        repo: "paseo",
        number: 123,
        url: "https://github.com/affil-ai/paseo/pull/123",
      },
    ]);
  });

  it("notifies linked office agents when a PR merge webhook arrives and dedupes deliveries", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    await store.recordGithubPrLinks(
      [
        {
          key: "affil-ai/paseo#123",
          owner: "affil-ai",
          repo: "paseo",
          number: 123,
          url: "https://github.com/affil-ai/paseo/pull/123",
        },
      ],
      {
        officeAgentId: "agent-office",
        externalThreadId: "slack:C1:111.222",
        conversationId: "conv_1",
      },
    );
    const sent: Array<{ agentId: string; message: string }> = [];
    const notifier = new GithubMergeNotifier("secret", store, {
      sendAgentMessage: async (agentId, message) => {
        sent.push({ agentId, message });
      },
    });
    const body = Buffer.from(JSON.stringify(mergedPrPayload()));
    const headers = {
      "x-hub-signature-256": signature(body, "secret"),
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
    };

    await expect(notifier.handleWebhook(body, headers)).resolves.toMatchObject({
      status: 202,
      body: { ok: true, result: "notified", notified: 1 },
    });
    await expect(notifier.handleWebhook(body, headers)).resolves.toMatchObject({
      status: 202,
      body: { ok: true, result: "duplicate" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "agent-office" });
    expect(sent[0]?.message).toContain("GitHub PR merged: Office agent fix");
    expect(sent[0]?.message).toContain("chat.addReaction");
    expect(sent[0]?.message).toContain("conversationId: conv_1");
  });

  it("rejects invalid signatures", async () => {
    const store = new ThreadSessionStore(await createTempDir());
    const notifier = new GithubMergeNotifier("secret", store, {
      sendAgentMessage: async () => {},
    });
    const body = Buffer.from(JSON.stringify(mergedPrPayload()));

    await expect(
      notifier.handleWebhook(body, {
        "x-hub-signature-256": "sha256=bad",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      }),
    ).resolves.toMatchObject({ status: 401 });
  });
});
