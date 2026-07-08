import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ThreadSessionStore } from "./state/thread-session-store.js";

export interface GithubPrReference {
  key: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

interface GithubNotifierClient {
  sendAgentMessage(agentId: string, message: string): Promise<unknown>;
}

export function githubPrKey(owner: string, repo: string, number: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

export function extractGithubPrLinks(text: string | undefined): GithubPrReference[] {
  if (!text) return [];
  const links = new Map<string, GithubPrReference>();
  const pattern =
    /https?:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#][^\s<>)\]]*)?/gi;
  for (const match of text.matchAll(pattern)) {
    const owner = match[1];
    const repo = match[2];
    const number = Number(match[3]);
    if (!owner || !repo || !Number.isInteger(number) || number <= 0) continue;
    const key = githubPrKey(owner, repo, number);
    links.set(key, {
      key,
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    });
  }
  return [...links.values()];
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return value?.trim();
}

function verifyGithubSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

const GithubPullRequestPayloadSchema = z.object({
  action: z.literal("closed"),
  pull_request: z.object({
    merged: z.literal(true),
    html_url: z.string().optional(),
    title: z.string().optional(),
    number: z.coerce.number().int().positive(),
    base: z
      .object({
        repo: z
          .object({
            name: z.string().optional(),
            owner: z.object({ login: z.string().optional() }).optional(),
          })
          .optional(),
      })
      .optional(),
  }),
  repository: z
    .object({
      name: z.string().optional(),
      full_name: z.string().optional(),
      owner: z.object({ login: z.string().optional() }).optional(),
    })
    .optional(),
});

function nonEmptyString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function pickFirstString(...values: Array<string | undefined>): string | undefined {
  return values.map(nonEmptyString).find(Boolean);
}

function mergedPullRequestFromPayload(payload: unknown): {
  key: string;
  url: string;
  title: string;
  owner: string;
  repo: string;
  number: number;
} | null {
  const parsed = GithubPullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const body = parsed.data;
  const [fullNameOwner, fullNameRepo] =
    nonEmptyString(body.repository?.full_name)?.split("/") ?? [];
  const owner = pickFirstString(
    body.repository?.owner?.login,
    body.pull_request.base?.repo?.owner?.login,
    fullNameOwner,
  );
  const repo = pickFirstString(
    body.repository?.name,
    body.pull_request.base?.repo?.name,
    fullNameRepo,
  );
  if (!owner || !repo) return null;
  const number = body.pull_request.number;
  const url =
    nonEmptyString(body.pull_request.html_url) ??
    `https://github.com/${owner}/${repo}/pull/${number}`;
  const title = nonEmptyString(body.pull_request.title) ?? `${owner}/${repo}#${number}`;
  return { key: githubPrKey(owner, repo, number), url, title, owner, repo, number };
}

export class GithubMergeNotifier {
  constructor(
    private readonly secret: string,
    private readonly store: ThreadSessionStore,
    private readonly client: GithubNotifierClient,
  ) {}

  async handleWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ status: number; body: unknown }> {
    if (!verifyGithubSignature(rawBody, headerValue(headers, "x-hub-signature-256"), this.secret)) {
      return { status: 401, body: { ok: false, error: "invalid_signature" } };
    }

    const deliveryId = headerValue(headers, "x-github-delivery");
    if (!deliveryId) {
      return { status: 400, body: { ok: false, error: "missing_delivery" } };
    }
    if (!(await this.store.markEventProcessed(`github:${deliveryId}`))) {
      return { status: 202, body: { ok: true, result: "duplicate" } };
    }

    const eventName = headerValue(headers, "x-github-event");
    if (eventName !== "pull_request") {
      return { status: 202, body: { ok: true, result: "ignored" } };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { ok: false, error: "invalid_json" } };
    }

    const pr = mergedPullRequestFromPayload(payload);
    if (!pr) {
      return { status: 202, body: { ok: true, result: "ignored" } };
    }

    const links = await this.store.findGithubPrLinks(pr.key);
    if (links.length === 0) {
      return { status: 202, body: { ok: true, result: "ignored", pr: pr.key } };
    }

    const uniqueLinks = new Map(
      links.map((link) => [`${link.officeAgentId}:${link.externalThreadId}`, link]),
    );
    await Promise.all(
      [...uniqueLinks.values()].map((link) =>
        this.client.sendAgentMessage(
          link.officeAgentId,
          [
            `GitHub PR merged: ${pr.title}`,
            `${pr.url}`,
            "",
            `This PR was linked to Slack conversation ${link.conversationId ?? link.externalThreadId}.`,
            "Please review the merged PR and the original Slack request. If you believe the work is complete, reply in that Slack thread and use the chat.addReaction tool to add a checkmark reaction to the initial Slack message. If the work is not complete, reply in Slack with what remains instead.",
            link.conversationId
              ? `When calling chat.send or chat.addReaction for this thread, pass conversationId: ${link.conversationId}.`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ),
    );

    return {
      status: 202,
      body: { ok: true, result: "notified", pr: pr.key, notified: uniqueLinks.size },
    };
  }
}
