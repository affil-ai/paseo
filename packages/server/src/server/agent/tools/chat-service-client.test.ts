import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { prepareChatOutboundFile } from "./chat-service-client.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-chat-file-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareChatOutboundFile", () => {
  it("reads local files into bytes for bridge upload", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "report.csv");
    await writeFile(filePath, "a,b\n1,2\n", "utf8");

    await expect(prepareChatOutboundFile({ path: filePath, imageOnly: false })).resolves.toEqual({
      bytesBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
      filename: "report.csv",
      mimeType: "text/csv",
      size: 8,
    });
  });

  it("rejects missing files with structured error code", async () => {
    const dir = await createTempDir();

    await expect(
      prepareChatOutboundFile({ path: join(dir, "missing.csv"), imageOnly: false }),
    ).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("rejects non-image files when image-only validation is requested", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "report.csv");
    await writeFile(filePath, "hello", "utf8");

    await expect(
      prepareChatOutboundFile({ path: filePath, imageOnly: true }),
    ).rejects.toMatchObject({ code: "unsupported_file" });
  });

  it("rejects files over the configured upload limit", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "big.txt");
    await writeFile(filePath, "hello", "utf8");

    await expect(
      prepareChatOutboundFile({ path: filePath, imageOnly: false, maxUploadBytes: 4 }),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });
});
