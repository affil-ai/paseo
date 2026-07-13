import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarWorkspaceEntries,
  buildSidebarWorkspacePlacementModel,
  buildSidebarProjectsFromStructure,
  computeSidebarOrderUpdates,
  createSidebarWorkspaceEntry,
  deriveSidebarLoadingState,
  prioritizeOfficeProjects,
  shouldShowSidebarHostLabels,
  type SidebarProjectEntry,
} from "./sidebar-workspaces-view-model";

interface OrderedItem {
  key: string;
}

function item(key: string): OrderedItem {
  return { key };
}

function project(input: {
  projectKey: string;
  projectName?: string;
  projectKind?: WorkspaceStructureProject["projectKind"];
  iconWorkingDir?: string;
  workspaceKeys: string[];
  hosts?: WorkspaceStructureProject["hosts"];
}): WorkspaceStructureProject {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName ?? input.projectKey,
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
    hosts: input.hosts ?? [
      {
        serverId: "srv",
        iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
        canCreateWorktree: true,
      },
    ],
    workspaceKeys: input.workspaceKeys,
  };
}

function sidebarProject(input: {
  projectKey: string;
  workspaceKeys: string[];
}): SidebarProjectEntry {
  const projects = buildSidebarProjectsFromStructure({
    projects: [project({ projectKey: input.projectKey, workspaceKeys: input.workspaceKeys })],
  });
  const result = projects[0];
  if (!result) {
    throw new Error("expected a project entry");
  }
  return result;
}

