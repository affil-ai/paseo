import type { AdapterPostableMessage, CardElement, TableElement } from "chat";
import { describe, expect, it } from "vitest";
import { slackMarkdownFixups, slackPostableMessagesFromMarkdown } from "./render.js";

function cardFromMessage(message: AdapterPostableMessage): CardElement {
  if (typeof message === "object" && message !== null && "card" in message) return message.card;
  throw new Error("Expected postable card message");
}

function tablesFromMessage(message: AdapterPostableMessage): TableElement[] {
  return cardFromMessage(message).children.filter((child) => child.type === "table");
}

describe("slackMarkdownFixups", () => {
  it("keeps existing repository backtick fixups without rewriting tables", () => {
    expect(
      slackMarkdownFixups(
        [
          "Check @affil-ai/paseo for details.",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| Alpha | 1 |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Check `@affil-ai/paseo` for details.",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| Alpha | 1 |",
      ].join("\n"),
    );
  });
});

describe("slackPostableMessagesFromMarkdown", () => {
  it("keeps non-table text as one markdown message", () => {
    expect(slackPostableMessagesFromMarkdown("Check @affil-ai/paseo.")).toEqual([
      { markdown: "Check `@affil-ai/paseo.`" },
    ]);
  });

  it("converts Markdown tables to native Chat SDK table cards", () => {
    const messages = slackPostableMessagesFromMarkdown(
      [
        "| Date | Product | Short link | PDP | Destination explanation |",
        "| --- | --- | --- | --- | --- |",
        "| Jul 1 | Chase Sapphire Preferred | https://go.example/csp | /cards/csp | Premium travel card |",
      ].join("\n"),
    );

    expect(messages).toHaveLength(1);
    expect(tablesFromMessage(messages[0] ?? "")).toEqual([
      {
        align: undefined,
        headers: ["Date", "Product", "Short link", "PDP", "Destination explanation"],
        rows: [
          [
            "Jul 1",
            "Chase Sapphire Preferred",
            "https://go.example/csp",
            "/cards/csp",
            "Premium travel card",
          ],
        ],
        type: "table",
      },
    ]);
  });

  it("preserves surrounding text in the same card as a single table", () => {
    const messages = slackPostableMessagesFromMarkdown(
      [
        "Here are the links:",
        "",
        "| Date | Destination |",
        "| --- | --- |",
        "| Jul 1 | PDP |",
        "",
        "Done.",
      ].join("\n"),
    );

    expect(messages).toHaveLength(1);
    expect(cardFromMessage(messages[0] ?? "").children).toMatchObject([
      { content: "Here are the links:", type: "text" },
      { headers: ["Date", "Destination"], rows: [["Jul 1", "PDP"]], type: "table" },
      { content: "Done.", type: "text" },
    ]);
  });

  it("splits multiple tables so each Slack message has one native table", () => {
    const messages = slackPostableMessagesFromMarkdown(
      [
        "| Name | Value |",
        "| --- | --- |",
        "| Alpha | 1 |",
        "",
        "Between.",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| Beta | 2 |",
      ].join("\n"),
    );

    expect(messages).toHaveLength(2);
    expect(tablesFromMessage(messages[0] ?? "")).toEqual([
      { align: undefined, headers: ["Name", "Value"], rows: [["Alpha", "1"]], type: "table" },
    ]);
    expect(cardFromMessage(messages[0] ?? "").children).toContainEqual({
      content: "Between.",
      style: undefined,
      type: "text",
    });
    expect(tablesFromMessage(messages[1] ?? "")).toEqual([
      { align: undefined, headers: ["Name", "Value"], rows: [["Beta", "2"]], type: "table" },
    ]);
  });

  it("supports alignment separator rows", () => {
    const messages = slackPostableMessagesFromMarkdown(
      ["| Left | Center | Right |", "| :--- | :---: | ---: |", "| a | b | c |"].join("\n"),
    );

    expect(tablesFromMessage(messages[0] ?? "")[0]).toEqual({
      align: ["left", "center", "right"],
      headers: ["Left", "Center", "Right"],
      rows: [["a", "b", "c"]],
      type: "table",
    });
  });

  it("does not convert non-table pipe text", () => {
    const text = [
      "Use foo | bar as plain text.",
      "",
      "| Header | Value |",
      "| --- | --- |",
      "No body row here.",
    ].join("\n");

    expect(slackPostableMessagesFromMarkdown(text)).toEqual([{ markdown: text }]);
  });

  it("does not rewrite table-like text inside fenced code blocks", () => {
    const text = ["```md", "| Header | Value |", "| --- | --- |", "| Alpha | 1 |", "```"].join(
      "\n",
    );

    expect(slackPostableMessagesFromMarkdown(text)).toEqual([{ markdown: text }]);
  });

  it("keeps inline-code pipes inside table cells", () => {
    const messages = slackPostableMessagesFromMarkdown(
      ["| Expression | Meaning |", "| --- | --- |", "| `a | b` | logical or |"].join("\n"),
    );

    expect(tablesFromMessage(messages[0] ?? "")[0]).toMatchObject({
      headers: ["Expression", "Meaning"],
      rows: [["`a | b`", "logical or"]],
      type: "table",
    });
  });
});
