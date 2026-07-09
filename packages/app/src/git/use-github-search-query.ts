import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { GitHubSearchRequest, GitHubSearchResponse } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

export const GITHUB_SEARCH_STALE_TIME = 30_000;

export type GitHubSearchPayload = GitHubSearchResponse["payload"];

export interface GitHubSearchClient {
  searchGitHub: (
    options: {
      cwd: string;
      query: string;
      limit?: number;
      kinds?: GitHubSearchRequest["kinds"];
    },
    requestId?: string,
  ) => Promise<GitHubSearchPayload>;
}

interface GitHubSearchQueryInput {
  client: GitHubSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: GitHubSearchRequest["kinds"];
  /**
   * Max results. Omitted → 20 (mention-search default). `null` → the limit is
   * left off the request entirely so the daemon applies its own (much higher)
   * default — the wire schema caps explicit limits at 50, so this is the only
   * way to ask for "everything" (used by the dashboard).
   */
  limit?: number | null;
  enabled: boolean;
  hostDisconnectedMessage?: string;
}

export function githubSearchQueryKey(
  serverId: string,
  cwd: string,
  query: string,
  kinds?: GitHubSearchRequest["kinds"],
  limit?: number | null,
): readonly unknown[] {
  const trimmedQuery = query.trim();
  const key: unknown[] = ["github-search", serverId, cwd, trimmedQuery];
  if (kinds) {
    key.push([...kinds].sort().join(","));
  }
  if (limit !== undefined) {
    key.push(limit === null ? "server-default" : limit);
  }
  return key;
}

export function buildGithubSearchQueryOptions(input: GitHubSearchQueryInput) {
  const query = input.query.trim();

  return {
    queryKey: githubSearchQueryKey(input.serverId, input.cwd, query, input.kinds, input.limit),
    queryFn: async (): Promise<GitHubSearchPayload> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const limit = input.limit === undefined ? 20 : input.limit;
      const request: { cwd: string; query: string; limit?: number } = { cwd: input.cwd, query };
      if (limit !== null) {
        request.limit = limit;
      }
      if (input.kinds) {
        return input.client.searchGitHub({ ...request, kinds: input.kinds });
      }
      return input.client.searchGitHub(request);
    },
    enabled: input.enabled && Boolean(input.client),
    staleTime: GITHUB_SEARCH_STALE_TIME,
  };
}

export function useGithubSearchQuery(input: GitHubSearchQueryInput) {
  const { t } = useTranslation();
  return useQuery(
    buildGithubSearchQueryOptions({
      ...input,
      hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );
}
