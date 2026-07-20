import { describe, expect, it } from "vitest";
import {
  buildAgentLinkReports,
  parseGithubRemote,
  type AgentLinksAgent,
  type AgentLinksWorkspace,
} from "./office-links.js";

const PARENT = "paseo.parent-agent-id";

function agent(
  id: string,
  input: { parent?: string; workspaceId?: string; cwd?: string; archivedAt?: string } = {},
): AgentLinksAgent {
  return {
    id,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    labels: input.parent ? { [PARENT]: input.parent } : {},
    archivedAt: input.archivedAt ?? null,
  };
}

describe("parseGithubRemote", () => {
  it("parses https, ssh, and scp-style remotes with and without .git", () => {
    expect(parseGithubRemote("https://github.com/affil-ai/office.git")).toEqual({
      owner: "affil-ai",
      repo: "office",
    });
    expect(parseGithubRemote("git@github.com:affil-ai/nextcard-sync")).toEqual({
      owner: "affil-ai",
      repo: "nextcard-sync",
    });
    expect(parseGithubRemote("ssh://git@github.com/affil-ai/paseo.git")).toEqual({
      owner: "affil-ai",
      repo: "paseo",
    });
    expect(parseGithubRemote("https://gitlab.com/other/repo")).toBeNull();
    expect(parseGithubRemote(null)).toBeNull();
  });
});

describe("buildAgentLinkReports", () => {
  const workspaces: AgentLinksWorkspace[] = [
    {
      id: "ws-root",
      projectRootPath: "/workspace/office",
      workspaceDirectory: "/workspace/office",
      gitRuntime: { currentBranch: "main", remoteUrl: "https://github.com/affil-ai/office.git" },
    },
    {
      id: "ws-sub",
      gitRuntime: {
        currentBranch: "feature/pr-board",
        remoteUrl: "git@github.com:affil-ai/office.git",
      },
      githubRuntime: {
        pullRequest: {
          number: 41,
          url: "https://github.com/affil-ai/office/pull/41",
          headRefName: "feature/pr-board",
          repoOwner: "affil-ai",
          repoName: "office",
        },
      },
    },
  ];

  it("collects subagent branches and PRs for the owning office binding", () => {
    const reports = buildAgentLinkReports({
      deepLinkBaseUrl: "https://affil.olumbe.com",
      serverId: "srv_m-yyB3h87NLA",
      officeBindings: [{ externalThreadId: "office:binding-1", rootAgentId: "root" }],
      agents: [
        agent("root", { cwd: "/workspace/office" }),
        agent("sub", { parent: "root", workspaceId: "ws-sub" }),
        agent("stranger", { workspaceId: "ws-sub" }),
      ],
      workspaces,
      githubPrLinks: [
        {
          owner: "affil-ai",
          repo: "paseo",
          number: 9,
          url: "https://github.com/affil-ai/paseo/pull/9",
          externalThreadId: "office:binding-1",
        },
        {
          owner: "affil-ai",
          repo: "paseo",
          number: 10,
          url: "https://github.com/affil-ai/paseo/pull/10",
          externalThreadId: "slack:C1:123",
        },
      ],
    });
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.bindingId).toBe("binding-1");
    expect(report.agentId).toBe("root");
    expect(report.paseoUrl).toBe(
      "https://affil.olumbe.com/h/srv_m-yyB3h87NLA/workspace/ws-root?open=agent%3Aroot",
    );
    expect(report.branchLinks).toEqual([
      { owner: "affil-ai", repo: "office", branch: "main", agentId: "root" },
      { owner: "affil-ai", repo: "office", branch: "feature/pr-board", agentId: "sub" },
    ]);
    // PR 41 from the subagent workspace; PR 9 from the scraped store links.
    // PR 10 belongs to a Slack thread and must not leak in.
    expect(report.prLinks.map((link) => `${link.repo}#${link.number}`).sort()).toEqual([
      "office#41",
      "paseo#9",
    ]);
  });

  it("skips archived agents, non-office bindings, and empty reports", () => {
    const reports = buildAgentLinkReports({
      deepLinkBaseUrl: "https://affil.olumbe.com",
      serverId: "srv_m-yyB3h87NLA",
      officeBindings: [
        { externalThreadId: "office:binding-2", rootAgentId: "root" },
        { externalThreadId: "slack:C9:1", rootAgentId: "slack-root" },
      ],
      agents: [agent("root", { workspaceId: "ws-sub", archivedAt: "2026-07-01T00:00:00Z" })],
      workspaces,
      githubPrLinks: [],
    });
    expect(reports).toEqual([]);
  });

  it("survives parent-label cycles without infinite looping", () => {
    const reports = buildAgentLinkReports({
      deepLinkBaseUrl: "https://affil.olumbe.com",
      serverId: "srv_m-yyB3h87NLA",
      officeBindings: [{ externalThreadId: "office:binding-3", rootAgentId: "a" }],
      agents: [
        { id: "a", labels: { [PARENT]: "b" }, archivedAt: null },
        { id: "b", workspaceId: "ws-root", labels: { [PARENT]: "a" }, archivedAt: null },
      ],
      workspaces,
      githubPrLinks: [],
    });
    // b's walk (b → a → back to b) terminates at "a", which owns the binding.
    expect(reports).toHaveLength(1);
    expect(reports[0]!.branchLinks).toEqual([
      { owner: "affil-ai", repo: "office", branch: "main", agentId: "b" },
    ]);
  });
});
