import { describe, expect, it } from "vitest";

import { registerChatTools } from "./chat-tools.js";

describe("registerChatTools", () => {
  it("exposes only the simplified chat.send and chat.ask tools", () => {
    const toolNames: string[] = [];

    registerChatTools(
      (name) => {
        toolNames.push(name);
      },
      { callerAgentId: "agent-office" },
    );

    expect(toolNames).toEqual(["chat.send", "chat.ask"]);
  });
});
