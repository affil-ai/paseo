// Recency sorting + preview windowing for the sidebar, modeled on the reference
// Conductor/T3Code sidebar (getVisibleThreadsForProject + threadSort). Kept as a
// pure module so the ordering rules are unit-testable without React.

// Default number of workspaces shown per project before "Show N more". Matches
// the reference DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT = 6.
export const DEFAULT_SIDEBAR_WORKSPACE_PREVIEW_COUNT = 6;

export function toSortableTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function getFirstSortableTimestamp(
  ...values: Array<string | null | undefined>
): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

export interface WorkspaceRecencyInput {
  activityAt?: string | null;
  statusEnteredAt?: string | null;
}

/**
 * Recency timestamp for a workspace: prefer the daemon-reported activity time,
 * then the status-entered time. Missing/unparseable timestamps sort last.
 */
export function getWorkspaceRecencyTimestamp(workspace: WorkspaceRecencyInput): number {
  return (
    getFirstSortableTimestamp(workspace.activityAt, workspace.statusEnteredAt) ??
    Number.NEGATIVE_INFINITY
  );
}

/**
 * Sort workspaces by recency descending (most recent first), with a stable
 * deterministic fallback so equal timestamps never reorder unpredictably.
 */
export function sortWorkspacesByRecency<
  T extends WorkspaceRecencyInput & { workspaceKey: string; name: string },
>(workspaces: readonly T[]): T[] {
  return [...workspaces].sort((left, right) => {
    const rightTs = getWorkspaceRecencyTimestamp(right);
    const leftTs = getWorkspaceRecencyTimestamp(left);
    if (rightTs !== leftTs) {
      return rightTs > leftTs ? 1 : -1;
    }
    const byName = left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (byName !== 0) {
      return byName;
    }
    return left.workspaceKey.localeCompare(right.workspaceKey, undefined, {
      sensitivity: "base",
    });
  });
}

/**
 * Windows a (recency-sorted) workspace list into the preview slice plus hidden
 * remainder. The active/selected workspace is always kept visible even when it
 * falls outside the preview window, so the current selection never disappears
 * behind "Show more". Mirrors the reference getVisibleThreadsForProject.
 */
export function getVisibleWorkspacesForProject<T extends { workspaceKey: string }>(input: {
  workspaces: readonly T[];
  activeWorkspaceKey: string | null | undefined;
  isExpanded: boolean;
  previewLimit: number;
}): { hasHiddenWorkspaces: boolean; visibleWorkspaces: T[]; hiddenCount: number } {
  const { activeWorkspaceKey, isExpanded, previewLimit, workspaces } = input;
  const hasHiddenWorkspaces = workspaces.length > previewLimit;

  if (!hasHiddenWorkspaces || isExpanded) {
    return { hasHiddenWorkspaces, visibleWorkspaces: [...workspaces], hiddenCount: 0 };
  }

  const previewWorkspaces = workspaces.slice(0, previewLimit);
  const previewHasActive =
    !activeWorkspaceKey ||
    previewWorkspaces.some((workspace) => workspace.workspaceKey === activeWorkspaceKey);

  if (previewHasActive) {
    return {
      hasHiddenWorkspaces: true,
      visibleWorkspaces: previewWorkspaces,
      hiddenCount: workspaces.length - previewWorkspaces.length,
    };
  }

  const activeWorkspace = workspaces.find(
    (workspace) => workspace.workspaceKey === activeWorkspaceKey,
  );
  if (!activeWorkspace) {
    return {
      hasHiddenWorkspaces: true,
      visibleWorkspaces: previewWorkspaces,
      hiddenCount: workspaces.length - previewWorkspaces.length,
    };
  }

  // Keep preview order, then append the active workspace so it stays reachable.
  const visibleKeys = new Set(
    [...previewWorkspaces, activeWorkspace].map((workspace) => workspace.workspaceKey),
  );
  const visibleWorkspaces = workspaces.filter((workspace) =>
    visibleKeys.has(workspace.workspaceKey),
  );
  return {
    hasHiddenWorkspaces: true,
    visibleWorkspaces,
    hiddenCount: workspaces.length - visibleWorkspaces.length,
  };
}
