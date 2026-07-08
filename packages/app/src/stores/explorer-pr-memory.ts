import { buildExplorerCheckoutKey } from "./explorer-tab-memory";
import { prIdentityKey, type PrIdentity } from "@/git/explorer-pr-tabs";

// Per-checkout persisted PR selection. Mirrors `explorerTabByCheckout`, but the
// stored value is a STABLE PR IDENTITY (owner/repo#number, with a cwd#number
// fallback), NOT a subagent cwd — worktrees move or disappear, PR identity is
// durable. `null`/absent means the workspace's own PR (the default PR pane).
export type ExplorerPrByCheckout = Record<string, string | null>;

export function isPrIdentityKeyValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// A live PR candidate the persisted identity can reconcile against: each
// carries its identity key and the cwd its PR pane should point at.
export interface ExplorerPrCandidate {
  identityKey: string;
  cwd: string;
}

// Build the reconcile candidates from the workspace's own PR plus its subagent
// PRs. `workspaceCwd`'s candidate maps to `null` (the workspace's own PR pane).
export function buildExplorerPrCandidates(input: {
  workspacePr: PrIdentity | null;
  workspaceCwd: string;
  subagentPrs: ReadonlyArray<PrIdentity & { cwd: string }>;
}): ExplorerPrCandidate[] {
  const candidates: ExplorerPrCandidate[] = [];
  if (input.workspacePr) {
    candidates.push({
      identityKey: prIdentityKey(input.workspacePr, input.workspaceCwd),
      cwd: input.workspaceCwd,
    });
  }
  for (const pr of input.subagentPrs) {
    candidates.push({ identityKey: prIdentityKey(pr, pr.cwd), cwd: pr.cwd });
  }
  return candidates;
}

export interface ResolvePersistedPrInput {
  serverId: string;
  workspaceCwd: string;
  explorerPrByCheckout: ExplorerPrByCheckout;
  candidates: ReadonlyArray<ExplorerPrCandidate>;
}

export interface ResolvedPersistedPr {
  // The cwd the PR pane should point at: a subagent cwd, or `workspaceCwd` for
  // the workspace's own PR. `null` means "no persisted selection to restore"
  // (caller keeps its current/default behavior).
  prCwd: string | null;
  // True when the persisted identity resolved to the workspace's own PR.
  isWorkspaceOwnPr: boolean;
}

// Reconcile a persisted PR identity against the live PR set for a checkout.
// - No persisted entry (absent) -> null (no restore; keep default).
// - Persisted `null` -> the workspace's own PR (prCwd === workspaceCwd).
// - Persisted identity that still matches a live candidate -> that candidate's
//   cwd (mapped back to `workspaceCwd` for the workspace's own PR).
// - Persisted identity that is gone (merged/closed/subagent archived) -> fall
//   back to the workspace's own PR. Never restores a dead PR.
export function resolvePersistedPrSelection(
  input: ResolvePersistedPrInput,
): ResolvedPersistedPr | null {
  const key = buildExplorerCheckoutKey(input.serverId, input.workspaceCwd);
  if (!key || !(key in input.explorerPrByCheckout)) {
    return null;
  }
  const persisted = input.explorerPrByCheckout[key];
  if (persisted === null || persisted === undefined) {
    return { prCwd: input.workspaceCwd, isWorkspaceOwnPr: true };
  }
  const match = input.candidates.find((candidate) => candidate.identityKey === persisted);
  if (!match) {
    // Selected PR vanished — fall back to the workspace's own PR.
    return { prCwd: input.workspaceCwd, isWorkspaceOwnPr: true };
  }
  const isWorkspaceOwnPr = match.cwd === input.workspaceCwd;
  return { prCwd: isWorkspaceOwnPr ? input.workspaceCwd : match.cwd, isWorkspaceOwnPr };
}

// Map a selected cwd back to the PR identity key to persist. Returns `null` for
// the workspace's own PR (cwd === workspaceCwd or no matching candidate).
export function prIdentityKeyForSelectedCwd(input: {
  prCwd: string | null;
  workspaceCwd: string;
  candidates: ReadonlyArray<ExplorerPrCandidate>;
}): string | null {
  if (input.prCwd === null || input.prCwd === input.workspaceCwd) {
    return null;
  }
  const match = input.candidates.find((candidate) => candidate.cwd === input.prCwd);
  return match ? match.identityKey : null;
}
