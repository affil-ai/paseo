import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";
import { buildGithubSearchQueryOptions } from "@/git/use-github-search-query";
import { useProjects } from "@/hooks/use-projects";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useWorkspacesForHosts } from "@/stores/session-store-hooks";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export type DashboardPrColumn = "review" | "draft" | "blocked";

export interface DashboardPrWorkspaceLink {
  workspaceId: string;
  workspaceName: string;
  workspaceDirectory: string;
}

export interface DashboardPullRequest {
  id: string;
  serverId: string;
  serverName: string;
  projectKey: string;
  projectName: string;
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  column: DashboardPrColumn;
  badge: { label: string; variant: "success" | "error" | "muted" };
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
  if (prStatus?.mergeable === "CONFLICTING" || prStatus?.checksStatus === "failure") {
    return "blocked";
  }
  return "review";
}

function badgeFor(
  item: GitHubSearchItem,
  prStatus: WorkspacePrStatus | null,
): DashboardPullRequest["badge"] {
  if (item.isDraft) {
    return { label: "Draft", variant: "muted" };
  }
  if (prStatus?.mergeable === "CONFLICTING") {
    return { label: "Conflicts", variant: "error" };
  }
  if (prStatus?.checksStatus === "failure") {
    return { label: "Checks failing", variant: "error" };
  }
  if (prStatus?.reviewDecision === "approved") {
    return { label: "Approved", variant: "success" };
  }
  return { label: "Open", variant: "muted" };
}

export function useDashboardPullRequests(
  options: UseDashboardPullRequestsOptions = {},
): DashboardPullRequestsResult {
  const { repoFilter = null } = options;
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const { projects, isLoading: projectsLoading } = useProjects();
  const workspaces = useWorkspacesForHosts(serverIds);

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
        byUrl.set(item.url, {
          id: item.url,
          serverId: target.serverId,
          serverName: target.serverName,
          projectKey: target.projectKey,
          projectName: target.projectName,
          number: item.number,
          title: item.title,
          url: item.url,
          headRefName: item.headRefName ?? "",
          baseRefName: item.baseRefName ?? "",
          isDraft: item.isDraft ?? false,
          column: columnFor(item, prStatus),
          badge: badgeFor(item, prStatus),
          workspace: match?.link ?? null,
        });
      }
    }
    return Array.from(byUrl.values()).sort((a, b) => {
      if (a.projectName !== b.projectName) {
        return a.projectName.localeCompare(b.projectName);
      }
      return b.number - a.number;
    });
  }, [queries, targets, workspaceMatchesByUrl]);

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

  const filteredPullRequests = useMemo(() => {
    if (!repoFilter) {
      return pullRequests;
    }
    return pullRequests.filter((pr) => pr.projectKey === repoFilter);
  }, [pullRequests, repoFilter]);

  return {
    pullRequests: filteredPullRequests,
    repos,
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
