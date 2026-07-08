import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { selectSubagentsForParent, selectSubagentsForWorkspace } from "./select";
import { useSessionStore, type Agent } from "@/stores/session-store";

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");
const EMPTY_PENDING_ARCHIVE_IDS = new Set<string>();

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function setAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("selectSubagentsForParent", () => {
  it("returns only non-archived children for the requested parent", () => {
    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "child-a", parentAgentId: "parent-a" }),
      makeAgent({
        id: "archived-child",
        parentAgentId: "parent-a",
        archivedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent-a",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("excludes siblings, unrelated agents, and grandchildren", () => {
    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "parent-b" }),
      makeAgent({ id: "child-a", parentAgentId: "parent-a" }),
      makeAgent({ id: "sibling-b", parentAgentId: "parent-b" }),
      makeAgent({ id: "grandchild-a", parentAgentId: "child-a" }),
      makeAgent({ id: "unrelated" }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent-a",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("shows only direct children for each parent", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child", parentAgentId: "parent" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
    ]);

    const parentRows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );
    const childRows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "child",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(parentRows.map((row) => row.id)).toEqual(["child"]);
    expect(childRows.map((row) => row.id)).toEqual(["grandchild"]);
  });

  it("sorts by createdAt ascending", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({
        id: "third",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:03:00.000Z"),
      }),
      makeAgent({
        id: "first",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      }),
      makeAgent({
        id: "second",
        parentAgentId: "parent",
        createdAt: new Date("2026-03-08T10:02:00.000Z"),
      }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["first", "second", "third"]);
  });

  it("maps only row-rendered fields and does not expose onOpen", () => {
    const createdAt = new Date("2026-03-08T10:01:00.000Z");
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({
        id: "child",
        parentAgentId: "parent",
        provider: "claude",
        title: "Review child",
        status: "running",
        requiresAttention: true,
        createdAt,
        model: "should-not-leak",
        cwd: "/private/project",
      }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows).toEqual([
      {
        id: "child",
        provider: "claude",
        title: "Review child",
        status: "running",
        requiresAttention: true,
        createdAt,
      },
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "provider",
      "requiresAttention",
      "status",
      "title",
    ]);
    expect(rows[0]).not.toHaveProperty("onOpen");
    expect(rows[0]).not.toHaveProperty("model");
    expect(rows[0]).not.toHaveProperty("cwd");
  });

  it("moves a child when parentAgentId changes", () => {
    const child = makeAgent({ id: "child", parentAgentId: "parent-a" });
    setAgents([makeAgent({ id: "parent-a" }), makeAgent({ id: "parent-b" }), child]);

    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-a",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual(["child"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-b",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual([]);

    setAgents([
      makeAgent({ id: "parent-a" }),
      makeAgent({ id: "parent-b" }),
      { ...child, parentAgentId: "parent-b" },
    ]);

    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-a",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual([]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-b",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ).map((row) => row.id),
    ).toEqual(["child"]);
  });

  it("excludes children whose archive is pending", () => {
    setAgents([
      makeAgent({ id: "parent" }),
      makeAgent({ id: "child-a", parentAgentId: "parent" }),
      makeAgent({ id: "child-b", parentAgentId: "parent" }),
    ]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      new Set(["child-b"]),
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a"]);
  });

  it("returns the shared empty array when pending archive hides the last child", () => {
    setAgents([makeAgent({ id: "parent" }), makeAgent({ id: "child", parentAgentId: "parent" })]);

    const rows = selectSubagentsForParent(
      useSessionStore.getState(),
      {
        serverId: SERVER_ID,
        parentAgentId: "parent",
      },
      new Set(["child"]),
    );

    expect(rows).toEqual([]);
    expect(rows).toBe(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "missing-parent",
        },
        EMPTY_PENDING_ARCHIVE_IDS,
      ),
    );
  });
});

