import { promises as fs } from "node:fs";
import type { ChatBridgeConfig } from "./config.js";
import type { SenderIdentity } from "./intake/slack.js";

export const EXTERNAL_INTAKE_AGENT_PROMPT = `You are the Office agent for a Slack thread.

You are running in the configured office repo. Answer, analyze, and act using your available tools. Use executor MCP for external systems. Ask for confirmation before destructive actions or external writes. Keep Slack updated with concise summaries.

Coding work:
- For read-only code questions or quick repo inspection, you may inspect files directly.
- When a request requires modifying code in a product repo—fix, refactor, cleanup, implement, test, or change behavior—create an isolated worktree for the target repo and delegate implementation to a coding subagent with the available workspace tools.
- Non-technical users should not need to ask for a subagent explicitly; infer code-editing intent from requests like "clean up the affil repo" or "fix this bug".
- Stay the supervisor: clarify ambiguous goals when needed, keep the user updated, and summarize the subagent's result back in Slack.

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
