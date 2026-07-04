import { describe, expect, it } from "vitest";
import { assembleFollowupPrompt, assembleInitialPrompt } from "./prompt.js";

const sender = {
  userId: "U123",
  name: "Jane Doe",
  handle: "jane",
};

describe("Slack chat prompt delivery instructions", () => {
  it("adds the manual-mode chat.reply instruction next to initial Slack messages", () => {
    const prompt = assembleInitialPrompt({
      basePrompt: "base",
      sender,
      text: "Can you check this?",
      relayMode: "manual",
    });

    expect(prompt).toContain("This message came from Slack.");
    expect(prompt).toContain("call `chat.reply`");
    expect(prompt).toContain("your final assistant message is not sent automatically");
    expect(prompt).toContain("Jane Doe (@jane): Can you check this?");
  });

  it("adds the auto-mode no-duplicate-reply instruction to follow-up Slack messages", () => {
    const prompt = assembleFollowupPrompt(sender, "Thanks", "auto");

    expect(prompt).toContain("This message came from Slack.");
    expect(prompt).toContain("will be sent to Slack automatically");
    expect(prompt).toContain("do not call `chat.reply`");
    expect(prompt).toContain("Jane Doe (@jane): Thanks");
  });
});
