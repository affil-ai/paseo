import type { AgentProvider } from "@getpaseo/protocol/agent-types";

// Cap on how many SUBAGENT PR tabs render inline in the explorer header. The
// workspace's own PR tab is always shown in addition to these and does not
// count against the cap. Subagent PRs beyond the cap roll into the Subagents
// pane, where every row with a PR exposes a badge that opens its review pane.
export const MAX_INLINE_SUBAGENT_PR_TABS = 4;

export interface PrIdentity {
  prNumber: number;
  repoOwner: string | null;
  repoName: string | null;
}

// Stable identity for de-duping PRs across the workspace's own PR and its
// subagents' PRs. Prefer owner/repo/number; when the daemon did not report
// owner/repo (older hosts), fall back to the checkout cwd so distinct checkouts
// pointing at the same PR number do not collapse into one.
export function prIdentityKey(identity: PrIdentity, fallbackCwd: string): string {
  if (identity.repoOwner && identity.repoName) {
    return `${identity.repoOwner}/${identity.repoName}#${identity.prNumber}`;
  }
  return `${fallbackCwd}#${identity.prNumber}`;
}

export interface SubagentPrTabInput extends PrIdentity {
  subagentId: string;
  subagentTitle: string | null;
  provider: AgentProvider;
  cwd: string;
}

export interface SubagentPrTab extends SubagentPrTabInput {
  key: string;
}

export interface BuildSubagentPrTabsResult {
  // Distinct subagent PR tabs to render inline, capped at `cap`.
  inline: SubagentPrTab[];
  // Distinct subagent PR tabs beyond the cap. Reachable via the Subagents pane.
  overflow: SubagentPrTab[];
}

// Build the inline/overflow split of subagent PR tabs.
// - De-dupes subagent PRs by PR identity.
// - De-dupes against the workspace's own PR so the same PR never shows twice.
// - Preserves input order (callers pass subagents in a stable order).
export function buildSubagentPrTabs(input: {
  workspacePr: PrIdentity | null;
  workspaceCwd: string;
  subagentPrs: SubagentPrTabInput[];
  cap?: number;
}): BuildSubagentPrTabsResult {
  const cap = input.cap ?? MAX_INLINE_SUBAGENT_PR_TABS;
  const seen = new Set<string>();
  if (input.workspacePr) {
    seen.add(prIdentityKey(input.workspacePr, input.workspaceCwd));
  }

  const distinct: SubagentPrTab[] = [];
  for (const pr of input.subagentPrs) {
    const key = prIdentityKey(pr, pr.cwd);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    distinct.push({ ...pr, key });
  }

  return {
    inline: distinct.slice(0, cap),
    overflow: distinct.slice(cap),
  };
}
