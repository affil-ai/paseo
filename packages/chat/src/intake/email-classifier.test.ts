import { describe, expect, it, vi } from "vitest";
import { createPiEmailClassifier, type PiPromptInput } from "./email-classifier.js";
import type { ResendReceivedEmail } from "./email-resend.js";

const email: ResendReceivedEmail = {
  id: "em_1",
  from: "Jane Doe <jane@example.com>",
  to: ["hello@nextcard.com"],
  subject: "Card not showing up",
  text: "I signed up yesterday but my card is not showing in the app.",
};

const forwardedReceiptEmail: ResendReceivedEmail = {
  id: "em_forwarded_receipt",
  from: "hello@nextcard.com",
  to: ["nextcard-help@example.resend.app"],
  subject: "Fwd: Fw: Your receipt from NOK'S KITCHEN",
  text: [
    "---------- Forwarded message ---------",
    "From: Chia Yang <chia@example.com>",
    "Subject: Fw: Your receipt from NOK'S KITCHEN",
    "To: <hello@nextcard.com>",
    "",
    "I ordered online yesterday and the restaurant was closed. Can you help?",
    "",
    "Begin forwarded message:",
    "NOK'S KITCHEN",
    "$13.11",
  ].join("\n"),
};

function classifierConfig() {
  return {
    provider: "pi" as const,
    model: "openrouter/anthropic/claude-sonnet-5",
    thinkingOptionId: "off",
    timeoutMs: 12_345,
    cwd: "/workspace/office",
  };
}

describe("createPiEmailClassifier", () => {
  it("classifies email with a one-shot Pi prompt", async () => {
    const calls: PiPromptInput[] = [];
    const runner = vi.fn(async (input: PiPromptInput) => {
      calls.push(input);
      return '{"isSupport":true,"confidence":0.97,"reason":"login/account issue"}';
    });

    const classifier = createPiEmailClassifier(classifierConfig(), runner);

    await expect(classifier(email)).resolves.toEqual({
      isSupport: true,
      confidence: 0.97,
      reason: "login/account issue",
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({
      cwd: "/workspace/office",
      model: "openrouter/anthropic/claude-sonnet-5",
      thinkingOptionId: "off",
      timeoutMs: 12_345,
    });
    expect(calls[0]?.prompt).toContain("Card not showing up");
  });

  it("instructs the model not to ignore forwarded receipts with human help requests", async () => {
    const calls: PiPromptInput[] = [];
    const runner = vi.fn(async (input: PiPromptInput) => {
      calls.push(input);
      return '{"isSupport":true,"confidence":0.91,"reason":"forwarded receipt includes a customer help request"}';
    });
    const classifier = createPiEmailClassifier(classifierConfig(), runner);

    await expect(classifier(forwardedReceiptEmail)).resolves.toEqual({
      isSupport: true,
      confidence: 0.91,
      reason: "forwarded receipt includes a customer help request",
    });
    expect(calls[0]?.prompt).toContain(
      "Do not classify an email as non-support solely because it is forwarded",
    );
    expect(calls[0]?.prompt).toContain(
      "forwarded receipts, order confirmations, or automated messages with a human help request",
    );
    expect(calls[0]?.prompt).toContain(
      "I ordered online yesterday and the restaurant was closed. Can you help?",
    );
  });

  it("parses fenced JSON but still asks the model for raw JSON only", async () => {
    const runner = vi.fn(async () => {
      return '```json\n{"isSupport":false,"confidence":0.88,"reason":"marketing newsletter"}\n```';
    });
    const classifier = createPiEmailClassifier(classifierConfig(), runner);

    await expect(classifier(email)).resolves.toEqual({
      isSupport: false,
      confidence: 0.88,
      reason: "marketing newsletter",
    });
  });

  it("fails open when Pi cannot classify", async () => {
    const classifier = createPiEmailClassifier(classifierConfig(), async () => {
      throw new Error("pi unavailable");
    });

    await expect(classifier(email)).resolves.toEqual({
      isSupport: true,
      confidence: 0,
      reason: "Classifier failed: pi unavailable; failed open.",
    });
  });
});
