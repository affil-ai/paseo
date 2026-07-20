import { createHmac } from "node:crypto";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { buildPaseoAgentUrl } from "./paseo-link.js";
import type { ThreadSessionStore } from "./state/thread-session-store.js";

/**
 * Pushes agent↔git links for office-bound threads to the office Convex
 * deployment. For every `office:<bindingId>` binding, the sweep walks the
 * daemon's agent tree from the binding's root office agent down through
 * `paseo.parent-agent-id` descendants, collects each agent workspace's current
 * branch and resolved GitHub PR, merges in the text-scraped `githubPrLinks`
 * store entries, and POSTs the batch to `/api/paseo/agent-links` (HMAC-signed
 * exactly like turn callbacks). Reports are idempotent on the office side, so
 * the sweep favors self-healing repetition over precise event capture.
 */

const OFFICE_THREAD_PREFIX = "office:";
const AGENT_LINKS_PATH = "/api/paseo/agent-links";
const PAGE_LIMIT = 200;
const MAX_PAGES = 20;

export interface AgentLinksAgent {
  id: string;
  cwd?: string | undefined;
  workspaceId?: string | undefined;
  labels?: Record<string, string> | null | undefined;
  archivedAt?: string | null | undefined;
}

export interface AgentLinksWorkspace {
  id: string;
  projectRootPath?: string | undefined;
  workspaceDirectory?: string | undefined;
  gitRuntime?: {
    currentBranch?: string | null | undefined;
    remoteUrl?: string | null | undefined;
  } | null;
  githubRuntime?: {
    pullRequest?: {
      number?: number | undefined;
      url: string;
      headRefName: string;
      repoOwner?: string | undefined;
      repoName?: string | undefined;
    } | null;
  } | null;
}

export interface AgentBranchLink {
  owner: string;
  repo: string;
  branch: string;
  agentId: string;
}

export interface AgentPrLink {
  owner: string;
  repo: string;
  number: number;
  url?: string;
}

export interface AgentLinksReport {
  version: 1;
  bindingId: string;
  agentId: string;
  paseoUrl?: string;
  branchLinks: AgentBranchLink[];
  prLinks: AgentPrLink[];
}

const GITHUB_REMOTE_PATTERN = /(?:github\.com[/:])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/)?$/i;
const GITHUB_PR_URL_PATTERN = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

