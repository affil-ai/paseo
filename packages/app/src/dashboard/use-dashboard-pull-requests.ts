import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import {
  getChatThreadIdFromLabels,
  getChatUserMessageSourceFromLabels,
} from "@getpaseo/protocol/agent-labels";
import { buildGithubSearchQueryOptions } from "@/git/use-github-search-query";
import { useProjects } from "@/hooks/use-projects";
import type { ProjectIconRequestTarget } from "@/projects/project-icons";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useWorkspacesForHosts } from "@/stores/session-store-hooks";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export type DashboardPrColumn = "draft" | "review" | "blocked";

export interface DashboardPrWorkspaceLink {
  workspaceId: string;
  workspaceName: string;
  workspaceDirectory: string;
}

export interface DashboardPreviewLink {
  url: string;
  projectName: string | null;
}

/**
 * Where the PR's work originated, beyond a human pushing a branch.
 * - slack: the PR's workspace belongs to (or descends from) a Slack-initiated
 *   office agent; url deep-links to the Slack thread when derivable.
 *
 * Devin origination is tracked separately on `DashboardPullRequest.devin`
 * because it renders as an avatar next to the repo name, not as a chip.
 */
export interface DashboardPrOrigin {
  kind: "slack";
  url: string | null;
}

/**
 * Card status signal.
 * - `pill`: rendered as a `<StatusBadge>` (approved / changes requested).
 * - `icon`: rendered as a compact danger icon (conflicts / checks failing) —
 *   these blocking states read louder and shorter as an icon than a word.
 */
export type DashboardPrBadge =
  | { display: "pill"; label: string; variant: "success" | "warning" }
  | { display: "icon"; icon: "conflicts" | "checksFailing"; label: string };

/** A Devin-originated PR; url deep-links to the Devin session when derivable. */
export interface DashboardPrDevin {
  url: string | null;
}

export interface DashboardPullRequest {
  id: string;
  serverId: string;
  serverName: string;
  projectKey: string;
  projectName: string;
  /** Repo root on the host — where the daemon runs gh commands for this PR. */
  projectCwd: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  column: DashboardPrColumn;
  /** Status signal; null when the column already says everything (plain open/draft). */
  badge: DashboardPrBadge | null;
  origin: DashboardPrOrigin | null;
  /** Present when the PR was authored by Devin. */
  devin: DashboardPrDevin | null;
  previewLinks: DashboardPreviewLink[];
  additions: number | null;
  deletions: number | null;
  createdAt: string | null;
  lastCommitAt: string | null;
  /** Present when Paseo has a checkout for this PR, enabling review + open-workspace. */
  workspace: DashboardPrWorkspaceLink | null;
}

export interface DashboardRepoOption {
  projectKey: string;
  projectName: string;
  count: number;
}

export interface DashboardPullRequestsResult {
  /** Pull requests after applying the active repo filter. */
  pullRequests: DashboardPullRequest[];
  /** Every repo with at least one open PR, for building the filter control. */
  repos: DashboardRepoOption[];
  /** Targets for useProjectIconDataByProjectKey, one per project. */
  iconTargets: ProjectIconRequestTarget[];
  isLoading: boolean;
  isFetching: boolean;
  hasError: boolean;
  refetch: () => void;
}

export interface UseDashboardPullRequestsOptions {
  /** Project key to filter by, or null for all repos. */
  repoFilter?: string | null;
}

interface ProjectRepoTarget {
  serverId: string;
  serverName: string;
  projectKey: string;
  projectName: string;
  cwd: string;
}

type WorkspacePrStatus = NonNullable<WorkspaceDescriptor["githubRuntime"]>["pullRequest"];

interface WorkspaceMatch {
  link: DashboardPrWorkspaceLink;
  prStatus: WorkspacePrStatus | null;
}

function buildProjectRepoTargets(
  projects: ReturnType<typeof useProjects>["projects"],
): ProjectRepoTarget[] {
  const byKey = new Map<string, ProjectRepoTarget>();
  for (const project of projects) {
    for (const host of project.hosts) {
      const cwd = host.repoRoot.trim();
      if (!host.isOnline || !cwd) {
        continue;
      }
      byKey.set(`${host.serverId}:${cwd}`, {
        serverId: host.serverId,
        serverName: host.serverName,
        projectKey: project.projectKey,
        projectName: project.projectName,
        cwd,
      });
    }
  }
  return Array.from(byKey.values());
}

function buildWorkspaceMatchesByUrl(
  workspaces: ReturnType<typeof useWorkspacesForHosts>,
): Map<string, WorkspaceMatch> {
  const byUrl = new Map<string, WorkspaceMatch>();
  for (const { workspace } of workspaces) {
    const prStatus = workspace.githubRuntime?.pullRequest ?? null;
    const url = prStatus?.url;
    if (!url || !workspace.workspaceDirectory) {
      continue;
    }
    const match: WorkspaceMatch = {
      link: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceDirectory: workspace.workspaceDirectory,
      },
      prStatus,
    };
    const existing = byUrl.get(url);
    if (!existing || match.link.workspaceName.localeCompare(existing.link.workspaceName) < 0) {
      byUrl.set(url, match);
    }
  }
  return byUrl;
}

