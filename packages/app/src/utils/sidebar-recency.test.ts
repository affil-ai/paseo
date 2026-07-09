import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_WORKSPACE_PREVIEW_COUNT,
  SIDEBAR_WORKSPACE_PREVIEW_STEP,
  getFirstSortableTimestamp,
  getVisibleWorkspacesForProject,
  sortWorkspacesByRecency,
  toSortableTimestamp,
} from "./sidebar-recency";

describe("sidebar recency helpers", () => {
  it("parses valid ISO timestamps and rejects invalid values", () => {
    expect(toSortableTimestamp("2026-01-02T03:04:05.000Z")).toBe(
      Date.parse("2026-01-02T03:04:05.000Z"),
    );
    expect(toSortableTimestamp("not-a-date")).toBeNull();
    expect(toSortableTimestamp(null)).toBeNull();
  });

  it("returns the first sortable timestamp", () => {
    expect(getFirstSortableTimestamp(null, "bad", "2026-01-02T00:00:00.000Z")).toBe(
      Date.parse("2026-01-02T00:00:00.000Z"),
    );
  });

  it("sorts workspaces by activity first, then status-entered time, then name", () => {
    const sorted = sortWorkspacesByRecency([
      {
        workspaceKey: "srv:old",
        name: "old",
        activityAt: "2026-01-01T00:00:00.000Z",
      },
      {
        workspaceKey: "srv:fallback",
        name: "fallback",
        statusEnteredAt: "2026-01-02T00:00:00.000Z",
      },
      {
        workspaceKey: "srv:new",
        name: "new",
        activityAt: "2026-01-03T00:00:00.000Z",
      },
      { workspaceKey: "srv:alpha", name: "alpha" },
      { workspaceKey: "srv:zulu", name: "zulu" },
    ]);

    expect(sorted.map((workspace) => workspace.workspaceKey)).toEqual([
      "srv:new",
      "srv:fallback",
      "srv:old",
      "srv:alpha",
      "srv:zulu",
    ]);
  });

  it("windows workspaces while keeping the active workspace visible", () => {
    const workspaces = Array.from({ length: 8 }, (_, index) => ({
      workspaceKey: `srv:${index + 1}`,
    }));

    const preview = getVisibleWorkspacesForProject({
      workspaces,
      activeWorkspaceKey: "srv:8",
      previewLimit: DEFAULT_SIDEBAR_WORKSPACE_PREVIEW_COUNT,
    });

    expect(preview.hasHiddenWorkspaces).toBe(true);
    expect(preview.hiddenCount).toBe(1);
    expect(preview.visibleWorkspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "srv:1",
      "srv:2",
      "srv:3",
      "srv:4",
      "srv:5",
      "srv:6",
      "srv:8",
    ]);
  });

  it("reveals one more step per grown preview limit", () => {
    const workspaces = Array.from({ length: 20 }, (_, index) => ({
      workspaceKey: `srv:${index + 1}`,
    }));

    const preview = getVisibleWorkspacesForProject({
      workspaces,
      activeWorkspaceKey: null,
      previewLimit: DEFAULT_SIDEBAR_WORKSPACE_PREVIEW_COUNT + SIDEBAR_WORKSPACE_PREVIEW_STEP,
    });

    expect(preview.hasHiddenWorkspaces).toBe(true);
    expect(preview.visibleWorkspaces).toHaveLength(12);
    expect(preview.hiddenCount).toBe(8);
  });

  it("shows all workspaces when the preview limit covers the list", () => {
    const workspaces = Array.from({ length: 8 }, (_, index) => ({
      workspaceKey: `srv:${index + 1}`,
    }));

    const preview = getVisibleWorkspacesForProject({
      workspaces,
      activeWorkspaceKey: null,
      previewLimit: DEFAULT_SIDEBAR_WORKSPACE_PREVIEW_COUNT + SIDEBAR_WORKSPACE_PREVIEW_STEP,
    });

    expect(preview.hasHiddenWorkspaces).toBe(false);
    expect(preview.hiddenCount).toBe(0);
    expect(preview.visibleWorkspaces).toHaveLength(8);
  });
});
