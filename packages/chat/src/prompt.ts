import { promises as fs } from "node:fs";
import type { ChatBridgeConfig, ChatRelayMode } from "./config.js";
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

function relayModePrompt(relayMode: ChatRelayMode): string {
  if (relayMode === "manual") {
    return `Slack delivery mode: manual.
- Slack only sees messages sent with chat.send.
- Send one brief chat.send acknowledgement before tool work.
- Use mid-turn chat.send sparingly: only for important progress, blockers, decisions, partial results, or files/images the user needs now.
- End with one final chat.send containing the answer/result, artifact, handoff, or stopped/declined status.
- Skip Slack sends only if the user explicitly asks for no more Slack messages.
- Reply in the current thread by default; start another conversation only when explicitly asked.`;
  }

  return `Slack delivery mode: automatic.
- Final assistant text is automatically posted to Slack.
- Do not call chat.send for the current thread unless you intentionally want to override automatic relay for the turn.
- Use chat.send only for new conversations the user explicitly asks you to start, other explicit destinations, or explicit file/image uploads.`;
}

function incomingSlackInstruction(relayMode: ChatRelayMode): string {
  if (relayMode === "manual") {
    return "This came from Slack. Manual delivery is on; use chat.send per the system Slack delivery rules.";
  }

  return "This came from Slack. Automatic delivery is on; follow the system Slack delivery rules.";
}

export function incomingEmailInstruction(
  relayMode: ChatRelayMode,
  supportAddress = "hello@nextcard.com",
): string {
  if (relayMode === "manual") {
    return `This came from an inbound support email to ${supportAddress}. You cannot email the sender back in v1; your output reaches humans only through the linked Slack announcement thread. To post there, call \`chat.send\` with your Slack-visible response.`;
  }

  return `This came from an inbound support email to ${supportAddress}. You cannot email the sender back in v1; your output reaches humans only through the linked Slack announcement thread, where your final assistant message is posted automatically. Humans follow up from that Slack thread or by email.`;
}

export const EMAIL_TRIAGE_INSTRUCTION = `Support email triage:
- First classify the email: product bug, account/data issue, billing issue, user confusion, feature request, or spam/no-action. Not every email needs investigation.
- If it is a real issue, investigate with your available tools and gather evidence before concluding.
- Do not make code changes or open PRs for triage; describe recommended changes at a high level instead.
- End with a concise triage summary: classification, affected user/account, observed evidence, and recommended next steps.`;

export function externalIntakeAgentPrompt(relayMode: ChatRelayMode): string {
  return `${EXTERNAL_INTAKE_AGENT_PROMPT}\n\n${relayModePrompt(relayMode)}`;
}

export function assembleExternalIntakeSystemPrompt(input: {
  basePrompt?: string;
  customPrompt?: string;
}): string {
  return [input.basePrompt ?? EXTERNAL_INTAKE_AGENT_PROMPT, input.customPrompt]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function loadOfficePrompt(config: ChatBridgeConfig): Promise<string> {
  if (!config.officePromptPath) return "";
  return fs.readFile(config.officePromptPath, "utf8");
}

export function senderLine(sender: SenderIdentity): string {
  const handle = sender.handle ? `@${sender.handle}` : sender.userId;
  return `${sender.name} (${handle})`;
}

export function assembleInitialPrompt(input: {
  sender: SenderIdentity;
  text: string;
  threadContext?: string;
  relayMode: ChatRelayMode;
  sourceInstruction?: string;
}): string {
  return `${input.threadContext ? `Prior thread context:\n${input.threadContext}\n\n` : ""}${input.sourceInstruction ?? incomingSlackInstruction(input.relayMode)}\n\n${senderLine(input.sender)}: ${input.text}`;
}

export function assembleFollowupPrompt(
  sender: SenderIdentity,
  text: string,
  relayMode: ChatRelayMode,
  sourceInstruction?: string,
): string {
  return `${sourceInstruction ?? incomingSlackInstruction(relayMode)}\n\n${senderLine(sender)}: ${text}`;
}

export function assembleContextOnlySlackPrompt(sender: SenderIdentity, text: string): string {
  return `This Slack message is context only. Do not respond. Continue what you were doing.\n\n${senderLine(sender)}: ${text}`;
}
