import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const ChatDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("person"), key: z.string().min(1) }),
  z.object({
    kind: z.literal("channel"),
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("conversation"), conversationId: z.string().min(1) }),
]);

export const ChatToolResultSchema = z.object({
  conversationId: z.string(),
  externalThreadId: z.string(),
  requestId: z.string().optional(),
  status: z.literal("pending").optional(),
  fileId: z.string().optional(),
  reactionName: z.string().optional(),
});

export const ChatToolOutputSchema = z.object({
  conversationId: z.string().optional(),
  externalThreadId: z.string().optional(),
  requestId: z.string().optional(),
  status: z.literal("pending").optional(),
  fileId: z.string().optional(),
  reactionName: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type ChatDestination = z.infer<typeof ChatDestinationSchema>;
export type ChatToolResult = z.infer<typeof ChatToolResultSchema>;

export class ChatToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ChatOutboundFilePayload {
  bytesBase64: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ChatServiceClientOptions {
  paseoHome?: string;
  serviceHost?: string;
  servicePort?: number;
  maxUploadBytes?: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function resolveHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolvePaseoHome(options: ChatServiceClientOptions): string {
  return path.resolve(
    resolveHome(process.env.PASEO_HOME?.trim() || options.paseoHome || "~/.paseo"),
  );
}

function resolveStateDir(options: ChatServiceClientOptions): string {
  return path.resolve(
    resolveHome(
      process.env.PASEO_CHAT_STATE_DIR ?? path.join(resolvePaseoHome(options), "chat-bridge"),
    ),
  );
}

function serviceTokenPath(options: ChatServiceClientOptions): string {
  return path.join(resolveStateDir(options), "service-token");
}

function serviceUrl(options: ChatServiceClientOptions): string {
  const host = process.env.PASEO_CHAT_SERVICE_HOST ?? options.serviceHost ?? "127.0.0.1";
  const port = Number(process.env.PASEO_CHAT_SERVICE_PORT ?? options.servicePort ?? 8788);
  return `http://${host}:${port}/chat-bridge/rpc`;
}

export function inferMimeType(filename: string, supplied?: string): string {
  const explicit = supplied?.trim();
  if (explicit) return explicit;
  const ext = path.extname(filename).toLowerCase();
  const byExtension: Record<string, string> = {
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
  };
  return byExtension[ext] ?? "application/octet-stream";
}

export async function prepareChatOutboundFile(input: {
  path: string;
  filename?: string;
  mimeType?: string;
  imageOnly: boolean;
  maxUploadBytes?: number;
}): Promise<ChatOutboundFilePayload> {
  const absolutePath = path.resolve(resolveHome(input.path));
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ChatToolError("file_not_found", `File not found: ${absolutePath}`);
    }
    throw new ChatToolError("file_not_readable", `File is not readable: ${absolutePath}`);
  }
  if (!fileStat.isFile()) {
    throw new ChatToolError("unsupported_file", `Path is not a regular file: ${absolutePath}`);
  }
  const maxBytes = input.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (fileStat.size > maxBytes) {
    throw new ChatToolError("file_too_large", `File exceeds ${maxBytes} bytes.`, {
      size: fileStat.size,
      maxBytes,
    });
  }
  const filename = path.basename(input.filename?.trim() || absolutePath);
  const mimeType = inferMimeType(filename, input.mimeType);
  if (input.imageOnly && !mimeType.startsWith("image/")) {
    throw new ChatToolError("unsupported_file", "This chat upload only accepts image MIME types.", {
      mimeType,
    });
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    throw new ChatToolError("file_not_readable", `File is not readable: ${absolutePath}`);
  }
  return {
    bytesBase64: bytes.toString("base64"),
    filename,
    mimeType,
    size: bytes.byteLength,
  };
}

export class ChatServiceClient {
  constructor(private readonly options: ChatServiceClientOptions = {}) {}

  async call(
    method: "send" | "startConversation" | "reply" | "sendFile" | "ask" | "addReaction",
    input: unknown,
  ): Promise<ChatToolResult> {
    let token: string;
    try {
      token = (await readFile(serviceTokenPath(this.options), "utf8")).trim();
    } catch {
      throw new ChatToolError("bridge_unavailable", "Chat bridge is not connected.");
    }
    let response: Response;
    try {
      response = await fetch(serviceUrl(this.options), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, input }),
      });
    } catch {
      throw new ChatToolError("bridge_unavailable", "Chat bridge is not connected.");
    }
    const raw = await response.json().catch(() => null);
    if (!response.ok || !raw || typeof raw !== "object") {
      throw new ChatToolError("bridge_unavailable", "Chat bridge returned an invalid response.");
    }
    const body = raw as { ok?: unknown; payload?: unknown; error?: unknown };
    if (body.ok !== true) {
      const error = body.error as
        | { code?: unknown; message?: unknown; details?: unknown }
        | undefined;
      throw new ChatToolError(
        typeof error?.code === "string" ? error.code : "chat_tool_failed",
        typeof error?.message === "string" ? error.message : "Chat tool failed.",
        error?.details && typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : {},
      );
    }
    return ChatToolResultSchema.parse(body.payload);
  }
}

export function chatIdempotencyKey(toolName: string, officeAgentId: string): string {
  return `${toolName}:${officeAgentId}:${randomUUID()}`;
}
