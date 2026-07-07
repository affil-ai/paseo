import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChatEmailClassifierConfig } from "../config.js";
import {
  emailBody,
  stripQuotedEmailChain,
  truncateText,
  type ResendReceivedEmail,
} from "./email-resend.js";

const DEFAULT_PI_COMMAND = "pi";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 60_000;
const CLASSIFIER_SYSTEM_PROMPT = [
  "You classify inbound support emails.",
  "Return only compact JSON with keys: isSupport, confidence, reason.",
  "Do not include markdown, code fences, prose, tool calls, or extra keys.",
].join(" ");

export interface EmailClassification {
  isSupport: boolean;
  confidence: number;
  reason: string;
}

export type EmailClassifier = (email: ResendReceivedEmail) => Promise<EmailClassification>;

export interface PiPromptInput {
  command?: string | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  model: string;
  thinkingOptionId?: string | undefined;
  prompt: string;
  systemPrompt?: string | undefined;
  timeoutMs?: number | undefined;
}

export type PiPromptRunner = (input: PiPromptInput) => Promise<string>;

type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "get_messages" };

interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingPiRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function failOpen(reason: string): EmailClassification {
  return {
    isSupport: true,
    confidence: 0,
    reason: reason.includes("failed open") ? reason : `${reason}; failed open.`,
  };
}

function parseClassification(value: unknown): EmailClassification | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.isSupport !== "boolean") return null;
  const confidence = typeof record.confidence === "number" ? record.confidence : 0.5;
  const reason = typeof record.reason === "string" ? record.reason : "No reason provided.";
  return {
    isSupport: record.isSupport,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason,
  };
}

function parseClassificationText(text: string): EmailClassification | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenceMatch?.[1] ?? text).trim();
  const jsonText =
    candidate.startsWith("{") && candidate.endsWith("}")
      ? candidate
      : candidate.slice(candidate.indexOf("{"), candidate.lastIndexOf("}") + 1);
  if (!jsonText) return null;
  try {
    return parseClassification(JSON.parse(jsonText));
  } catch {
    return null;
  }
}

function buildClassifierPrompt(email: ResendReceivedEmail): string {
  return [
    "Classify whether this email should create a customer support triage thread.",
    "",
    "Support includes:",
    "- customer questions",
    "- bugs or product issues",
    "- billing, account, login, or access issues",
    "- user confusion, product feedback, or requests for help",
    "",
    "Non-support includes:",
    "- marketing newsletters",
    "- spam",
    "- automated alerts unrelated to a user issue",
    "- routine notifications that do not need customer-support handling",
    "",
    "Return JSON only:",
    '{"isSupport":true,"confidence":0.92,"reason":"short reason"}',
    "",
    `From: ${email.from ?? "(unknown)"}`,
    `To: ${(email.to ?? []).join(", ") || "(unknown)"}`,
    `Cc: ${(email.cc ?? []).join(", ") || "(none)"}`,
    `Subject: ${email.subject ?? "(no subject)"}`,
    "",
    truncateText(stripQuotedEmailChain(emailBody(email)), 4000),
  ].join("\n");
}

function normalizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

function piCommandFromInput(input: PiPromptInput): string {
  return (
    input.command?.trim() ||
    input.env?.PI_COMMAND?.trim() ||
    input.env?.PI_ACP_PI_COMMAND?.trim() ||
    process.env.PI_COMMAND?.trim() ||
    process.env.PI_ACP_PI_COMMAND?.trim() ||
    DEFAULT_PI_COMMAND
  );
}

function buildPiArgs(input: PiPromptInput): string[] {
  const args = ["--mode", "rpc", "--model", input.model];
  const thinking = input.thinkingOptionId?.trim();
  if (thinking) args.push("--thinking", thinking);
  const systemPrompt = input.systemPrompt?.trim();
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  return args;
}

function appendBuffer(buffer: string, chunk: Buffer | string, limit = 8192): string {
  const next = buffer + chunk.toString();
  return next.length > limit ? next.slice(-limit) : next;
}

function assistantTextFromMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) return null;
  const text = record.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const content = part as Record<string, unknown>;
      return content.type === "text" && typeof content.text === "string" ? content.text : "";
    })
    .join("");
  return text.trim() ? text : null;
}

function assistantTextFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = assistantTextFromMessage(messages[i]);
    if (text) return text;
  }
  return null;
}

function safeKill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // ignore shutdown races
  }
}

