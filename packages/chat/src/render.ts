import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import {
  Card,
  CardText,
  Table,
  type AdapterPostableMessage,
  type CardChild,
  type StreamChunk,
  type TableAlignment,
} from "chat";

interface CodeFenceState {
  character: "`" | "~";
  length: number;
}

interface MarkdownTableBlock {
  align?: TableAlignment[];
  headers: string[];
  rows: string[][];
}

interface MarkdownTextPart {
  kind: "markdown";
  text: string;
}

interface MarkdownTablePart {
  kind: "table";
  table: MarkdownTableBlock;
}

type SlackMarkdownPart = MarkdownTextPart | MarkdownTablePart;

function parseCodeFence(line: string): CodeFenceState | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const marker = match[1] ?? "";
  return {
    character: marker.startsWith("`") ? "`" : "~",
    length: marker.length,
  };
}

function closesCodeFence(line: string, fence: CodeFenceState): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  if (!match) return false;
  const marker = match[1] ?? "";
  const character = marker.startsWith("`") ? "`" : "~";
  return character === fence.character && marker.length >= fence.length;
}

function countBackticks(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && text[cursor] === "`") {
    cursor += 1;
  }
  return cursor - index;
}

function splitMarkdownTableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let codeSpan = "";

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    const nextCharacter = line[index + 1] ?? "";

    if (character === "\\" && nextCharacter === "|") {
      cell += "|";
      index += 1;
      continue;
    }

    if (character === "`") {
      const backtickCount = countBackticks(line, index);
      const marker = "`".repeat(backtickCount);
      if (codeSpan === "") {
        codeSpan = marker;
      } else if (codeSpan === marker) {
        codeSpan = "";
      }
      cell += marker;
      index += backtickCount - 1;
      continue;
    }

    if (character === "|" && codeSpan === "") {
      cells.push(cell);
      cell = "";
      continue;
    }

    cell += character;
  }

  cells.push(cell);
  if (line.trimStart().startsWith("|")) cells.shift();
  if (line.trimEnd().endsWith("|")) cells.pop();
  return cells.map((value) => value.trim());
}

function parseMarkdownTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const cells = splitMarkdownTableCells(line);
  if (cells.length < 2) return null;
  return cells;
}

function isMarkdownTableSeparator(headers: string[], cells: string[]): boolean {
  return (
    cells.length === headers.length &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

function parseTableAlignment(separator: string[]): TableAlignment[] | undefined {
  const align = separator.map((cell) => {
    const value = cell.replace(/\s/g, "");
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    return "left";
  });
  if (align.every((value) => value === "left")) return undefined;
  return align;
}

function normalizeMarkdownTableRow(row: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
}

function appendMarkdownPart(parts: SlackMarkdownPart[], lines: string[]): void {
  if (lines.length === 0) return;
  parts.push({ kind: "markdown", text: lines.join("\n") });
  lines.length = 0;
}

function parseSlackMarkdownParts(text: string): SlackMarkdownPart[] {
  const lines = text.split("\n");
  const parts: SlackMarkdownPart[] = [];
  const markdownLines: string[] = [];
  let codeFence: CodeFenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (codeFence) {
      markdownLines.push(line);
      if (closesCodeFence(line, codeFence)) codeFence = null;
      continue;
    }

    const openingFence = parseCodeFence(line);
    if (openingFence) {
      codeFence = openingFence;
      markdownLines.push(line);
      continue;
    }

    const headers = parseMarkdownTableRow(line);
    const separator = parseMarkdownTableRow(lines[index + 1] ?? "");
    if (!headers || !separator || !isMarkdownTableSeparator(headers, separator)) {
      markdownLines.push(line);
      continue;
    }

    const rows: string[][] = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length) {
      const row = parseMarkdownTableRow(lines[rowIndex] ?? "");
      if (!row) break;
      rows.push(normalizeMarkdownTableRow(row, headers.length));
      rowIndex += 1;
    }

    if (rows.length === 0) {
      markdownLines.push(line);
      continue;
    }

    appendMarkdownPart(parts, markdownLines);
    parts.push({
      kind: "table",
      table: {
        align: parseTableAlignment(separator),
        headers,
        rows,
      },
    });
    index = rowIndex - 1;
  }

  appendMarkdownPart(parts, markdownLines);
  return parts;
}

function hasTablePart(parts: SlackMarkdownPart[]): boolean {
  return parts.some((part) => part.kind === "table");
}

function appendMarkdownCardText(children: CardChild[], text: string): void {
  const fixed = slackMarkdownFixups(text).trim();
  if (fixed.length === 0) return;
  children.push(CardText(fixed));
}

export function slackMarkdownFixups(text: string): string {
  return text.replace(/(^|\s)(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/gi, "$1`$2`");
}

export function slackPostableMessagesFromMarkdown(text: string): AdapterPostableMessage[] {
  const parts = parseSlackMarkdownParts(text);
  if (!hasTablePart(parts)) return [{ markdown: slackMarkdownFixups(text) }];

  const messages: AdapterPostableMessage[] = [];
  let children: CardChild[] = [];
  let hasTable = false;

  for (const part of parts) {
    if (part.kind === "markdown") {
      appendMarkdownCardText(children, part.text);
      continue;
    }

    if (hasTable) {
      messages.push({ card: Card({ children }) });
      children = [];
      hasTable = false;
    }

    children.push(
      Table({
        align: part.table.align,
        headers: part.table.headers,
        rows: part.table.rows,
      }),
    );
    hasTable = true;
  }

  if (children.length > 0) messages.push({ card: Card({ children }) });
  return messages;
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
