import { describe, expect, it } from "vitest";
import type { SubagentPrTabInput } from "@/git/explorer-pr-tabs";
import type { PrHint } from "@/git/pr-hint";
import { collectWorkspaceRowPrHints, getPrBadgeTone } from "./sidebar-workspace-pr-hints";

function hint(number: number): PrHint {
  return {
    number,
    url: `https://github.com/affil-ai/paseo/pull/${number}`,
    state: "open",
    isDraft: false,
  };
}

function subagentPr(prHint: PrHint): SubagentPrTabInput {
  return {
    subagentId: `agent-${prHint.number}`,
    subagentTitle: null,
    provider: "codex",
    cwd: `/worktrees/${prHint.number}`,
    prNumber: prHint.number,
    repoOwner: "affil-ai",
    repoName: "paseo",
    prHint,
  };
}

describe("collectWorkspaceRowPrHints", () => {
  it("shows subagent PRs on a workspace row", () => {
    const result = collectWorkspaceRowPrHints({
      workspacePrHint: null,
      subagentPrs: [subagentPr(hint(20)), subagentPr(hint(25))],
    });

    expect(result.map((entry) => entry.number)).toEqual([20, 25]);
  });

  it("keeps the workspace PR first and removes duplicate subagent PRs", () => {
    const workspacePrHint = hint(20);
    const result = collectWorkspaceRowPrHints({
      workspacePrHint,
      subagentPrs: [subagentPr(workspacePrHint), subagentPr(hint(25))],
    });

    expect(result.map((entry) => entry.number)).toEqual([20, 25]);
  });

  it("uses the muted PR tone for an open draft", () => {
    expect(getPrBadgeTone({ ...hint(20), isDraft: true })).toBe("muted");
    expect(getPrBadgeTone(hint(21))).toBe("open");
  });

  it("keeps terminal PR states stronger than a stale draft bit", () => {
    expect(getPrBadgeTone({ ...hint(20), state: "merged", isDraft: true })).toBe("merged");
    expect(getPrBadgeTone({ ...hint(21), state: "closed", isDraft: true })).toBe("closed");
  });
});