export async function runPiPrompt(input: PiPromptInput): Promise<string> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const child = spawn(piCommandFromInput(input), buildPiArgs(input), {
    cwd: input.cwd ?? process.cwd(),
    env: normalizeEnv(input.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let nextRequestId = 1;
  let settled = false;
  let lastAssistantText: string | null = null;
  const pending = new Map<string, PendingPiRequest>();

  let resolveAgentEnd: (text: string) => void = () => {};
  let rejectAgentEnd: (error: Error) => void = () => {};
  const agentEnd = new Promise<string>((resolve, reject) => {
    resolveAgentEnd = resolve;
    rejectAgentEnd = reject;
  });

  function rejectAll(error: Error): void {
    if (settled) return;
    settled = true;
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(error);
    }
    pending.clear();
    rejectAgentEnd(error);
  }

  function sendRpcCommand(command: PiRpcCommand, requestTimeoutMs = 30_000): Promise<unknown> {
    if (settled) return Promise.reject(new Error("Pi RPC session is closed"));
    const id = `req_${nextRequestId}`;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi RPC request timed out for ${command.type}\n${stderrBuffer}`.trim()));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  function handleResponse(response: PiRpcResponse): void {
    if (!response.id) return;
    const pendingRequest = pending.get(response.id);
    if (!pendingRequest) return;
    clearTimeout(pendingRequest.timer);
    pending.delete(response.id);
    if (!response.success) {
      pendingRequest.reject(new Error(response.error ?? `Pi RPC ${response.command} failed`));
      return;
    }
    pendingRequest.resolve(response.data);
  }

  function handleEvent(event: Record<string, unknown>): void {
    const messageText = assistantTextFromMessage(event.message);
    if (messageText) lastAssistantText = messageText;
    if (event.type === "agent_end") {
      const text = assistantTextFromMessages(event.messages) ?? lastAssistantText;
      if (text) {
        settled = true;
        resolveAgentEnd(text);
        return;
      }
      rejectAll(new Error("Pi classifier completed without assistant text"));
    }
    if (event.type === "process_exit" && typeof event.error === "string") {
      rejectAll(new Error(event.error));
    }
  }

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    if (message.type === "response") {
      handleResponse(message as unknown as PiRpcResponse);
      return;
    }
    handleEvent(message);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) handleLine(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer = appendBuffer(stderrBuffer, chunk);
  });
  child.on("error", (error) => {
    rejectAll(error instanceof Error ? error : new Error(String(error)));
  });
  child.on("exit", (code, signal) => {
    if (settled) return;
    rejectAll(
      new Error(
        `Pi RPC process exited with code ${code ?? "null"} and signal ${
          signal ?? "null"
        }\n${stderrBuffer}`.trim(),
      ),
    );
  });

  const overallTimer = setTimeout(() => {
    rejectAll(new Error(`Pi classifier timed out after ${timeoutMs}ms\n${stderrBuffer}`.trim()));
    safeKill(child, "SIGTERM");
  }, timeoutMs);

  try {
    await sendRpcCommand({ type: "prompt", message: input.prompt }, Math.min(timeoutMs, 30_000));
    return await agentEnd;
  } finally {
    clearTimeout(overallTimer);
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timer);
    }
    pending.clear();
    try {
      child.stdin.end();
    } catch {
      // ignore shutdown races
    }
    if (child.exitCode === null && !child.killed) {
      safeKill(child, "SIGTERM");
      setTimeout(() => safeKill(child, "SIGKILL"), 1000).unref();
    }
  }
}

export function createPiEmailClassifier(
  config: ChatEmailClassifierConfig & { cwd?: string },
  runPrompt: PiPromptRunner = runPiPrompt,
): EmailClassifier {
  return async (email) => {
    try {
      const text = await runPrompt({
        command: config.command,
        cwd: config.cwd,
        model: config.model,
        thinkingOptionId: config.thinkingOptionId,
        prompt: buildClassifierPrompt(email),
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        timeoutMs: config.timeoutMs,
      });
      return (
        parseClassificationText(text) ??
        failOpen("Classifier response did not match schema; failed open.")
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failOpen(`Classifier failed: ${reason}`);
    }
  };
}

export function createDefaultEmailClassifier(
  config: ChatEmailClassifierConfig & { cwd?: string },
): EmailClassifier {
  if (config.provider === "pi") return createPiEmailClassifier(config);
  return async () => failOpen(`Unsupported classifier provider "${config.provider}"`);
}
