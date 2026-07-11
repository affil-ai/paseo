import { describe, expect, it } from "vitest";
import { migrateSidebarOrderState, togglePinnedWorkspace } from "./sidebar-order-store";

describe("migrateSidebarOrderState", () => {
  it("prefixes legacy per-server workspace order with the source server id", () => {
    const migrated = migrateSidebarOrderState({
      projectOrderByServerId: {
        "host-a": ["project-a"],
        "host-b": ["project-a"],
      },
      workspaceOrderByServerAndProject: {
        "host-a::project-a": ["main", "feature"],
        "host-b::project-a": ["main"],
      },
    });

    expect(migrated).toEqual({
      projectOrder: ["project-a"],
      workspaceOrderByProject: {
        "project-a": ["host-a:main", "host-a:feature", "host-b:main"],
      },
      pinnedWorkspaceKeys: [],
    });
  });

  it("normalizes persisted pinned workspace keys while preserving pin order", () => {
    expect(
      migrateSidebarOrderState({
        projectOrder: [],
        workspaceOrderByProject: {},
        pinnedWorkspaceKeys: [" host-b:feature ", "host-a:main", "host-b:feature", ""],
      }),
    ).toEqual({
      projectOrder: [],
      workspaceOrderByProject: {},
      pinnedWorkspaceKeys: ["host-b:feature", "host-a:main"],
    });
  });
});

describe("togglePinnedWorkspace", () => {
  it("adds a new pin at the end and removes an existing pin", () => {
    expect(togglePinnedWorkspace(["host-a:main"], "host-b:feature")).toEqual([
      "host-a:main",
      "host-b:feature",
    ]);
    expect(togglePinnedWorkspace(["host-a:main", "host-b:feature"], "host-a:main")).toEqual([
      "host-b:feature",
    ]);
  });
});