describe("selectSubagentsForWorkspace", () => {
  const WORKSPACE_ID = "ws-1";

  it("lists children whose parent lives in the workspace, even when they run in their own worktree", () => {
    // Primary office-agent case: the parent belongs to WORKSPACE_ID, each child
    // runs in its own fresh worktree (a different workspaceId). The children
    // must surface in the PARENT's workspace Subagents tab.
    setAgents([
      makeAgent({ id: "office-agent", workspaceId: WORKSPACE_ID }),
      makeAgent({
        id: "child-a",
        parentAgentId: "office-agent",
        workspaceId: "ws-worktree-a",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      }),
      makeAgent({
        id: "child-b",
        parentAgentId: "office-agent",
        workspaceId: "ws-worktree-b",
        createdAt: new Date("2026-03-08T10:02:00.000Z"),
      }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a", "child-b"]);
  });

  it("lists children across multiple parents that live in the workspace", () => {
    setAgents([
      makeAgent({ id: "parent-a", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "parent-b", workspaceId: WORKSPACE_ID }),
      makeAgent({
        id: "child-a",
        parentAgentId: "parent-a",
        workspaceId: "ws-worktree-a",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      }),
      makeAgent({
        id: "child-b",
        parentAgentId: "parent-b",
        workspaceId: "ws-worktree-b",
        createdAt: new Date("2026-03-08T10:02:00.000Z"),
      }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["child-a", "child-b"]);
  });

  it("also lists a locally-run subagent whose own workspaceId matches (union)", () => {
    // The child's parent lives elsewhere, but the child itself runs in this
    // workspace. Kept via the workspaceId union so the child's own worktree
    // still lists it and nothing regresses.
    setAgents([
      makeAgent({ id: "remote-parent", workspaceId: "ws-other" }),
      makeAgent({ id: "local-child", parentAgentId: "remote-parent", workspaceId: WORKSPACE_ID }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows.map((row) => row.id)).toEqual(["local-child"]);
  });

  it("excludes root agents and children whose parent and self are both elsewhere", () => {
    setAgents([
      makeAgent({ id: "root", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "child-here", parentAgentId: "root", workspaceId: "ws-worktree" }),
      makeAgent({ id: "remote-parent", workspaceId: "ws-other" }),
      makeAgent({
        id: "child-elsewhere",
        parentAgentId: "remote-parent",
        workspaceId: "ws-other",
      }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    // child-here: parent (root) is in WORKSPACE_ID -> included.
    // child-elsewhere: parent and self both in ws-other -> excluded.
    // root: no parentAgentId -> excluded.
    expect(rows.map((row) => row.id)).toEqual(["child-here"]);
  });

  it("matches direct parent only for multi-level delegation", () => {
    // grandchild's direct parent (child) lives in ws-worktree, not WORKSPACE_ID,
    // so it does NOT surface here even though the top-level ancestor does.
    setAgents([
      makeAgent({ id: "office-agent", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "child", parentAgentId: "office-agent", workspaceId: "ws-worktree" }),
      makeAgent({ id: "grandchild", parentAgentId: "child", workspaceId: "ws-worktree" }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    // Only the direct child of the in-workspace parent surfaces here.
    expect(rows.map((row) => row.id)).toEqual(["child"]);
  });

  it("skips a child whose parent is not loaded and whose own workspace differs", () => {
    setAgents([
      makeAgent({ id: "orphan-child", parentAgentId: "missing-parent", workspaceId: "ws-other" }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      EMPTY_PENDING_ARCHIVE_IDS,
    );

    expect(rows).toEqual([]);
  });

  it("excludes archived and pending-archive subagents", () => {
    setAgents([
      makeAgent({ id: "parent", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "child-active", parentAgentId: "parent", workspaceId: WORKSPACE_ID }),
      makeAgent({
        id: "child-archived",
        parentAgentId: "parent",
        workspaceId: WORKSPACE_ID,
        archivedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
      makeAgent({ id: "child-pending", parentAgentId: "parent", workspaceId: WORKSPACE_ID }),
    ]);

    const rows = selectSubagentsForWorkspace(
      useSessionStore.getState(),
      { serverId: SERVER_ID, workspaceId: WORKSPACE_ID },
      new Set(["child-pending"]),
    );

    expect(rows.map((row) => row.id)).toEqual(["child-active"]);
  });
});
