import { describe, expect, it } from "vitest";
import {
  assembleExternalIntakeSystemPrompt,
  assembleFollowupPrompt,
  assembleInitialPrompt,
  externalIntakeAgentPrompt,
  incomingEmailInstruction,
} from "./prompt.js";

const sender = {
  userId: "U123",
  name: "Jane Doe",
  handle: "jane",
};

describe("Slack chat prompt delivery instructions", () => {
  it("puts durable manual-mode Slack delivery instructions in the system prompt", () => {
    const prompt = assembleExternalIntakeSystemPrompt({
      basePrompt: externalIntakeAgentPrompt("manual"),
      customPrompt: "custom office rules",
    });

    expect(prompt).toContain("Slack delivery mode: manual.");
    expect(prompt).toContain("End every Slack turn with a final chat.send");
    expect(prompt).toContain("not visible in Slack");
    expect(prompt).toContain("The only exception");
    expect(prompt).not.toContain("chat.ask");
    expect(prompt).toContain("custom office rules");
  });

  it("keeps manual-mode Slack delivery rules out of the initial user prompt", () => {
    const prompt = assembleInitialPrompt({
      sender,
      text: "Can you check this?",
      relayMode: "manual",
    });

    expect(prompt).toContain("This message came from Slack.");
    expect(prompt).toContain("follow the Slack delivery mode instructions from your system prompt");
    expect(prompt).not.toContain("End every Slack turn");
    expect(prompt).not.toContain("final `chat.send`");
    expect(prompt).toContain("Jane Doe (@jane): Can you check this?");
  });

  it("adds the auto-mode no-duplicate-reply instruction to follow-up Slack messages", () => {
    const prompt = assembleFollowupPrompt(sender, "Thanks", "auto");

    expect(prompt).toContain("This message came from Slack.");
    expect(prompt).toContain("Automatic Slack delivery is enabled");
    expect(prompt).toContain("follow the Slack delivery mode instructions from your system prompt");
    expect(prompt).toContain("Jane Doe (@jane): Thanks");
  });

  it("uses the email source instruction when provided instead of the Slack one", () => {
    const emailSender = { userId: "jane@customer.com", name: "Jane Doe" };
    const prompt = assembleInitialPrompt({
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
