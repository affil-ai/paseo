import { useQuery } from "@tanstack/react-query";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { parseAndHighlightDiff, type ParsedDiffFile } from "@/utils/diff-highlighter";

export interface PrDiffQueryData {
  files: ParsedDiffFile[];
  truncated: boolean;
}

export function prDiffQueryKey(serverId: string, cwd: string, number: number) {
  return ["github-pr-diff", serverId, cwd, number] as const;
}

/**
 * Fetches a PR's unified diff from GitHub via the daemon (`gh pr diff`) and
 * parses/highlights it client-side. Used by the dashboard to review PRs that
 * have no local checkout — no worktree is required.
 */
export function usePrDiffQuery(input: {
  serverId: string;
  cwd: string;
  number: number;
  enabled?: boolean;
}) {
  const store = getHostRuntimeStore();
  const isConnected =
    Boolean(store.getClient(input.serverId)) &&
    isHostRuntimeConnected(store.getSnapshot(input.serverId));

  return useQuery<PrDiffQueryData>({
    queryKey: prDiffQueryKey(input.serverId, input.cwd, input.number),
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(input.serverId);
      if (!client) {
        throw new Error("Host disconnected");
      }
      const payload = await client.getPullRequestDiff({
        cwd: input.cwd,
        number: input.number,
      });
      if (payload.error || payload.diff === null) {
        throw new Error(payload.error ?? "Unable to load pull request diff");
      }
      return {
        files: parseAndHighlightDiff(payload.diff),
        truncated: payload.truncated ?? false,
      };
    },
    enabled: (input.enabled ?? true) && isConnected,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
