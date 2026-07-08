import { z } from "zod";
import { ensureValidJson } from "../../json-utils.js";
import { resolvePathFromBase } from "../../path-utils.js";
import type { PaseoToolConfig, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";
import {
  chatIdempotencyKey,
  ChatDestinationSchema,
  ChatServiceClient,
  ChatToolError,
  ChatToolOutputSchema,
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
const ChatFileInputSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
});

const SendInputSchema = z
  .object({
    destination: ChatDestinationSchema.optional(),
    message: MessageSchema.optional(),
    files: z.array(ChatFileInputSchema).min(1).optional(),
    subscribe: z.boolean().default(true),
  })
  .superRefine((input, context) => {
    if (!input.message && !input.files?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "chat.send requires either message or files.",
        path: ["message"],
      });
    }
  });

const AskInputSchema = z.object({
  destination: ChatDestinationSchema.optional(),
  question: MessageSchema,
  timeoutMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .default(60),
});

const AddReactionInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
  name: z.string().min(1).max(80).default("check"),
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

function sendResultMessage(result: { conversationId?: string; requestId?: string }): string {
  if (result.requestId) {
    return `Posted question ${result.requestId}; waiting for chat reply.`;
  }
  return result.conversationId
    ? `Sent chat message to ${result.conversationId}.`
    : "Sent chat message.";
}

function reactionResultMessage(result: { conversationId?: string; reactionName?: string }): string {
  return `Added ${result.reactionName ?? "check"} reaction${
    result.conversationId ? ` to ${result.conversationId}` : ""
  }.`;
}

export function registerChatTools(
  registerTool: RegisterTool,
  deps: RegisterChatToolDependencies,
): void {
  const client = new ChatServiceClient({ paseoHome: deps.paseoHome });

  registerTool(
    "chat.send",
    {
      title: "Send chat message",
      description:
        "Send text and/or files through the current/default Slack binding or to a person, channel, or conversation. No destination means the current/default binding. Person/channel destinations create or reuse a conversation/thread as needed. Valid when either message or files is present.",
      inputSchema: SendInputSchema,
      outputSchema: ChatToolOutputSchema.shape,
    },
    async (input: z.infer<typeof SendInputSchema>) => {
      const { destination, message, files, subscribe } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const preparedFiles = await Promise.all(
          (files ?? []).map((file) =>
            prepareChatOutboundFile({
              path: resolveToolPath(file.path, deps.resolveCallerCwd?.()),
              filename: file.filename,
              mimeType: file.mimeType,
              imageOnly: false,
            }),
          ),
        );
        const result = await client.call("send", {
          officeAgentId,
          destination,
          message,
          files: preparedFiles,
          subscribe,
          idempotencyKey: chatIdempotencyKey("chat.send", officeAgentId),
        });
        return textResult(result, sendResultMessage(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.ask",
    {
      title: "Ask in chat",
      description:
        "Ask a person, channel, conversation, or the current/default Slack binding a question through chat. No destination means the current/default binding. The bridge routes the reply back to this same office agent.",
      inputSchema: AskInputSchema,
      outputSchema: ChatToolOutputSchema.shape,
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
          idempotencyKey: chatIdempotencyKey("chat.ask", officeAgentId),
        });
        return textResult(result, sendResultMessage(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "chat.addReaction",
    {
      title: "Add chat reaction",
      description:
        'Add an emoji reaction to the initial/root message of the current Slack thread or a specific chat conversation. Use name "check" (default) to add a checkmark when the work is complete.',
      inputSchema: AddReactionInputSchema,
      outputSchema: ChatToolOutputSchema.shape,
    },
    async (input: z.infer<typeof AddReactionInputSchema>) => {
      const { conversationId, name } = input;
      try {
        const officeAgentId = requireCallerAgentId(deps.callerAgentId);
        const result = await client.call("addReaction", {
          officeAgentId,
          conversationId,
          name,
          idempotencyKey: chatIdempotencyKey("chat.addReaction", officeAgentId),
        });
        return textResult(result, reactionResultMessage(result));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
