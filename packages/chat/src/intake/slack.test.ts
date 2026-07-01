import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Attachment, Message, Thread } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMessage } from "./slack.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-attachments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function mockThread(): Thread {
  return {
    id: "slack:T1:C1:123.456",
    isDM: false,
    adapter: {},
  } as Thread;
}

function mockMessage(attachments: Attachment[]): Message {
  return {
    id: "123.456",
    text: "please inspect this",
    raw: { text: "please inspect this" },
    author: {
      userId: "U123",
      userName: "jane",
      fullName: "Jane Doe",
      isBot: false,
      isMe: false,
    },
    attachments,
  } as Message;
}

describe("normalizeMessage attachments", () => {
  it("converts image attachment data into daemon image payloads", async () => {
    const attachmentDir = await createTempDir();
    const bytes = Buffer.from("image bytes");

    const normalized = await normalizeMessage(
      mockThread(),
      mockMessage([
        {
          type: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          data: new Blob([bytes]),
        } as Attachment,
      ]),
      { attachmentDir },
    );

    expect(normalized.images).toEqual([{ data: bytes.toString("base64"), mimeType: "image/png" }]);
    expect(normalized.attachments).toHaveLength(1);
    const [attachment] = normalized.attachments;
    expect(attachment).toMatchObject({
      type: "uploaded_file",
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: bytes.byteLength,
    });
    expect(attachment?.type === "uploaded_file" ? await readFile(attachment.path) : null).toEqual(
      bytes,
    );
  });

  it("writes non-image attachments to disk and sends uploaded_file attachments", async () => {
    const attachmentDir = await createTempDir();
    const bytes = Buffer.from("hello from slack");

    const normalized = await normalizeMessage(
      mockThread(),
      mockMessage([
        {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          size: bytes.byteLength,
          fetchData: async () => bytes,
        } as Attachment,
      ]),
      { attachmentDir },
    );

    expect(normalized.images).toEqual([]);
    expect(normalized.attachments).toHaveLength(1);
    const [attachment] = normalized.attachments;
    expect(attachment).toMatchObject({
      type: "uploaded_file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: bytes.byteLength,
    });
    expect(
      attachment?.type === "uploaded_file" ? await readFile(attachment.path, "utf8") : null,
    ).toBe("hello from slack");
  });

  it("keeps unfetchable attachments as prompt text links", async () => {
    const attachmentDir = await createTempDir();

    const normalized = await normalizeMessage(
      mockThread(),
      mockMessage([
        {
          type: "file",
          name: "remote.pdf",
          mimeType: "application/pdf",
          url: "https://example.com/remote.pdf",
        } as Attachment,
      ]),
      { attachmentDir },
    );

    expect(normalized.attachments).toEqual([]);
    expect(normalized.cleanedText).toContain(
      "Attachments:\n- remote.pdf (application/pdf): https://example.com/remote.pdf",
    );
  });
});
