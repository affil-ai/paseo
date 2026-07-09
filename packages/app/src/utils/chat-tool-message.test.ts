import { describe, expect, it } from "vitest";

import {
  extractChatToolDelivery,
  extractChatToolMessage,
  isChatDeliveryToolName,
} from "./chat-tool-message";

describe("chat-tool-message", () => {
  it("recognizes chat delivery tool name variants", () => {
    expect(isChatDeliveryToolName("chat.send")).toBe(true);
    expect(isChatDeliveryToolName("paseo_chat.send")).toBe(true);
    expect(isChatDeliveryToolName("paseo.chat.ask")).toBe(true);
    expect(isChatDeliveryToolName("paseo_chat.reply")).toBe(true);
    expect(isChatDeliveryToolName("bash")).toBe(false);
  });

  it("extracts the visible message from direct chat tool args", () => {
    expect(
      extractChatToolMessage({
        toolName: "paseo_chat.send",
        args: { destination: { kind: "current" }, message: "Done — shipped the PR." },
      }),
    ).toBe("Done — shipped the PR.");
  });

  it("extracts the visible message from MCP-style nested JSON args", () => {
    expect(
      extractChatToolMessage({
        toolName: "paseo_chat.send",
        args: {
          server: "paseo",
          tool: "paseo_chat.send",
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
          tool: "paseo_chat.send",
          args: { message: "Wrapper call reply text." },
        },
      }),
    ).toBe("Wrapper call reply text.");
  });

  it("extracts the visible question from chat.ask args", () => {
    expect(
      extractChatToolMessage({
        toolName: "paseo_chat.ask",
        args: { question: "Can you confirm?" },
      }),
    ).toBe("Can you confirm?");
  });

  it("does not extract messages from non-chat tools", () => {
    expect(
      extractChatToolMessage({
        toolName: "bash",
        args: { message: "echo should not render as chat text" },
      }),
    ).toBeUndefined();
  });

  it("extracts files from chat.send using explicit and path-derived names", () => {
    expect(
      extractChatToolDelivery({
        toolName: "chat.send",
        args: {
          message: "Artifacts attached",
          files: [
            { path: "/tmp/report.pdf", mimeType: "application/pdf" },
            { path: "screenshots/final.png", filename: "result.png", mimeType: "image/png" },
          ],
        },
      }),
    ).toEqual({
      message: "Artifacts attached",
      files: [
        {
          path: "/tmp/report.pdf",
          filename: "report.pdf",
          mimeType: "application/pdf",
        },
        {
          path: "screenshots/final.png",
          filename: "result.png",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("extracts file-only deliveries from nested MCP args", () => {
    expect(
      extractChatToolDelivery({
        toolName: "mcp",
        args: {
          tool: "paseo_chat.send",
          args: JSON.stringify({ files: [{ path: "out/chart.png" }] }),
        },
      }),
    ).toEqual({
      message: undefined,
      files: [{ path: "out/chart.png", filename: "chart.png", mimeType: undefined }],
    });
  });
});
