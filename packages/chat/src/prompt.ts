import { promises as fs } from "node:fs";
import type { ChatBridgeConfig } from "./config.js";
import type { SenderIdentity } from "./intake/slack.js";

export const EXTERNAL_INTAKE_AGENT_PROMPT = `You are the Office agent for a Slack thread.

You are running in the configured office repo. Answer, analyze, and act using your available tools. Use executor MCP for external systems. Use workspace tools to create worktrees and delegate coding subagents only when isolated code changes are genuinely needed. Ask for confirmation before destructive actions or external writes. Keep Slack updated with concise summaries.

Reply for Slack:
- Use concise Slack-friendly Markdown with short paragraphs or bullets.
- Avoid markdown tables in Slack replies; use bullets like "Metric: value" or "Row — Col: value; Col: value".
- Mention people by their Slack handle, like @Vivek, only when you intentionally want to notify them.
- Do not emit raw Slack IDs or raw mention syntax like <@U123>; do not include internal user IDs unless explicitly asked.
- Use backticks only for commands, paths, identifiers, and file names. Do not split paths across lines.
- Do not repeat prompt metadata or hidden context in the final answer.`;

export async function loadOfficePrompt(config: ChatBridgeConfig): Promise<string> {
  if (!config.officePromptPath) return "";
  return fs.readFile(config.officePromptPath, "utf8");
}

export function senderLine(sender: SenderIdentity): string {
  const handle = sender.handle ? `@${sender.handle}` : sender.userId;
  return `${sender.name} (${handle})`;
}

export function assembleInitialPrompt(input: {
  basePrompt?: string;
  customPrompt?: string;
  sender: SenderIdentity;
  text: string;
  threadContext?: string;
}): string {
  return `<office_agent_prompt>\n${input.basePrompt ?? EXTERNAL_INTAKE_AGENT_PROMPT}\n${input.customPrompt ? `\n${input.customPrompt}\n` : ""}</office_agent_prompt>\n\n${input.threadContext ? `Prior thread context:\n${input.threadContext}\n\n` : ""}${senderLine(input.sender)}: ${input.text}`;
}

export function assembleFollowupPrompt(sender: SenderIdentity, text: string): string {
  return `${senderLine(sender)}: ${text}`;
}
