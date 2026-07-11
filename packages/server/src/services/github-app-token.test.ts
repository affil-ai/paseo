import { describe, expect, it } from "vitest";
import { getConfiguredGitHubAppToken } from "./github-app-token.js";

describe("getConfiguredGitHubAppToken", () => {
  it("allows GitHub App authentication to remain disabled", async () => {
    await expect(getConfiguredGitHubAppToken({})).resolves.toBeNull();
  });

  it.each([
    { PASEO_GITHUB_APP_TOKEN_URL: "https://gateway.example.test/token" },
    { PASEO_GITHUB_APP_TOKEN_SECRET: "shared-secret" },
  ])("fails closed for incomplete broker configuration", async (env) => {
    await expect(getConfiguredGitHubAppToken(env)).rejects.toThrow(
      "GitHub App token broker configuration is incomplete",
    );
  });
});