function columnFor(item: GitHubSearchItem, prStatus: WorkspacePrStatus | null): DashboardPrColumn {
  if (item.isDraft) {
    return "draft";
  }
  if (
    prStatus?.mergeable === "CONFLICTING" ||
    prStatus?.checksStatus === "failure" ||
    item.mergeable === "CONFLICTING"
  ) {
    return "blocked";
  }
  return "review";
}

function badgeFor(
  item: GitHubSearchItem,
  prStatus: WorkspacePrStatus | null,
): DashboardPullRequest["badge"] {
  if (prStatus?.mergeable === "CONFLICTING" || item.mergeable === "CONFLICTING") {
    return { display: "icon", icon: "conflicts", label: "Merge conflicts" };
  }
  if (prStatus?.checksStatus === "failure") {
    return { display: "icon", icon: "checksFailing", label: "Checks failing" };
  }
  if (
    prStatus?.reviewDecision === "changes_requested" ||
    item.reviewDecision === "CHANGES_REQUESTED"
  ) {
    return { display: "pill", label: "Changes requested", variant: "warning" };
  }
  if (prStatus?.reviewDecision === "approved" || item.reviewDecision === "APPROVED") {
    return { display: "pill", label: "Approved", variant: "success" };
  }
  // Plain open and draft PRs carry no badge — the column already says it.
  return null;
}

const DEVIN_AUTHOR_LOGIN = "devin-ai-integration";
const DEVIN_BRANCH_PREFIX = "devin/";
// Any app.devin.ai link in the PR body; the first match is the session URL.
const DEVIN_SESSION_URL_PATTERN = /https:\/\/(?:app\.)?devin\.ai\/[^\s)<>"'`]+/;

