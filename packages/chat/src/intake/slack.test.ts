import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Attachment, Message, Thread } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMessage, parseCommand } from "./slack.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-attachments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseCommand", () => {
  it("treats natural stop and mute phrases as mute commands", () => {
    expect(parseCommand("stop i'm already working on this")).toBe("mute");
    expect(parseCommand("dude shut up mute stop")).toBe("mute");
    expect(parseCommand("please mute this thread")).toBe("mute");
  });

  it("only treats exact /archive as the archive command", () => {
    expect(parseCommand("/archive")).toBe("archive");
    expect(parseCommand(" /archive ")).toBe("archive");
    expect(parseCommand("/ARCHIVE")).toBe("archive");

    expect(parseCommand("done")).toBeNull();
    expect(parseCommand("done?")).toBeNull();
    expect(parseCommand("archive")).toBeNull();
    expect(parseCommand("archive this")).toBeNull();
    expect(parseCommand("/archive now")).toBeNull();
    expect(parseCommand("/archive?")).toBeNull();
  });
});

function mockThread(): Thread {
  return {
    id: "slack:T1:C1:123.456",
    isDM: false,
    adapter: {},
  } as Thread;
}

function mockThreadWithUser(): Thread {
  return {
    ...mockThread(),
    adapter: {
      getUser: async (userId: string) =>
        userId === "U123"
          ? {
              userId: "U123",
              userName: "jane",
              fullName: "Jane Profile",
              avatarUrl: "https://example.com/jane.png",
            }
          : null,
    },
  } as Thread;
}

function mockMessage(attachments: Attachment[], overrides: Partial<Message> = {}): Message {
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
    ...overrides,
  } as Message;
}

describe("normalizeMessage URLs", () => {
  it("resolves sender profile images through the Slack adapter", async () => {
    const attachmentDir = await createTempDir();

    const normalized = await normalizeMessage(mockThreadWithUser(), mockMessage([]), {
      attachmentDir,
    });

    expect(normalized.sender).toEqual({
      userId: "U123",
      name: "Jane Profile",
      handle: "jane",
      avatarUrl: "https://example.com/jane.png",
    });
  });

  it("preserves full URLs from parsed Chat SDK links", async () => {
    const attachmentDir = await createTempDir();

    const normalized = await normalizeMessage(
      mockThread(),
      mockMessage([], {
        text: "facebook.com/p/Aunt-Kara-Mo…",
        raw: { text: "facebook.com/p/Aunt-Kara-Mo…" },
        links: [{ url: "https://www.facebook.com/p/Aunt-Kara-Mo-61512345678901/" }],
      }),
      { attachmentDir },
    );

    expect(normalized.cleanedText).toBe(
      "facebook.com/p/Aunt-Kara-Mo…\n\nLinks:\n- https://www.facebook.com/p/Aunt-Kara-Mo-61512345678901/",
    );
  });

  it("does not duplicate exact URLs already present in message text", async () => {
    const attachmentDir = await createTempDir();
    const url = "https://example.com/full/path?x=1";

    const normalized = await normalizeMessage(
      mockThread(),
      mockMessage([], {
        text: `see ${url}`,
        raw: { text: `see ${url}` },
        links: [{ url }],
      }),
      { attachmentDir },
    );

    expect(normalized.cleanedText).toBe(`see ${url}`);
  });

  it("preserves multiple parsed links in order and dedupes repeats", async () => {
    const attachmentDir = await createTempDir();

    const normalized = await normalizeMessage(
      mockThread(),
      mockMessage([], {
        text: "first and second",
        raw: { text: "first and second" },
        links: [
          { url: "https://example.com/one" },
          { url: "https://example.com/two" },
          { url: "https://example.com/one" },
        ],
      }),
      { attachmentDir },
    );

    expect(normalized.cleanedText).toBe(
      "first and second\n\nLinks:\n- https://example.com/one\n- https://example.com/two",
    );
  });
});

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
