import { describe, expect, it } from "vitest";

import { extractChatToolMessage, isChatDeliveryToolName } from "./chat-tool-message";

describe("chat-tool-message", () => {
  it("recognizes chat delivery tool name variants", () => {
    expect(isChatDeliveryToolName("chat.reply")).toBe(true);
    expect(isChatDeliveryToolName("paseo_chat.reply")).toBe(true);
    expect(isChatDeliveryToolName("paseo_chat_sendFile")).toBe(true);
    expect(isChatDeliveryToolName("paseo.chat.sendImage")).toBe(true);
    expect(isChatDeliveryToolName("bash")).toBe(false);
  });

  it("extracts the visible message from direct chat tool args", () => {
    expect(
      extractChatToolMessage({
        toolName: "paseo_chat.reply",
        args: { conversationId: "c1", message: "Done — shipped the PR." },
      }),
    ).toBe("Done — shipped the PR.");
  });

  it("extracts the visible message from MCP-style nested JSON args", () => {
    expect(
      extractChatToolMessage({
        toolName: "paseo_chat.reply",
        args: {
          server: "paseo",
          tool: "paseo_chat.reply",
          args: JSON.stringify({ message: "Here is the final Slack reply." }),
        },
      }),
    ).toBe("Here is the final Slack reply.");
  });

  it("uses the nested requested tool name for wrapper calls", () => {
    expect(
      extractChatToolMessage({
        toolName: "mcp",
        args: {
          server: "paseo",
          tool: "paseo_chat.reply",
          args: { message: "Wrapper call reply text." },
        },
      }),
    ).toBe("Wrapper call reply text.");
  });

  it("does not extract messages from non-chat tools", () => {
    expect(
      extractChatToolMessage({
        toolName: "bash",
        args: { message: "echo should not render as chat text" },
      }),
    ).toBeUndefined();
  });
});
