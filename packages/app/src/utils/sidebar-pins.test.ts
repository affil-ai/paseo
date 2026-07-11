import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { partitionSidebarProjectsByPins } from "./sidebar-pins";

function project(projectKey: string, workspaceKeys: string[]): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: `/repo/${projectKey}`,
    hosts: [],
    workspaces: workspaceKeys.map((workspaceKey) => ({
      workspaceKey,
      serverId: workspaceKey.split(":")[0] ?? "host",
      workspaceId: workspaceKey.split(":")[1] ?? "workspace",
      projectKey,
      projectName: projectKey,
      projectKind: "git",
      workspaceKind: "worktree",
      name: workspaceKey,
    })),
  };
}

describe("partitionSidebarProjectsByPins", () => {
  it("orders pinned workspaces by pin order and removes them from project rows", () => {
    const result = partitionSidebarProjectsByPins({
      projects: [
        project("project-a", ["host-a:main", "host-a:feature"]),
        project("project-b", ["host-b:main"]),
      ],
      pinnedWorkspaceKeys: ["host-b:main", "missing:workspace", "host-a:feature"],
    });

    expect(result.pinnedWorkspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "host-b:main",
      "host-a:feature",
    ]);
    const projectWorkspaceKeys = result.projects.map(projectWorkspaceKeySummary);
    expect(projectWorkspaceKeys).toEqual([
      { projectKey: "project-a", workspaceKeys: ["host-a:main"] },
      { projectKey: "project-b", workspaceKeys: [] },
    ]);
  });
});

function projectWorkspaceKeySummary(projectEntry: SidebarProjectEntry) {
  return {
    projectKey: projectEntry.projectKey,
    workspaceKeys: projectEntry.workspaces.map((workspace) => workspace.workspaceKey),
  };
}
