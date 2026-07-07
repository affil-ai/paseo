const CHAT_TOOL_NAME_PATTERN =
  /(?:^|[._-])chat[._-](?:send|ask|startconversation|reply|sendfile|sendimage|askperson|askchannel)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readMessageFromArgs(args: unknown): string | undefined {
  if (typeof args === "string") {
    const parsed = parseJsonRecord(args);
    return parsed ? readMessageFromArgs(parsed) : undefined;
  }
  if (!isRecord(args)) {
    return undefined;
  }

  const directMessage = readString(args.message) ?? readString(args.question);
  if (directMessage) {
    return directMessage;
  }

  const inputMessage = readMessageFromArgs(args.input);
  if (inputMessage) {
    return inputMessage;
  }

  return readMessageFromArgs(args.args);
}

function readRequestedToolName(args: unknown): string | undefined {
  if (typeof args === "string") {
    const parsed = parseJsonRecord(args);
    return parsed ? readRequestedToolName(parsed) : undefined;
  }
  if (!isRecord(args)) {
    return undefined;
  }

  return (
    readString(args.tool) ??
    readString(args.name) ??
    readRequestedToolName(args.input) ??
    readRequestedToolName(args.args)
  );
}

export function isChatDeliveryToolName(toolName: string): boolean {
  return CHAT_TOOL_NAME_PATTERN.test(toolName);
}

export function extractChatToolMessage(params: {
  toolName: string;
  args: unknown;
}): string | undefined {
  const requestedToolName = readRequestedToolName(params.args);
  if (
    !isChatDeliveryToolName(params.toolName) &&
    !isChatDeliveryToolName(requestedToolName ?? "")
  ) {
    return undefined;
  }
  return readMessageFromArgs(params.args);
}
