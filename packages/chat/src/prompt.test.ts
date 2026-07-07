import { describe, expect, it } from "vitest";
import {
  assembleFollowupPrompt,
  assembleInitialPrompt,
  incomingEmailInstruction,
} from "./prompt.js";

const sender = {
  userId: "U123",
  name: "Jane Doe",
  handle: "jane",
};

describe("Slack chat prompt delivery instructions", () => {
  it("adds the manual-mode chat.send instruction next to initial Slack messages", () => {
    const prompt = assembleInitialPrompt({
      basePrompt: "base",
      sender,
      text: "Can you check this?",
      relayMode: "manual",
    });

    expect(prompt).toContain("This message came from Slack.");
    expect(prompt).toContain("immediately acknowledge this message with `chat.send`");
    expect(prompt).toContain("use `chat.send` again mid-turn");
    expect(prompt).toContain("end the turn with a final `chat.send`");
    expect(prompt).toContain("not visible in Slack");
    expect(prompt).toContain("The only exception");
    expect(prompt).toContain("Jane Doe (@jane): Can you check this?");
  });

  it("adds the auto-mode no-duplicate-reply instruction to follow-up Slack messages", () => {
    const prompt = assembleFollowupPrompt(sender, "Thanks", "auto");

    expect(prompt).toContain("This message came from Slack.");
    expect(prompt).toContain("will be sent to Slack automatically");
    expect(prompt).toContain("do not call `chat.send`");
    expect(prompt).toContain("Jane Doe (@jane): Thanks");
  });

  it("uses the email source instruction when provided instead of the Slack one", () => {
    const emailSender = { userId: "jane@customer.com", name: "Jane Doe" };
    const prompt = assembleInitialPrompt({
      basePrompt: "base",
      sender: emailSender,
      text: "Subject: Help",
      relayMode: "auto",
      sourceInstruction: incomingEmailInstruction("auto"),
    });

    expect(prompt).toContain("inbound support email");
    expect(prompt).toContain("cannot email the sender back");
    expect(prompt).not.toContain("This message came from Slack.");
    expect(prompt).toContain("Jane Doe (jane@customer.com): Subject: Help");

    const followup = assembleFollowupPrompt(
      emailSender,
      "More details",
      "auto",
      incomingEmailInstruction("auto"),
    );
    expect(followup).toContain("inbound support email");
    expect(followup).not.toContain("This message came from Slack.");
  });
});
