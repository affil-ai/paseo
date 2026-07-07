import { describe, expect, it } from "vitest";
import {
  assembleContextOnlySlackPrompt,
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
    expect(prompt).toContain("Slack only sees messages sent with chat.send");
    expect(prompt).toContain("Use mid-turn chat.send sparingly");
    expect(prompt).toContain("End with one final chat.send");
    expect(prompt).toContain("Skip Slack sends only if");
    expect(prompt).not.toContain("chat.ask");
    expect(prompt).toContain("custom office rules");
  });

  it("keeps manual-mode Slack delivery rules out of the initial user prompt", () => {
    const prompt = assembleInitialPrompt({
      sender,
      text: "Can you check this?",
      relayMode: "manual",
    });

    expect(prompt).toContain("This came from Slack.");
    expect(prompt).toContain("Manual delivery is on");
    expect(prompt).toContain("use chat.send per the system Slack delivery rules");
    expect(prompt).not.toContain("End every Slack turn");
    expect(prompt).not.toContain("final `chat.send`");
    expect(prompt).toContain("Jane Doe (@jane): Can you check this?");
  });

  it("adds the auto-mode no-duplicate-reply instruction to follow-up Slack messages", () => {
    const prompt = assembleFollowupPrompt(sender, "Thanks", "auto");

    expect(prompt).toContain("This came from Slack.");
    expect(prompt).toContain("Automatic delivery is on");
    expect(prompt).toContain("follow the system Slack delivery rules");
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
    expect(prompt).not.toContain("This came from Slack.");
    expect(prompt).toContain("Jane Doe (jane@customer.com): Subject: Help");

    const followup = assembleFollowupPrompt(
      emailSender,
      "More details",
      "auto",
      incomingEmailInstruction("auto"),
    );
    expect(followup).toContain("inbound support email");
    expect(followup).not.toContain("This came from Slack.");
  });

  it("keeps context-only Slack instructions short", () => {
    const prompt = assembleContextOnlySlackPrompt(sender, "aside - probably unrelated");

    expect(prompt).toContain("This Slack message is context only.");
    expect(prompt).toContain("Do not respond.");
    expect(prompt).toContain("Continue what you were doing.");
    expect(prompt).toContain("Jane Doe (@jane): aside - probably unrelated");
    expect(prompt).not.toContain("adjust");
    expect(prompt).not.toContain("internal work");
  });
});
