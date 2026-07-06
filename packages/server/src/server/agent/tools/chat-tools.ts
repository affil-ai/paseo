import { z } from "zod";
import { ensureValidJson } from "../../json-utils.js";
import { resolvePathFromBase } from "../../path-utils.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";
import {
  chatIdempotencyKey,
  ChatServiceClient,
  ChatToolError,
  ChatToolResultSchema,
  prepareChatOutboundFile,
} from "./chat-service-client.js";

interface RegisterChatToolDependencies {
  callerAgentId?: string;
  resolveCallerCwd?: () => string | undefined;
  paseoHome?: string;
}

type RegisterTool = <Input>(
  name: string,
  config: PaseoToolConfig,
  handler: (input: Input, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
) => void;

const MessageSchema = z.string().min(1).max(40_000);
const ConversationIdSchema = z.string().min(1).optional();
const PersonDestinationSchema = z.object({ kind: z.literal("person"), key: z.string().min(1) });
const ChannelDestinationSchema = z.object({
  kind: z.literal("channel"),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
});
const StartDestinationSchema = z.discriminatedUnion("kind", [
  PersonDestinationSchema,
  ChannelDestinationSchema,
  z.object({ kind: z.literal("conversation"), conversationId: z.string().min(1) }),
]);

const StartConversationInputSchema = z.object({
  destination: StartDestinationSchema,
  message: MessageSchema,
  subscribe: z.boolean().default(true),
});

const ReplyInputSchema = z.object({
  conversationId: ConversationIdSchema,
  message: MessageSchema,
});

const SendFileInputSchema = z.object({
  conversationId: ConversationIdSchema,
  path: z.string().min(1),
  filename: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  message: z.string().optional(),
});

const AskInputSchema = z.object({
  destination: StartDestinationSchema,
  question: MessageSchema,
  timeoutMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .default(60),
});

function requireCallerAgentId(callerAgentId: string | undefined): string {
  if (!callerAgentId) {
    throw new ChatToolError("agent_scoped_only", "chat.* tools are only available to agents.");
  }
  return callerAgentId;
}

function textResult(result: unknown, message: string, isError = false): PaseoToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: ensureValidJson(result),
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown): PaseoToolResult {
  const chatError =
    error instanceof ChatToolError
      ? error
      : new ChatToolError(
          "chat_tool_failed",
          error instanceof Error ? error.message : String(error),
        );
  return textResult(
    { error: { code: chatError.code, message: chatError.message, details: chatError.details } },
    `${chatError.code}: ${chatError.message}`,
    true,
  );
}

function resolveToolPath(inputPath: string, callerCwd: string | undefined): string {
  if (!callerCwd) return inputPath;
  return resolvePathFromBase(callerCwd, inputPath);
}

export function registerChatTools(
  registerTool: RegisterTool,
  deps: RegisterChatToolDependencies,
): void {
  const client = new ChatServiceClient({ paseoHome: deps.paseoHome });

  registerTool(
    "chat.startConversation",
    {
      title: "Start chat conversation",
      description:
        "Explicitly start a Slack/Chat SDK conversation as the current office agent. This posts through Paseo's chat bridge, subscribes to replies, and never creates a new agent.",
      inputSchema: StartConversationInputSchema,
      outputSchema: ChatToolResultSchema.shape,
    },
    async (input: z.infer<typeof StartConversationInputSchema>) => {
      const { destination, message, subscribe } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const result = await client.call("startConversation", {
          officeAgentId,
          destination,
          message,
          subscribe,
          idempotencyKey: chatIdempotencyKey("chat.startConversation", officeAgentId),
        });
        return textResult(result, `Posted chat conversation ${result.conversationId}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.reply",
    {
      title: "Reply to chat",
      description:
        "Reply to the current/default chat binding or a supplied conversationId through the chat bridge. Returns no_current_binding or ambiguous_current_binding when the target is unclear.",
      inputSchema: ReplyInputSchema,
      outputSchema: ChatToolResultSchema.shape,
    },
    async (input: z.infer<typeof ReplyInputSchema>) => {
      const { conversationId, message } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const result = await client.call("reply", {
          officeAgentId,
          conversationId,
          message,
          idempotencyKey: chatIdempotencyKey("chat.reply", officeAgentId),
        });
        return textResult(result, `Posted reply to ${result.conversationId}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.sendFile",
    {
      title: "Send chat file",
      description:
        "Explicitly upload a local file to the current/default chat binding or supplied conversationId through Chat SDK. Use this for generated CSVs, PDFs, reports, and other artifacts.",
      inputSchema: SendFileInputSchema,
      outputSchema: ChatToolResultSchema.shape,
    },
    async (input: z.infer<typeof SendFileInputSchema>) => {
      const { conversationId, path, filename, mimeType, message } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const file = await prepareChatOutboundFile({
          path: resolveToolPath(path, deps.resolveCallerCwd?.()),
          filename,
          mimeType,
          imageOnly: false,
        });
        const result = await client.call("sendFile", {
          officeAgentId,
          conversationId,
          message,
          file,
          idempotencyKey: chatIdempotencyKey("chat.sendFile", officeAgentId),
        });
        return textResult(result, `Uploaded ${file.filename} to ${result.conversationId}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.sendImage",
    {
      title: "Send chat image",
      description:
        "Explicitly upload a local image to the current/default chat binding or supplied conversationId through Chat SDK. Use this for generated charts and screenshots.",
      inputSchema: SendFileInputSchema.omit({ mimeType: true }).extend({
        mimeType: z.never().optional(),
      }),
      outputSchema: ChatToolResultSchema.shape,
    },
    async (input: z.infer<typeof SendFileInputSchema>) => {
      const { conversationId, path, filename, message } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const file = await prepareChatOutboundFile({
          path: resolveToolPath(path, deps.resolveCallerCwd?.()),
          filename,
          imageOnly: true,
        });
        const result = await client.call("sendFile", {
          officeAgentId,
          conversationId,
          message,
          file,
          idempotencyKey: chatIdempotencyKey("chat.sendImage", officeAgentId),
        });
        return textResult(result, `Uploaded ${file.filename} to ${result.conversationId}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.askPerson",
    {
      title: "Ask person in chat",
      description:
        "Ask a person a question through chat. This returns a pending request id; when the person replies, the bridge sends the answer back to this same office agent.",
      inputSchema: AskInputSchema.extend({
        destination: PersonDestinationSchema,
      }),
      outputSchema: ChatToolResultSchema.shape,
    },
    async (input: z.infer<typeof AskInputSchema>) => {
      const { destination, question, timeoutMinutes } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const result = await client.call("ask", {
          officeAgentId,
          destination,
          question,
          timeoutMinutes,
          scope: "person",
          idempotencyKey: chatIdempotencyKey("chat.askPerson", officeAgentId),
        });
        return textResult(result, `Posted question ${result.requestId}; waiting for chat reply.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.askChannel",
    {
      title: "Ask channel in chat",
      description:
        "Ask a channel a question through chat. This returns a pending request id; the first reply in the subscribed thread is sent back to this same office agent.",
      inputSchema: AskInputSchema.extend({
        destination: ChannelDestinationSchema,
      }),
      outputSchema: ChatToolResultSchema.shape,
    },
    async (input: z.infer<typeof AskInputSchema>) => {
      const { destination, question, timeoutMinutes } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const result = await client.call("ask", {
          officeAgentId,
          destination,
          question,
          timeoutMinutes,
          scope: "channel",
          idempotencyKey: chatIdempotencyKey("chat.askChannel", officeAgentId),
        });
        return textResult(result, `Posted question ${result.requestId}; waiting for chat reply.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
