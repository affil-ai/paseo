import { describe, expect, it } from "vitest";

import { getChatToolFilePreviewKind } from "./chat-tool-file-preview";

describe("getChatToolFilePreviewKind", () => {
  it("recognizes images and videos from MIME types", () => {
    expect(getChatToolFilePreviewKind({ filename: "asset", mimeType: "image/png" })).toBe("image");
    expect(getChatToolFilePreviewKind({ filename: "asset", mimeType: "video/mp4" })).toBe("video");
  });

  it("falls back to common media file extensions", () => {
    expect(getChatToolFilePreviewKind({ filename: "preview.WEBP" })).toBe("image");
    expect(getChatToolFilePreviewKind({ filename: "preview.MOV" })).toBe("video");
    expect(getChatToolFilePreviewKind({ filename: "report.pdf" })).toBe("file");
  });
});
