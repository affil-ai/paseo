import { describe, expect, it } from "vitest";

import { buildFileTabLabelOverrides } from "@/screens/workspace/workspace-file-tab-labels";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function fileTab(path: string): WorkspaceTabDescriptor {
  return {
    key: path,
    tabId: `file_${path}`,
    kind: "file",
    target: { kind: "file", path },
  };
}

function agentTab(agentId: string): WorkspaceTabDescriptor {
  return {
    key: agentId,
    tabId: `agent_${agentId}`,
    kind: "agent",
    target: { kind: "agent", agentId },
  };
}

describe("buildFileTabLabelOverrides", () => {
  it("returns no overrides when file names are unique", () => {
    const overrides = buildFileTabLabelOverrides([
      fileTab("apps/web/src/a.ts"),
      fileTab("apps/web/src/b.ts"),
    ]);
    expect(overrides.size).toBe(0);
  });

  it("prefixes the parent folder for colliding names", () => {
    const overrides = buildFileTabLabelOverrides([
      fileTab("apps/web/src/api.md"),
      fileTab("docs/plans/api.md"),
    ]);
    expect(overrides.get("apps/web/src/api.md")).toBe("src/api.md");
    expect(overrides.get("docs/plans/api.md")).toBe("plans/api.md");
  });

  it("only prefixes the immediate parent folder, never the full path", () => {
    const overrides = buildFileTabLabelOverrides([
      fileTab("a/shared/index.ts"),
      fileTab("b/shared/index.ts"),
    ]);
    expect(overrides.get("a/shared/index.ts")).toBe("shared/index.ts");
    expect(overrides.get("b/shared/index.ts")).toBe("shared/index.ts");
  });

  it("ignores non-file tabs and de-duplicates identical paths", () => {
    const overrides = buildFileTabLabelOverrides([
      agentTab("agent-1"),
      fileTab("x/file.ts"),
      fileTab("x/file.ts"),
    ]);
    expect(overrides.size).toBe(0);
  });

  it("only disambiguates the colliding group", () => {
    const overrides = buildFileTabLabelOverrides([
      fileTab("one/deep/file.ts"),
      fileTab("two/deep/file.ts"),
      fileTab("solo/unique.ts"),
    ]);
    expect(overrides.get("one/deep/file.ts")).toBe("deep/file.ts");
    expect(overrides.get("two/deep/file.ts")).toBe("deep/file.ts");
    expect(overrides.has("solo/unique.ts")).toBe(false);
  });

  it("handles a file at the repo root colliding with a nested file", () => {
    const overrides = buildFileTabLabelOverrides([fileTab("file.ts"), fileTab("nested/file.ts")]);
    expect(overrides.get("file.ts")).toBe("file.ts");
    expect(overrides.get("nested/file.ts")).toBe("nested/file.ts");
    // Note: collisions where the parent folder is also identical are not fully
    // resolvable with parent-folder-only labels; that's an accepted tradeoff.
  });
});
