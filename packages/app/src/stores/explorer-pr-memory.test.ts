import { describe, expect, it } from "vitest";
import {
  buildExplorerPrCandidates,
  isPrIdentityKeyValue,
  prIdentityKeyForSelectedCwd,
  resolvePersistedPrSelection,
  type ExplorerPrByCheckout,
} from "./explorer-pr-memory";
import { buildExplorerCheckoutKey } from "./explorer-tab-memory";

const SERVER_ID = "server-1";
const WORKSPACE_CWD = "/repo/main";

function keyFor(cwd: string): string {
  return buildExplorerCheckoutKey(SERVER_ID, cwd)!;
}

describe("isPrIdentityKeyValue", () => {
  it("accepts non-empty strings only", () => {
    expect(isPrIdentityKeyValue("acme/app#42")).toBe(true);
    expect(isPrIdentityKeyValue("")).toBe(false);
    expect(isPrIdentityKeyValue(null)).toBe(false);
    expect(isPrIdentityKeyValue(42)).toBe(false);
  });
});

describe("buildExplorerPrCandidates", () => {
  it("maps the workspace's own PR to the workspace cwd and includes subagent PRs", () => {
    const candidates = buildExplorerPrCandidates({
      workspacePr: { prNumber: 1947, repoOwner: "acme", repoName: "app" },
      workspaceCwd: WORKSPACE_CWD,
      subagentPrs: [
        { prNumber: 1942, repoOwner: "acme", repoName: "app", cwd: "/repo/wt-a" },
        { prNumber: 1950, repoOwner: "acme", repoName: "app", cwd: "/repo/wt-b" },
      ],
    });
    expect(candidates).toEqual([
      { identityKey: "acme/app#1947", cwd: WORKSPACE_CWD },
      { identityKey: "acme/app#1942", cwd: "/repo/wt-a" },
      { identityKey: "acme/app#1950", cwd: "/repo/wt-b" },
    ]);
  });

  it("omits the workspace own candidate when there is no workspace PR", () => {
    const candidates = buildExplorerPrCandidates({
      workspacePr: null,
      workspaceCwd: WORKSPACE_CWD,
      subagentPrs: [{ prNumber: 1942, repoOwner: "acme", repoName: "app", cwd: "/repo/wt-a" }],
    });
    expect(candidates).toEqual([{ identityKey: "acme/app#1942", cwd: "/repo/wt-a" }]);
  });
});

describe("resolvePersistedPrSelection", () => {
  const candidates = [
    { identityKey: "acme/app#1947", cwd: WORKSPACE_CWD },
    { identityKey: "acme/app#1942", cwd: "/repo/wt-a" },
  ];

  it("returns null when there is no persisted entry (no restore)", () => {
    expect(
      resolvePersistedPrSelection({
        serverId: SERVER_ID,
        workspaceCwd: WORKSPACE_CWD,
        explorerPrByCheckout: {},
        candidates,
      }),
    ).toBeNull();
  });

  it("restores the workspace's own PR when persisted null", () => {
    const explorerPrByCheckout: ExplorerPrByCheckout = { [keyFor(WORKSPACE_CWD)]: null };
    expect(
      resolvePersistedPrSelection({
        serverId: SERVER_ID,
        workspaceCwd: WORKSPACE_CWD,
        explorerPrByCheckout,
        candidates,
      }),
    ).toEqual({ prCwd: WORKSPACE_CWD, isWorkspaceOwnPr: true });
  });

  it("restores a subagent PR when its identity still matches a live candidate", () => {
    const explorerPrByCheckout: ExplorerPrByCheckout = {
      [keyFor(WORKSPACE_CWD)]: "acme/app#1942",
    };
    expect(
      resolvePersistedPrSelection({
        serverId: SERVER_ID,
        workspaceCwd: WORKSPACE_CWD,
        explorerPrByCheckout,
        candidates,
      }),
    ).toEqual({ prCwd: "/repo/wt-a", isWorkspaceOwnPr: false });
  });

  it("falls back to the workspace's own PR when the persisted PR is gone", () => {
    const explorerPrByCheckout: ExplorerPrByCheckout = {
      [keyFor(WORKSPACE_CWD)]: "acme/app#9999",
    };
    expect(
      resolvePersistedPrSelection({
        serverId: SERVER_ID,
        workspaceCwd: WORKSPACE_CWD,
        explorerPrByCheckout,
        candidates,
      }),
    ).toEqual({ prCwd: WORKSPACE_CWD, isWorkspaceOwnPr: true });
  });

  it("treats a persisted own-PR identity as the workspace's own PR", () => {
    const explorerPrByCheckout: ExplorerPrByCheckout = {
      [keyFor(WORKSPACE_CWD)]: "acme/app#1947",
    };
    expect(
      resolvePersistedPrSelection({
        serverId: SERVER_ID,
        workspaceCwd: WORKSPACE_CWD,
        explorerPrByCheckout,
        candidates,
      }),
    ).toEqual({ prCwd: WORKSPACE_CWD, isWorkspaceOwnPr: true });
  });
});

describe("prIdentityKeyForSelectedCwd", () => {
  const candidates = [
    { identityKey: "acme/app#1947", cwd: WORKSPACE_CWD },
    { identityKey: "acme/app#1942", cwd: "/repo/wt-a" },
  ];

  it("returns null for the workspace's own PR (null or workspace cwd)", () => {
    expect(
      prIdentityKeyForSelectedCwd({ prCwd: null, workspaceCwd: WORKSPACE_CWD, candidates }),
    ).toBeNull();
    expect(
      prIdentityKeyForSelectedCwd({
        prCwd: WORKSPACE_CWD,
        workspaceCwd: WORKSPACE_CWD,
        candidates,
      }),
    ).toBeNull();
  });

  it("maps a subagent cwd to its stable PR identity", () => {
    expect(
      prIdentityKeyForSelectedCwd({
        prCwd: "/repo/wt-a",
        workspaceCwd: WORKSPACE_CWD,
        candidates,
      }),
    ).toBe("acme/app#1942");
  });

  it("returns null when the selected cwd has no matching candidate", () => {
    expect(
      prIdentityKeyForSelectedCwd({
        prCwd: "/repo/unknown",
        workspaceCwd: WORKSPACE_CWD,
        candidates,
      }),
    ).toBeNull();
  });
});