/** `git@github.com:o/r.git` / `https://github.com/o/r` → `{ owner, repo }`. */
export function parseGithubRemote(
  remoteUrl: string | null | undefined,
): { owner: string; repo: string } | null {
  const match = remoteUrl?.trim().match(GITHUB_REMOTE_PATTERN);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

function prLinkFrom(
  pullRequest: NonNullable<NonNullable<AgentLinksWorkspace["githubRuntime"]>["pullRequest"]>,
  remoteFallback: { owner: string; repo: string } | null,
): AgentPrLink | null {
  const urlMatch = pullRequest.url.match(GITHUB_PR_URL_PATTERN);
  const owner = pullRequest.repoOwner ?? urlMatch?.[1] ?? remoteFallback?.owner;
  const repo = pullRequest.repoName ?? urlMatch?.[2] ?? remoteFallback?.repo;
  const number = pullRequest.number ?? (urlMatch?.[3] ? Number(urlMatch[3]) : undefined);
  if (!owner || !repo || !number) return null;
  return { owner, repo, number, url: pullRequest.url };
}

/** Resolves each agent to its root by walking `paseo.parent-agent-id`. */
function rootAgentIdFor(agent: AgentLinksAgent, byId: Map<string, AgentLinksAgent>): string {
  let current = agent;
  const visited = new Set([agent.id]);
  for (;;) {
    const parentId = getParentAgentIdFromLabels(current.labels);
    if (!parentId || visited.has(parentId)) return current.id;
    const parent = byId.get(parentId);
    if (!parent) return parentId;
    visited.add(parentId);
    current = parent;
  }
}

export interface BuildAgentLinkReportsInput {
  deepLinkBaseUrl: string;
  serverId: string;
  /** externalThreadId → root agent id, office threads only. */
  officeBindings: Array<{ externalThreadId: string; rootAgentId: string }>;
  agents: AgentLinksAgent[];
  workspaces: AgentLinksWorkspace[];
  /** The store's text-scraped links, flattened. */
  githubPrLinks: Array<{
    owner: string;
    repo: string;
    number: number;
    url: string;
    externalThreadId: string;
  }>;
}

function paseoUrlForBinding(
  input: BuildAgentLinkReportsInput,
  rootAgent: AgentLinksAgent | undefined,
  workspacesById: Map<string, AgentLinksWorkspace>,
): string | undefined {
  if (!rootAgent || rootAgent.archivedAt) return undefined;
  const workspace = workspaceForAgent(rootAgent, workspacesById);
  if (!workspace) return undefined;
  return buildPaseoAgentUrl({
    baseUrl: input.deepLinkBaseUrl,
    serverId: input.serverId,
    workspaceId: workspace.id,
    agentId: rootAgent.id,
  });
}

function workspaceForAgent(
  agent: AgentLinksAgent,
  workspacesById: Map<string, AgentLinksWorkspace>,
): AgentLinksWorkspace | undefined {
  if (agent.workspaceId) return workspacesById.get(agent.workspaceId);
  for (const workspace of workspacesById.values()) {
    if (workspace.workspaceDirectory === agent.cwd || workspace.projectRootPath === agent.cwd) {
      return workspace;
    }
  }
  return undefined;
}

function collectWorkspaceLinks(input: {
  rootAgentId: string;
  agents: AgentLinksAgent[];
  agentsById: Map<string, AgentLinksAgent>;
  workspacesById: Map<string, AgentLinksWorkspace>;
}) {
  const branchLinks: AgentBranchLink[] = [];
  const prLinks = new Map<string, AgentPrLink>();
  const seenBranches = new Set<string>();
  for (const agent of input.agents) {
    if (agent.archivedAt) continue;
    if (rootAgentIdFor(agent, input.agentsById) !== input.rootAgentId) continue;
    const workspace = workspaceForAgent(agent, input.workspacesById);
    if (!workspace) continue;
    const remote = parseGithubRemote(workspace.gitRuntime?.remoteUrl);
    const branch = workspace.gitRuntime?.currentBranch?.trim();
    if (remote && branch) {
      const key = `${remote.owner}/${remote.repo}#${branch}`;
      if (!seenBranches.has(key)) {
        seenBranches.add(key);
        branchLinks.push({ ...remote, branch, agentId: agent.id });
      }
    }
    const pullRequest = workspace.githubRuntime?.pullRequest;
    if (pullRequest) {
      const link = prLinkFrom(pullRequest, remote);
      if (link) prLinks.set(`${link.owner}/${link.repo}#${link.number}`, link);
    }
  }
  return { branchLinks, prLinks };
}

/** Pure assembly of per-binding reports; returns only non-empty reports. */
export function buildAgentLinkReports(input: BuildAgentLinkReportsInput): AgentLinksReport[] {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const workspacesById = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const reports: AgentLinksReport[] = [];
  for (const binding of input.officeBindings) {
    if (!binding.externalThreadId.startsWith(OFFICE_THREAD_PREFIX)) continue;
    const bindingId = binding.externalThreadId.slice(OFFICE_THREAD_PREFIX.length);
    const paseoUrl = paseoUrlForBinding(input, agentsById.get(binding.rootAgentId), workspacesById);
    const { branchLinks, prLinks } = collectWorkspaceLinks({
      rootAgentId: binding.rootAgentId,
      agents: input.agents,
      agentsById,
      workspacesById,
    });

    for (const link of input.githubPrLinks) {
      if (link.externalThreadId !== binding.externalThreadId) continue;
      prLinks.set(`${link.owner}/${link.repo}#${link.number}`, {
        owner: link.owner,
        repo: link.repo,
        number: link.number,
        url: link.url,
      });
    }

    if (branchLinks.length === 0 && prLinks.size === 0 && !paseoUrl) continue;
    reports.push({
      version: 1,
      bindingId,
      agentId: binding.rootAgentId,
      ...(paseoUrl ? { paseoUrl } : {}),
      branchLinks,
      prLinks: [...prLinks.values()],
    });
  }
  return reports;
}

interface PagedFetcher<T> {
  (options: { page: { limit: number; cursor?: string } }): Promise<{
    entries: T[];
    pageInfo: { nextCursor?: string | null };
  }>;
}

async function fetchAllPages<T>(fetcher: PagedFetcher<T>): Promise<T[]> {
  const entries: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetcher({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } });
    entries.push(...result.entries);
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return entries;
}