function workspace(input: {
  id: string;
  name: string;
  projectId: string;
  projectDisplayName: string;
  status?: WorkspaceDescriptor["status"];
  statusEnteredAt?: Date | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.id}`,
    projectKind: "git",
    workspaceKind: input.name === "main" ? "local_checkout" : "worktree",
    name: input.name,
    status: input.status ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function agent(input: {
  id: string;
  workspaceId: string;
  status?: Agent["status"];
  labels?: Record<string, string>;
  parentAgentId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
}): Agent {
  return {
    id: input.id,
    serverId: "srv",
    provider: "pi",
    status: input.status ?? "idle",
    createdAt: input.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo/project",
    workspaceId: input.workspaceId,
    model: null,
    thinkingOptionId: null,
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
  } as unknown as Agent;
}

describe("applyStoredOrdering", () => {
  it("keeps unknown items on the baseline while applying stored order", () => {
    const result = applyStoredOrdering({
      items: [item("new"), item("a"), item("b")],
      storedOrder: ["b", "a"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["new", "b", "a"]);
  });

  it("ignores stale and duplicate stored keys", () => {
    const result = applyStoredOrdering({
      items: [item("x"), item("y")],
      storedOrder: ["missing", "y", "y", "x"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["y", "x"]);
  });

  it("returns baseline when there is no persisted order", () => {
    const baseline = [item("first"), item("second")];
    const result = applyStoredOrdering({
      items: baseline,
      storedOrder: [],
      getKey: (entry) => entry.key,
    });

    expect(result).toBe(baseline);
  });
});

describe("prioritizeOfficeProjects", () => {
  it("pins configured Office projects first while preserving relative order", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-a"] }),
      sidebarProject({ projectKey: "office-b", workspaceKeys: ["ws-b"] }),
      sidebarProject({ projectKey: "project-c", workspaceKeys: ["ws-c"] }),
      sidebarProject({ projectKey: "office-d", workspaceKeys: ["ws-d"] }),
    ];

    const result = prioritizeOfficeProjects({
      projects,
      officeProjectKeys: new Set(["office-b", "office-d"]),
    });

    expect(result.map((entry) => entry.projectKey)).toEqual([
      "office-b",
      "office-d",
      "project-a",
      "project-c",
    ]);
  });

  it("pins the canonical affil-ai/office project when daemon config is unavailable", () => {
    const projects = [
      sidebarProject({ projectKey: "remote:github.com/affil-ai/affil", workspaceKeys: ["ws-a"] }),
      sidebarProject({
        projectKey: "remote:github.com/affil-ai/office",
        workspaceKeys: ["ws-office"],
      }),
      sidebarProject({ projectKey: "remote:github.com/affil-ai/paseo", workspaceKeys: ["ws-p"] }),
    ];

    const result = prioritizeOfficeProjects({
      projects,
      officeProjectKeys: new Set(),
    });

    expect(result.map((entry) => entry.projectKey)).toEqual([
      "remote:github.com/affil-ai/office",
      "remote:github.com/affil-ai/affil",
      "remote:github.com/affil-ai/paseo",
    ]);
  });
});

describe("appendMissingOrderKeys", () => {
  it("appends unseen keys while preserving existing order", () => {
    const result = appendMissingOrderKeys({
      currentOrder: ["project-b", "project-a"],
      visibleKeys: ["project-a", "project-b", "project-c"],
    });

    expect(result).toEqual(["project-b", "project-a", "project-c"]);
  });

  it("returns the same array when there are no unseen keys", () => {
    const currentOrder = ["project-a", "project-b"];

    const result = appendMissingOrderKeys({
      currentOrder,
      visibleKeys: ["project-b", "project-a"],
    });

    expect(result).toBe(currentOrder);
  });
});

describe("buildSidebarProjectsFromStructure", () => {
  it("creates structural workspace rows from ordered workspace keys", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo/main",
          workspaceKeys: ["ws-main"],
        }),
      ],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectName).toBe("Project 1");
    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "srv:ws-main",
      serverId: "srv",
      workspaceId: "ws-main",
      projectRootPath: "/repo/main",
      projectKind: "git",
    });
  });

  it("preserves the structure hook project order", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({ projectKey: "project-b", workspaceKeys: ["ws-b"] }),
        project({ projectKey: "project-a", workspaceKeys: ["ws-a"] }),
      ],
    });

    expect(projects.map((entry) => entry.projectKey)).toEqual(["project-b", "project-a"]);
  });

  it("preserves the structure hook workspace order", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [project({ projectKey: "project-1", workspaceKeys: ["feature", "main"] })],
    });

    expect(projects[0]?.workspaces.map((placement) => placement.workspaceId)).toEqual([
      "feature",
      "main",
    ]);
  });

  it("resolves workspace keys by known host prefix when server ids contain colons", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-1",
          hosts: [
            {
              serverId: "relay:paseo-host",
              iconWorkingDir: "/repo/project-1",
              canCreateWorktree: true,
            },
          ],
          workspaceKeys: ["relay:paseo-host:ws-main"],
        }),
      ],
    });

    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "relay:paseo-host:ws-main",
      serverId: "relay:paseo-host",
      workspaceId: "ws-main",
    });
  });
});

describe("shared sidebar workspace model", () => {
  it("feeds project placement and status grouping from the same cross-host workspace identities", () => {
    const model = buildSidebarWorkspacePlacementModel({
      projects: [
        project({
          projectKey: "getpaseo/paseo",
          projectName: "getpaseo/paseo",
          iconWorkingDir: "/repo/getpaseo/paseo",
          hosts: [
            { serverId: "host-a", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
            { serverId: "host-b", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-a:main", "host-b:feature"],
        }),
      ],
    });
    const workspaceEntries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "host-a",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "main",
              workspace({
                id: "main",
                name: "main",
                projectId: "getpaseo/paseo",
                projectDisplayName: "getpaseo/paseo",
                status: "done",
              }),
            ],
          ]),
        },
        {
          serverId: "host-b",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "feature",
              workspace({
                id: "feature",
                name: "feature/status-flow",
                projectId: "getpaseo/paseo",
                projectDisplayName: "getpaseo/paseo",
                status: "running",
                statusEnteredAt: new Date("2026-06-10T00:00:00.000Z"),
              }),
            ],
          ]),
        },
      ],
    });

    expect(model.workspaces.map((entry) => entry.workspaceKey)).toEqual([
      "host-a:main",
      "host-b:feature",
    ]);
    expect(model.projects).toEqual([
      expect.objectContaining({
        projectKey: "getpaseo/paseo",
        hosts: [
          { serverId: "host-a", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
          { serverId: "host-b", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
        ],
        workspaces: [
          expect.objectContaining({
            workspaceKey: "host-a:main",
            serverId: "host-a",
            name: "main",
          }),
          expect.objectContaining({
            workspaceKey: "host-b:feature",
            serverId: "host-b",
            name: "feature",
          }),
        ],
      }),
    ]);
    expect(
      Array.from(workspaceEntries.values()).map((entry) => [
        entry.workspaceKey,
        entry.statusBucket,
        entry.name,
      ]),
    ).toEqual([
      ["host-a:main", "done", "main"],
      ["host-b:feature", "running", "feature/status-flow"],
    ]);
    expect(model.projectNamesByKey).toEqual(new Map([["getpaseo/paseo", "getpaseo/paseo"]]));
  });

  it("preserves unchanged row identities when another workspace updates", () => {
    const model = buildSidebarWorkspacePlacementModel({
      projects: [project({ projectKey: "project", workspaceKeys: ["srv:one", "srv:two"] })],
    });
    const one = workspace({
      id: "one",
      name: "one",
      projectId: "project",
      projectDisplayName: "project",
    });
    const two = workspace({
      id: "two",
      name: "two",
      projectId: "project",
      projectDisplayName: "project",
    });
    const previousEntries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "srv",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            ["one", one],
            ["two", two],
          ]),
        },
      ],
    });
    const nextEntries = buildSidebarWorkspaceEntries({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "srv",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            ["one", one],
            ["two", { ...two, status: "running" }],
          ]),
        },
      ],
      previousEntries,
    });

    expect(nextEntries.get("srv:one")).toBe(previousEntries.get("srv:one"));
    expect(nextEntries.get("srv:two")).not.toBe(previousEntries.get("srv:two"));
  });
});

describe("createSidebarWorkspaceEntry", () => {
  it("marks a root workspace as running when one of its subagents is running", () => {
    const entry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspace({
        id: "parent-workspace",
        name: "parent-workspace",
        projectId: "office",
        projectDisplayName: "office",
        status: "done",
      }),
      agents: new Map([
        [
          "parent",
          agent({
            id: "parent",
            workspaceId: "parent-workspace",
            status: "idle",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "child-worktree",
            parentAgentId: "parent",
            status: "running",
            updatedAt: new Date("2026-06-01T12:00:00.000Z"),
          }),
        ],
      ]),
    });

    expect(entry.statusBucket).toBe("running");
    expect(entry.statusEnteredAt).toEqual(new Date("2026-06-01T12:00:00.000Z"));
  });

  it("does not mark a root workspace active for non-running subagent attention", () => {
    const entry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspace({
        id: "parent-workspace",
        name: "parent-workspace",
        projectId: "office",
        projectDisplayName: "office",
        status: "done",
      }),
      agents: new Map([
        [
          "parent",
          agent({
            id: "parent",
            workspaceId: "parent-workspace",
            status: "idle",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "child-worktree",
            parentAgentId: "parent",
            status: "idle",
            requiresAttention: true,
            attentionReason: "finished",
          }),
        ],
      ]),
    });

    expect(entry.statusBucket).toBe("done");
  });

  it("derives Slack starter metadata from the workspace root agent", () => {
    const entry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspace({
        id: "office-thread",
        name: "office-thread",
        projectId: "office",
        projectDisplayName: "office",
      }),
      agents: new Map([
        [
          "agent-child",
          agent({
            id: "agent-child",
            workspaceId: "office-thread",
            parentAgentId: "agent-office",
            labels: {
              "paseo.chat-started-by-source": "slack",
              "paseo.chat-started-by-user-id": "U-child",
              "paseo.chat-started-by-name": "Child",
            },
          }),
        ],
        [
          "agent-office",
          agent({
            id: "agent-office",
            workspaceId: "office-thread",
            labels: {
              "paseo.chat-started-by-source": "slack",
              "paseo.chat-started-by-user-id": "U123",
              "paseo.chat-started-by-name": "Jane Doe",
              "paseo.chat-started-by-handle": "jane",
              "paseo.chat-started-by-avatar-url": "https://example.com/jane.png",
            },
          }),
        ],
      ]),
    });

    expect(entry.chatStartedBy).toEqual({
      source: "slack",
      userId: "U123",
      name: "Jane Doe",
      handle: "jane",
      avatarUrl: "https://example.com/jane.png",
    });
    expect(entry.workspaceOrigin).toBe("slack");
  });

  it("derives support and schedule origins from workspace root agents", () => {
    const supportEntry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspace({
        id: "support-thread",
        name: "support-thread",
        projectId: "office",
        projectDisplayName: "office",
      }),
      agents: new Map([
        [
          "support-agent",
          agent({
            id: "support-agent",
            workspaceId: "support-thread",
            labels: {
              "paseo.chat-started-by-source": "support",
              "paseo.chat-started-by-user-id": "customer@example.com",
              "paseo.chat-started-by-name": "Customer",
            },
          }),
        ],
      ]),
    });
    const scheduleEntry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: workspace({
        id: "scheduled-workspace",
        name: "scheduled-workspace",
        projectId: "project",
        projectDisplayName: "project",
      }),
      agents: new Map([
        [
          "scheduled-agent",
          agent({
            id: "scheduled-agent",
            workspaceId: "scheduled-workspace",
            labels: { "paseo.schedule-id": "schedule-1" },
          }),
        ],
      ]),
    });

    expect(supportEntry.workspaceOrigin).toBe("support");
    expect(scheduleEntry.workspaceOrigin).toBe("schedule");
  });
});

describe("shouldShowSidebarHostLabels", () => {
  it("is false with no visible projects", () => {
    expect(shouldShowSidebarHostLabels([])).toBe(false);
  });

  it("is false when every project lives on a single host", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
        project({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(false);
  });

  it("is true when projects span separate hosts", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-a",
          hosts: [
            { serverId: "host-a", iconWorkingDir: "/repo/project-a", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-a:ws-1"],
        }),
        project({
          projectKey: "project-b",
          hosts: [
            { serverId: "host-b", iconWorkingDir: "/repo/project-b", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-b:ws-2"],
        }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(true);
  });

  it("is true for a single project shared across hosts", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "getpaseo/paseo",
          hosts: [
            { serverId: "host-a", iconWorkingDir: "/repo/paseo", canCreateWorktree: true },
            { serverId: "host-b", iconWorkingDir: "/repo/paseo", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-a:main", "host-b:feature"],
        }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(true);
  });
});

describe("computeSidebarOrderUpdates", () => {
  it("returns no updates when there are no visible projects", () => {
    const updates = computeSidebarOrderUpdates({
      projects: [],
      persistedProjectOrder: ["stale-project"],
      getWorkspaceOrder: () => [],
    });

    expect(updates).toEqual({ projectOrder: null, workspaceOrders: [] });
  });

  it("appends unseen projects and workspaces to the persisted orders", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1", "ws-2"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-3"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : []),
    });

    expect(updates.projectOrder).toEqual(["project-a", "project-b"]);
    expect(updates.workspaceOrders).toEqual([
      { projectKey: "project-a", order: ["srv:ws-1", "srv:ws-2"] },
      { projectKey: "project-b", order: ["srv:ws-3"] },
    ]);
  });

  it("returns no project-order update when persisted order already covers visible keys", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-b", "project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : ["srv:ws-2"]),
    });

    expect(updates.projectOrder).toBeNull();
    expect(updates.workspaceOrders).toEqual([]);
  });
});

describe("deriveSidebarLoadingState", () => {
  it("reports initial-load while active and unhydrated with no projects", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: false,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: true, isRevalidating: false });
  });

  it("stays loading but not initial once projects are visible", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: true,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: false, isRevalidating: false });
  });

  it("clears loading once workspaces have hydrated", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: ["srv"],
        hasProjects: true,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });

  it("short-circuits to idle when inactive", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: false,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: false,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });
});
