import { describe, expect, it } from "vitest";

import { registerChatTools } from "./chat-tools.js";

describe("registerChatTools", () => {
  it("exposes the simplified chat tools", () => {
    const toolNames: string[] = [];

    registerChatTools(
      (name) => {
        toolNames.push(name);
      },
      { callerAgentId: "agent-office" },
    );

    expect(toolNames).toEqual(["chat.send", "chat.ask", "chat.addReaction"]);
  });
});
