export type ExplorerTab = "changes" | "files" | "pr" | "subagents";

export function isExplorerTab(value: unknown): value is ExplorerTab {
  return value === "changes" || value === "files" || value === "pr" || value === "subagents";
}

export function buildExplorerCheckoutKey(serverId: string, cwd: string): string | null {
  const trimmedServerId = serverId.trim();
  const trimmedCwd = cwd.trim();
  if (!trimmedServerId || !trimmedCwd) {
    return null;
  }
  return `${trimmedServerId}::${trimmedCwd}`;
}

export function coerceExplorerTabForCheckout(tab: ExplorerTab, isGit: boolean): ExplorerTab {
  // A non-git checkout has no Changes tab; only that tab needs coercing.
  // `subagents` is reachable regardless of git status.
  if (!isGit && tab === "changes") {
    return "files";
  }
  return tab;
}

export function resolveExplorerTabForCheckout(params: {
  serverId: string;
  cwd: string;
  isGit: boolean;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}): ExplorerTab {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  const stored = key ? params.explorerTabByCheckout[key] : null;
  const defaultTab: ExplorerTab = params.isGit ? "changes" : "files";
  const nextTab = stored && isExplorerTab(stored) ? stored : defaultTab;
  return coerceExplorerTabForCheckout(nextTab, params.isGit);
}
