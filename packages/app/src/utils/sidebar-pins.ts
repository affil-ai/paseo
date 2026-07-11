import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarPinPartition {
  pinnedWorkspaces: SidebarWorkspacePlacement[];
  projects: SidebarProjectEntry[];
}

export function partitionSidebarProjectsByPins(input: {
  projects: readonly SidebarProjectEntry[];
  pinnedWorkspaceKeys: readonly string[];
}): SidebarPinPartition {
  const workspaceByKey = new Map<string, SidebarWorkspacePlacement>();
  for (const project of input.projects) {
    for (const workspace of project.workspaces) {
      workspaceByKey.set(workspace.workspaceKey, workspace);
    }
  }

  const pinnedWorkspaces = input.pinnedWorkspaceKeys.flatMap((key) => {
    const workspace = workspaceByKey.get(key);
    return workspace ? [workspace] : [];
  });
  const pinnedKeys = new Set(pinnedWorkspaces.map((workspace) => workspace.workspaceKey));
  const projects = input.projects.map((project) => ({
    ...project,
    workspaces: project.workspaces.filter((workspace) => !pinnedKeys.has(workspace.workspaceKey)),
  }));

  return { pinnedWorkspaces, projects };
}
