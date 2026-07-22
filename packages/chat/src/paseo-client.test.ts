import { beforeEach, describe, expect, it, vi } from "vitest";
import chatPackageJson from "../package.json" with { type: "json" };

interface CapturedDaemonClientConfig {
  appVersion?: string;
}

const daemonClientState = vi.hoisted(() => ({
  configs: [] as CapturedDaemonClientConfig[],
}));

vi.mock("@getpaseo/client/internal/daemon-client", () => ({
  DaemonClient: class {
    constructor(config: CapturedDaemonClientConfig) {
      daemonClientState.configs.push(config);
    }

    async connect() {}
  },
}));

import { connectToPaseoDaemon, resolveChatRepositoryPath } from "./paseo-client.js";

beforeEach(() => {
  daemonClientState.configs.length = 0;
});

describe("connectToPaseoDaemon", () => {
  it("advertises the chat package version to the daemon", async () => {
    await connectToPaseoDaemon({ daemonHost: "localhost:6767" });

    expect(daemonClientState.configs).toHaveLength(1);
    expect(daemonClientState.configs[0]?.appVersion).toBe(chatPackageJson.version);
  });
});

describe("resolveChatRepositoryPath", () => {
  it("uses the configured project repo root before scanning legacy workspaces", async () => {
    const client = {
      fetchWorkspaces: async () => {
        throw new Error("should not fetch workspaces");
      },
    };

    await expect(
      resolveChatRepositoryPath(client as never, { projectRootPath: "/workspace/paseo" }),
    ).resolves.toBe("/workspace/paseo");
  });

  it("uses the selected project's repo root instead of the selected workspace directory", async () => {
    const client = {
      fetchWorkspaces: async () => ({
        entries: [
          {
            chatRepository: true,
            projectRootPath: "/workspace/paseo",
            workspaceDirectory: "/workspace/paseo/.paseo/worktrees/office-chat-123",
          },
        ],
        pageInfo: { nextCursor: null },
      }),
    };

    await expect(resolveChatRepositoryPath(client as never)).resolves.toBe("/workspace/paseo");
  });

  it("falls back to the workspace directory for older daemon descriptors", async () => {
    const client = {
      fetchWorkspaces: async () => ({
        entries: [
          {
            chatRepository: true,
            projectRootPath: "",
            workspaceDirectory: "/workspace/paseo",
          },
        ],
        pageInfo: { nextCursor: null },
      }),
    };

    await expect(resolveChatRepositoryPath(client as never)).resolves.toBe("/workspace/paseo");
  });
});
