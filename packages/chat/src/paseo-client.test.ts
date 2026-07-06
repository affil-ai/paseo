import { describe, expect, it } from "vitest";
import { resolveChatRepositoryPath } from "./paseo-client.js";

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
