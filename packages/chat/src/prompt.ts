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
- Assistant text is not automatically posted to Slack.
- When a Slack turn starts, immediately acknowledge the request with chat.send before doing tool work.
- Use chat.send again mid-turn whenever you have a meaningful progress update, blocker, decision point, or partial result the user should see.
- End every Slack turn with a final chat.send to the current Slack thread containing the completed answer, result, file/image, handoff summary, or brief stopped/declined status; your final assistant message is not posted automatically and is not visible in Slack.
- The only exception is when the Slack user explicitly tells you not to send another Slack message.
- Use chat.send for Slack-visible text, files/images, and current-thread replies. Do not start separate chat conversations unless the user explicitly asks you to contact someone elsewhere.`;
  }

  return `Slack delivery mode: automatic.
- Final assistant text is automatically posted to Slack.
- Do not call chat.send for the current thread unless you intentionally want to override automatic relay for the turn.
- Use chat.send only for new conversations the user explicitly asks you to start, other explicit destinations, or explicit file/image uploads.`;
}

function incomingSlackInstruction(relayMode: ChatRelayMode): string {
  if (relayMode === "manual") {
    return "This message came from Slack. Manual Slack delivery is enabled; follow the Slack delivery mode instructions from your system prompt for this turn.";
  }

  return "This message came from Slack. Automatic Slack delivery is enabled; follow the Slack delivery mode instructions from your system prompt for this turn.";
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
