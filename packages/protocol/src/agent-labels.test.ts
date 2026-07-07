import { describe, expect, it } from "vitest";
import {
  CHAT_SOURCE_LABEL,
  CHAT_THREAD_ID_LABEL,
  getChatUserMessageSourceFromLabels,
  isChatOfficeAgent,
  PARENT_AGENT_ID_LABEL,
} from "./agent-labels.js";

describe("isChatOfficeAgent", () => {
  it("requires a chat thread label and excludes delegated agents", () => {
    expect(isChatOfficeAgent({ labels: { [CHAT_THREAD_ID_LABEL]: "slack:C1:111.222" } })).toBe(
      true,
    );
    expect(isChatOfficeAgent({ labels: {} })).toBe(false);
    expect(
      isChatOfficeAgent({
        labels: {
          [CHAT_THREAD_ID_LABEL]: "slack:C1:111.222",
          [PARENT_AGENT_ID_LABEL]: "agent-office",
        },
      }),
    ).toBe(false);
  });
});

describe("getChatUserMessageSourceFromLabels", () => {
  it("uses an explicit chat source label when present", () => {
    expect(
      getChatUserMessageSourceFromLabels({
        [CHAT_THREAD_ID_LABEL]: "slack:C1:111.222",
        [CHAT_SOURCE_LABEL]: "support",
      }),
    ).toBe("support");
    expect(getChatUserMessageSourceFromLabels({ [CHAT_SOURCE_LABEL]: "slack" })).toBe("slack");
  });

  it("falls back to Slack thread ids for older labels", () => {
    expect(getChatUserMessageSourceFromLabels({ [CHAT_THREAD_ID_LABEL]: "slack:C1:111.222" })).toBe(
      "slack",
    );
    expect(getChatUserMessageSourceFromLabels({ [CHAT_THREAD_ID_LABEL]: "email:thread-1" })).toBe(
      null,
    );
  });
});