export interface OfficeAgentLinksReporterInput {
  client: {
    fetchAgents: PagedFetcher<{ agent: AgentLinksAgent }>;
    fetchWorkspaces: PagedFetcher<AgentLinksWorkspace>;
    getLastServerInfoMessage(): { serverId: string } | null;
  };
  store: ThreadSessionStore;
  callbackKeyId: string;
  callbackSecret: string;
  deepLinkBaseUrl: string;
  /** Overrides the per-binding callback-derived URL (mainly for tests). */
  linksUrl?: string;
  intervalMs?: number;
}

export class OfficeAgentLinksReporter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly input: OfficeAgentLinksReporterInput) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.input.intervalMs ?? 2 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => {
        console.warn("Office agent-links sweep failed", error);
      });
    }, intervalMs);
    this.timer.unref?.();
    void this.sweep().catch((error) => {
      console.warn("Office agent-links sweep failed", error);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    const data = await this.input.store.load();
    const bindings = Object.values(data.sessions).filter((binding) =>
      binding.externalThreadId.startsWith(OFFICE_THREAD_PREFIX),
    );
    if (bindings.length === 0) return;

    const [agentEntries, workspaces] = await Promise.all([
      fetchAllPages((options) => this.input.client.fetchAgents(options)),
      fetchAllPages((options) => this.input.client.fetchWorkspaces(options)),
    ]);
    const agents = agentEntries.map((entry) => entry.agent);
    const reports = buildAgentLinkReports({
      deepLinkBaseUrl: this.input.deepLinkBaseUrl,
      serverId: this.input.client.getLastServerInfoMessage()?.serverId ?? "local",
      officeBindings: bindings.map((binding) => ({
        externalThreadId: binding.externalThreadId,
        rootAgentId:
          binding.kind === "inbound-session" ? binding.rootAgentId : binding.officeAgentId,
      })),
      agents,
      workspaces,
      githubPrLinks: Object.values(data.githubPrLinks).flat(),
    });

    for (const report of reports) {
      const binding = data.sessions[`${OFFICE_THREAD_PREFIX}${report.bindingId}`];
      const callbackUrl = binding?.lastCallbackUrl ?? binding?.activeOfficeTurn?.callbackUrl;
      const linksUrl =
        this.input.linksUrl ?? (callbackUrl ? new URL(AGENT_LINKS_PATH, callbackUrl).href : null);
      if (!linksUrl) continue;
      await this.post(linksUrl, report).catch((error) => {
        console.warn(`Office agent-links post failed for binding ${report.bindingId}`, error);
      });
    }
  }

  private async post(linksUrl: string, report: AgentLinksReport): Promise<void> {
    const body = JSON.stringify(report);
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", this.input.callbackSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const response = await fetch(linksUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paseo-key-id": this.input.callbackKeyId,
        "x-paseo-timestamp": timestamp,
        "x-paseo-signature": `v1=${signature}`,
      },
      body,
    });
    if (!response.ok) throw new Error(`OFFICE_AGENT_LINKS_HTTP_${response.status}`);
  }
}
