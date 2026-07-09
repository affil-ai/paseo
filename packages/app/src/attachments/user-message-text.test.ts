import { describe, expect, it } from "vitest";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { stripStructuredAttachmentMetadata } from "./user-message-text";

const imageAttachment: AgentAttachment = {
  type: "uploaded_file",
  id: "slack-image",
  fileName: "image.png",
  mimeType: "image/png",
  size: 64_582,
  path: "/home/paseo/.paseo/chat-bridge/inbound-attachments/slack_abc/image.png",
};

describe("stripStructuredAttachmentMetadata", () => {
  it("removes generated uploaded-file metadata already represented by an attachment card", () => {
    const message = [
      "REMINDER: This came from Slack.",
      "",
      "Vivek Olumbe (@vivek): don't commit to memory.",
      "",
      "Uploaded file: image.png",
      "Path: /home/paseo/.paseo/chat-bridge/inbound-attachments/slack_abc/image.png",
      "MIME: image/png",
      "Size: 64582 bytes",
    ].join("\n");

    expect(stripStructuredAttachmentMetadata(message, [imageAttachment])).toBe(
      "REMINDER: This came from Slack.\n\nVivek Olumbe (@vivek): don't commit to memory.",
    );
  });

  it("leaves ordinary message text unchanged", () => {
    expect(stripStructuredAttachmentMetadata("Please inspect the attached image.", [])).toBe(
      "Please inspect the attached image.",
    );
  });

  it("does not remove metadata-like text unless it exactly matches a structured attachment", () => {
    const message = [
      "Uploaded file: image.png",
      "Path: /some/other/path/image.png",
      "MIME: image/png",
      "Size: 64582 bytes",
    ].join("\n");

    expect(stripStructuredAttachmentMetadata(message, [imageAttachment])).toBe(message);
  });

  it("removes every matching generated block from a multi-file suffix", () => {
    const textAttachment: AgentAttachment = {
      type: "uploaded_file",
      id: "slack-text",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 12,
      path: "/tmp/notes.txt",
    };
    const message = [
      "Please review both files.",
      "",
      "Uploaded file: image.png",
      `Path: ${imageAttachment.path}`,
      "MIME: image/png",
      "Size: 64582 bytes",
      "",
      "Uploaded file: notes.txt",
      "Path: /tmp/notes.txt",
      "MIME: text/plain",
      "Size: 12 bytes",
    ].join("\n");

    expect(stripStructuredAttachmentMetadata(message, [imageAttachment, textAttachment])).toBe(
      "Please review both files.",
    );
  });
});
