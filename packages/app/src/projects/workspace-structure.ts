import type { EmptyProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import { getFirstSortableTimestamp } from "@/utils/sidebar-recency";

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  iconWorkingDir: string;
  canCreateWorktree: boolean;
}

export interface WorkspaceStructureProject {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  hosts: WorkspaceStructureHostPlacement[];
  workspaceKeys: string[];
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
}

interface WorkspaceStructureItem {
  workspaceId: string;
  workspaceName: string;
  workspaceKey: string;
  // Recency timestamp (ms) used to sort by activity descending. Number.NEGATIVE_INFINITY
  // when the daemon reports no activity, so those workspaces sink to the bottom.
  recencyMs: number;
}

// Sidebar workspaces sort by recency descending (most recent activity first),
// matching the Conductor-style sidebar. Manual workspace drag ordering is
// intentionally NOT applied to this view — see composeWorkspaceStructure.
function compareWorkspaceStructureItems(
  left: WorkspaceStructureItem,
  right: WorkspaceStructureItem,
): number {
  if (left.recencyMs !== right.recencyMs) {
    return right.recencyMs > left.recencyMs ? 1 : -1;
  }

  const nameDelta = left.workspaceName.localeCompare(right.workspaceName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.workspaceId.localeCompare(right.workspaceId, undefined, {
    sensitivity: "base",
  });
}

// Projects sort by the recency of their most-recently-active child workspace,
// descending, so the project with fresh activity floats to the top. Projects
// with no active children fall back to a stable name comparison.
function compareWorkspaceStructureProjects(
  left: WorkspaceStructureProject & { recencyMs: number },
  right: WorkspaceStructureProject & { recencyMs: number },
): number {
  if (left.recencyMs !== right.recencyMs) {
    return right.recencyMs > left.recencyMs ? 1 : -1;
  }
  return left.projectName.localeCompare(right.projectName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function workspaceRecencyMs(workspace: WorkspaceDescriptor): number {
  const statusEnteredAtIso =
    workspace.statusEnteredAt instanceof Date ? workspace.statusEnteredAt.toISOString() : null;
  return (
    getFirstSortableTimestamp(workspace.activityAt, statusEnteredAtIso) ?? Number.NEGATIVE_INFINITY
  );
}

function canCreateWorktreeForProjectKind(projectKind: WorkspaceDescriptor["projectKind"]): boolean {
  return projectKind === "git";
}

interface WorkspaceStructureSession {
  serverId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
  emptyProjects?: Iterable<EmptyProjectDescriptor>;
}

export function buildWorkspaceStructureProjects(input: {
  sessions: WorkspaceStructureSession[];
}): WorkspaceStructureProject[] {
  const byProject = new Map<
    string,
    {
      projectKey: string;
      projectName: string;
      projectKind: WorkspaceDescriptor["projectKind"];
      iconWorkingDir: string;
      hosts: Map<string, WorkspaceStructureHostPlacement>;
      workspaces: WorkspaceStructureItem[];
    }
  >();

  for (const session of input.sessions) {
    for (const emptyProject of session.emptyProjects ?? []) {
      const projectKey = emptyProject.projectId;
      const placement = {
        serverId: session.serverId,
        iconWorkingDir: emptyProject.projectRootPath,
        canCreateWorktree: canCreateWorktreeForProjectKind(emptyProject.projectKind),
      };
      const existing = byProject.get(projectKey);

      if (!existing) {
        byProject.set(projectKey, {
          projectKey,
          projectName:
            emptyProject.projectCustomName ??
            emptyProject.projectDisplayName ??
            projectDisplayNameFromProjectId(projectKey),
          projectKind: emptyProject.projectKind,
          iconWorkingDir: emptyProject.projectRootPath,
          hosts: new Map([[session.serverId, placement]]),
          workspaces: [],
        });
        continue;
      }

      existing.hosts.set(session.serverId, placement);
    }

    for (const workspace of session.workspaces) {
      const projectKey = workspace.project?.projectKey ?? workspace.projectId;
      const existing = byProject.get(projectKey);

      if (!existing) {
        byProject.set(projectKey, {
          projectKey,
          projectName:
            workspace.projectCustomName ??
            workspace.projectDisplayName ??
            projectDisplayNameFromProjectId(projectKey),
          projectKind: workspace.projectKind,
          iconWorkingDir: workspace.projectRootPath,
          hosts: new Map([
            [
              session.serverId,
              {
                serverId: session.serverId,
                iconWorkingDir: workspace.projectRootPath,
                canCreateWorktree: canCreateWorktreeForProjectKind(workspace.projectKind),
              },
            ],
          ]),
          workspaces: [
            {
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              workspaceKey: `${session.serverId}:${workspace.id}`,
              recencyMs: workspaceRecencyMs(workspace),
            },
          ],
        });
        continue;
      }

      existing.hosts.set(session.serverId, {
        serverId: session.serverId,
        iconWorkingDir: workspace.projectRootPath,
        canCreateWorktree: canCreateWorktreeForProjectKind(workspace.projectKind),
      });
      existing.workspaces.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKey: `${session.serverId}:${workspace.id}`,
        recencyMs: workspaceRecencyMs(workspace),
      });
    }
  }

  const projects: Array<WorkspaceStructureProject & { recencyMs: number }> = [];
  for (const raw of byProject.values()) {
    const sortedWorkspaces = [...raw.workspaces].sort(compareWorkspaceStructureItems);
    const projectRecencyMs = raw.workspaces.reduce(
      (max, workspace) => (workspace.recencyMs > max ? workspace.recencyMs : max),
      Number.NEGATIVE_INFINITY,
    );
    projects.push({
      projectKey: raw.projectKey,
      projectName: raw.projectName,
      projectKind: raw.projectKind,
      iconWorkingDir: raw.iconWorkingDir,
      hosts: Array.from(raw.hosts.values()),
      workspaceKeys: sortedWorkspaces.map((w) => w.workspaceKey),
      recencyMs: projectRecencyMs,
    });
  }

  projects.sort(compareWorkspaceStructureProjects);
  return projects.map(({ recencyMs: _recencyMs, ...project }) => project);
}
