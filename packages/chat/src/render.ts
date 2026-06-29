import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { StreamChunk } from "chat";

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.includes("|", 1)) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function formatMarkdownTable(headers: string[], rows: string[][]): string {
  return rows
    .map((row) => {
      if (headers.length === 2) return `- ${row[0] ?? ""}: ${row[1] ?? ""}`;
      const label = row[0] ?? "";
      const details = headers
        .slice(1)
        .map((header, index) => `${header}: ${row[index + 1] ?? ""}`)
        .join("; ");
      return `- ${label} — ${details}`;
    })
    .join("\n");
}

function flattenMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headers = parseMarkdownTableRow(lines[index] ?? "");
    const separator = parseMarkdownTableRow(lines[index + 1] ?? "");
    if (!headers || !separator || !isMarkdownTableSeparator(separator)) {
      output.push(lines[index] ?? "");
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const row = parseMarkdownTableRow(lines[index] ?? "");
      if (!row) break;
      rows.push(row);
      index += 1;
    }
    index -= 1;
    output.push(formatMarkdownTable(headers, rows));
  }
  return output.join("\n");
}

export function slackMarkdownFixups(text: string): string {
  return flattenMarkdownTables(text).replace(
    /(^|\s)(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/gi,
    "$1`$2`",
  );
}

function mapToolStatus(status: "running" | "completed" | "failed" | "canceled") {
  if (status === "running") return "in_progress";
  if (status === "completed") return "complete";
  return "error";
}

export function renderTimelineItem(
  item: AgentTimelineItem,
  options: { showReasoning?: boolean } = {},
): StreamChunk | null {
  switch (item.type) {
    case "assistant_message":
      return { type: "markdown_text", text: slackMarkdownFixups(item.text) };
    case "reasoning":
      return options.showReasoning
        ? { type: "markdown_text", text: slackMarkdownFixups(item.text) }
        : null;
    case "tool_call":
      return {
        type: "task_update",
        id: item.callId,
        title: item.name,
        status: mapToolStatus(item.status),
        details:
          typeof item.detail === "object" &&
          "text" in item.detail &&
          typeof item.detail.text === "string"
            ? item.detail.text
            : undefined,
        output: item.status === "failed" ? String(item.error ?? "failed") : undefined,
      };
    case "todo":
      return {
        type: "plan_update",
        title: item.items.map((todo) => `${todo.completed ? "☑" : "☐"} ${todo.text}`).join("\n"),
      };
    case "error":
      return { type: "markdown_text", text: `⚠️ ${item.message}` };
    default:
      return null;
  }
}
