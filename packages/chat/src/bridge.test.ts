import { describe, expect, it } from "vitest";
import { buildStartedCardUrl } from "./bridge.js";

describe("buildStartedCardUrl", () => {
  it("links directly to the workspace route with an agent open intent", () => {
    expect(
      buildStartedCardUrl({
        baseUrl: "https://affil.olumbe.com/",
        serverId: "srv_iZJtVKHVcWXG",
        workspaceId: "wks_8194146bcb474423",
        agentId: "agt_123",
      }),
    ).toBe(
      "https://affil.olumbe.com/h/srv_iZJtVKHVcWXG/workspace/wks_8194146bcb474423?open=agent%3Aagt_123",
    );
  });

  it("base64url-encodes path-shaped workspace ids like the app route helper", () => {
    expect(
      buildStartedCardUrl({
        baseUrl: "https://paseo.example",
        serverId: "server/one",
        workspaceId: "/home/user/project",
        agentId: "agent:one",
      }),
    ).toBe(
      "https://paseo.example/h/server%2Fone/workspace/b64_L2hvbWUvdXNlci9wcm9qZWN0?open=agent%3Aagent%3Aone",
    );
  });
});