/** `slack:C0123:1712345678.123456` → `https://slack.com/archives/C0123/p1712345678123456` */
function buildSlackThreadUrl(threadId: string): string | null {
  const [source, channel, ts] = threadId.split(":");
  if (source !== "slack" || !channel || !ts) {
    return null;
  }
  return `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function originFor(
  workspaceLink: DashboardPrWorkspaceLink | null,
  serverId: string,
  slackThreadByWorkspace: Record<string, string>,
): DashboardPrOrigin | null {
  if (workspaceLink) {
    const workspaceId = normalizeWorkspaceOpaqueId(workspaceLink.workspaceId);
    const threadId = workspaceId ? slackThreadByWorkspace[`${serverId}:${workspaceId}`] : undefined;
    if (threadId) {
      return { kind: "slack", url: buildSlackThreadUrl(threadId) };
    }
  }
  return null;
}

/**
 * A PR is Devin-originated when the `devin-ai-integration` GitHub App authored
 * it; the session URL comes from Devin's own PR comment (extracted server-side
 * into `devinSessionUrl`). Servers older than the COMPAT(githubSearchAuthor)
 * floor don't send `authorLogin` — fall back to the old heuristics (body link
 * or `devin/` branch prefix) until the floor rises.
 */
function devinFor(item: GitHubSearchItem): DashboardPrDevin | null {
  if (item.authorLogin !== undefined) {
    if (item.authorLogin === DEVIN_AUTHOR_LOGIN) {
      return { url: item.devinSessionUrl ?? null };
    }
    return null;
  }
  const sessionUrl = item.body?.match(DEVIN_SESSION_URL_PATTERN)?.[0] ?? null;
  if (sessionUrl || item.headRefName?.startsWith(DEVIN_BRANCH_PREFIX)) {
    return { url: sessionUrl };
  }
  return null;
}

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

/**
 * Workspaces whose agents descend from a Slack-initiated office agent.
 * Keyed `${serverId}:${normalizedWorkspaceId}`, value is the office agent's
 * chat thread id. Walks each agent's parent chain because the office agent
 * usually lives in the chat repository workspace while its subagents work in
 * per-branch worktree workspaces.
 */
function selectSlackThreadsByWorkspace(
  state: SessionStoreSnapshot,
  serverIds: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const serverId of serverIds) {
    const agents = state.sessions[serverId]?.agents;
    if (!agents || agents.size === 0) {
      continue;
    }
    for (const agent of agents.values()) {
      const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
      if (!workspaceId) {
        continue;
      }
      const key = `${serverId}:${workspaceId}`;
      if (result[key]) {
        continue;
      }
      let root = agent;
      const visited = new Set([agent.id]);
      while (root.parentAgentId) {
        const parent = agents.get(root.parentAgentId);
        if (!parent || visited.has(parent.id)) {
          break;
        }
        visited.add(parent.id);
        root = parent;
      }
      const threadId = getChatThreadIdFromLabels(root.labels);
      if (threadId && getChatUserMessageSourceFromLabels(root.labels) === "slack") {
        result[key] = threadId;
      }
    }
  }
  return result;
}

function useSlackThreadsByWorkspace(serverIds: readonly string[]): Record<string, string> {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSlackThreadsByWorkspace(state, serverIds),
    equal,
  );
}

export function useDashboardPullRequests(
  options: UseDashboardPullRequestsOptions = {},
): DashboardPullRequestsResult {
  const { repoFilter = null } = options;
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const { projects, isLoading: projectsLoading } = useProjects();
  const workspaces = useWorkspacesForHosts(serverIds);
  const slackThreadByWorkspace = useSlackThreadsByWorkspace(serverIds);

  const targets = useMemo(() => buildProjectRepoTargets(projects), [projects]);
  const workspaceMatchesByUrl = useMemo(() => buildWorkspaceMatchesByUrl(workspaces), [workspaces]);

  const queries = useQueries({
    queries: targets.map((target) => {
      const isConnected =
        Boolean(getHostRuntimeStore().getClient(target.serverId)) &&
        isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(target.serverId));
      return {
        ...buildGithubSearchQueryOptions({
          client: getHostRuntimeStore().getClient(target.serverId),
          serverId: target.serverId,
          cwd: target.cwd,
          query: "",
          kinds: ["github-pr"] as const,
          // Board wants every open PR, not the mention-search preview slice.
          limit: null,
          enabled: isConnected,
        }),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      };
    }),
  });

  const pullRequests = useMemo(() => {
    const byUrl = new Map<string, DashboardPullRequest>();
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const items = queries[index]?.data?.items ?? [];
      for (const item of items) {
        if (item.kind !== "pr") {
          continue;
        }
        const match = workspaceMatchesByUrl.get(item.url) ?? null;
        const prStatus = match?.prStatus ?? null;
        const workspaceLink = match?.link ?? null;
        byUrl.set(item.url, {
          id: item.url,
          serverId: target.serverId,
          serverName: target.serverName,
          projectKey: target.projectKey,
          projectName: target.projectName,
          projectCwd: target.cwd,
          number: item.number,
          title: item.title,
          url: item.url,
          headRefName: item.headRefName ?? "",
          baseRefName: item.baseRefName ?? "",
          isDraft: item.isDraft ?? false,
          column: columnFor(item, prStatus),
          badge: badgeFor(item, prStatus),
          origin: originFor(workspaceLink, target.serverId, slackThreadByWorkspace),
          devin: devinFor(item),
          previewLinks: (item.previewLinks ?? []).map((link) => ({
            url: link.url,
            projectName: link.projectName ?? null,
          })),
          additions: item.additions ?? null,
          deletions: item.deletions ?? null,
          createdAt: item.createdAt ?? null,
          lastCommitAt: item.lastCommitAt ?? null,
          workspace: workspaceLink,
        });
      }
    }
    return Array.from(byUrl.values()).sort((a, b) => {
      if (a.projectName !== b.projectName) {
        return a.projectName.localeCompare(b.projectName);
      }
      return b.number - a.number;
    });
  }, [queries, targets, workspaceMatchesByUrl, slackThreadByWorkspace]);

  const repos = useMemo(() => {
    const byKey = new Map<string, DashboardRepoOption>();
    for (const pr of pullRequests) {
      const existing = byKey.get(pr.projectKey);
      if (existing) {
        existing.count += 1;
        continue;
      }
      byKey.set(pr.projectKey, {
        projectKey: pr.projectKey,
        projectName: pr.projectName,
        count: 1,
      });
    }
    return Array.from(byKey.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
  }, [pullRequests]);

  const iconTargets = useMemo(() => {
    const byProjectKey = new Map<string, ProjectIconRequestTarget>();
    for (const target of targets) {
      if (!byProjectKey.has(target.projectKey)) {
        byProjectKey.set(target.projectKey, {
          serverId: target.serverId,
          projectKey: target.projectKey,
          iconWorkingDir: target.cwd,
        });
      }
    }
    return Array.from(byProjectKey.values());
  }, [targets]);

  const filteredPullRequests = useMemo(() => {
    if (!repoFilter) {
      return pullRequests;
    }
    return pullRequests.filter((pr) => pr.projectKey === repoFilter);
  }, [pullRequests, repoFilter]);

  return {
    pullRequests: filteredPullRequests,
    repos,
    iconTargets,
    isLoading: projectsLoading || queries.some((query) => query.isLoading),
    isFetching: queries.some((query) => query.isFetching),
    hasError: queries.some((query) => query.isError),
    refetch: () => {
      for (const query of queries) {
        void query.refetch();
      }
    },
  };
}
