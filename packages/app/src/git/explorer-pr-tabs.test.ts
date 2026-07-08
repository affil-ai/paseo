import { describe, expect, it } from "vitest";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  buildSubagentPrTabs,
  prIdentityKey,
  MAX_INLINE_SUBAGENT_PR_TABS,
  type SubagentPrTabInput,
} from "./explorer-pr-tabs";

function subagentPr(
  input: Partial<SubagentPrTabInput> & { subagentId: string },
): SubagentPrTabInput {
  return {
    subagentId: input.subagentId,
    subagentTitle: input.subagentTitle ?? null,
    provider: (input.provider ?? "codex") as AgentProvider,
    cwd: input.cwd ?? `/repo/${input.subagentId}`,
    prNumber: input.prNumber ?? 1,
    repoOwner: input.repoOwner ?? "acme",
    repoName: input.repoName ?? "app",
  };
}

describe("prIdentityKey", () => {
  it("uses owner/repo/number when available", () => {
    expect(prIdentityKey({ prNumber: 42, repoOwner: "acme", repoName: "app" }, "/x")).toBe(
      "acme/app#42",
    );
  });

  it("falls back to cwd/number when owner or repo is missing", () => {
    expect(prIdentityKey({ prNumber: 42, repoOwner: null, repoName: "app" }, "/x")).toBe("/x#42");
    expect(prIdentityKey({ prNumber: 42, repoOwner: "acme", repoName: null }, "/y")).toBe("/y#42");
  });
});

describe("buildSubagentPrTabs", () => {
  it("returns distinct subagent PRs inline, in input order", () => {
    const result = buildSubagentPrTabs({
      workspacePr: null,
      workspaceCwd: "/repo/main",
      subagentPrs: [
        subagentPr({ subagentId: "a", prNumber: 10 }),
        subagentPr({ subagentId: "b", prNumber: 11 }),
      ],
    });
    expect(result.inline.map((tab) => tab.prNumber)).toEqual([10, 11]);
    expect(result.overflow).toEqual([]);
    expect(result.inline[0]?.key).toBe("acme/app#10");
  });

  it("de-dupes subagent PRs that point at the same PR identity", () => {
    const result = buildSubagentPrTabs({
      workspacePr: null,
      workspaceCwd: "/repo/main",
      subagentPrs: [
        subagentPr({ subagentId: "a", prNumber: 10, cwd: "/repo/wt-a" }),
        subagentPr({ subagentId: "b", prNumber: 10, cwd: "/repo/wt-b" }),
      ],
    });
    expect(result.inline).toHaveLength(1);
    expect(result.inline[0]?.subagentId).toBe("a");
  });

  it("de-dupes a subagent PR against the workspace's own PR", () => {
    const result = buildSubagentPrTabs({
      workspacePr: { prNumber: 10, repoOwner: "acme", repoName: "app" },
      workspaceCwd: "/repo/main",
      subagentPrs: [
        subagentPr({ subagentId: "a", prNumber: 10 }),
        subagentPr({ subagentId: "b", prNumber: 11 }),
      ],
    });
    expect(result.inline.map((tab) => tab.prNumber)).toEqual([11]);
  });

  it("caps inline tabs and rolls the remainder into overflow", () => {
    const many = Array.from({ length: MAX_INLINE_SUBAGENT_PR_TABS + 3 }, (_, index) =>
      subagentPr({ subagentId: `s${index}`, prNumber: 100 + index }),
    );
    const result = buildSubagentPrTabs({
      workspacePr: null,
      workspaceCwd: "/repo/main",
      subagentPrs: many,
    });
    expect(result.inline).toHaveLength(MAX_INLINE_SUBAGENT_PR_TABS);
    expect(result.overflow).toHaveLength(3);
    expect(result.inline.map((tab) => tab.subagentId)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(result.overflow.map((tab) => tab.subagentId)).toEqual(["s4", "s5", "s6"]);
  });

  it("respects a custom cap", () => {
    const result = buildSubagentPrTabs({
      workspacePr: null,
      workspaceCwd: "/repo/main",
      subagentPrs: [
        subagentPr({ subagentId: "a", prNumber: 1 }),
        subagentPr({ subagentId: "b", prNumber: 2 }),
        subagentPr({ subagentId: "c", prNumber: 3 }),
      ],
      cap: 2,
    });
    expect(result.inline.map((tab) => tab.subagentId)).toEqual(["a", "b"]);
    expect(result.overflow.map((tab) => tab.subagentId)).toEqual(["c"]);
  });
});
