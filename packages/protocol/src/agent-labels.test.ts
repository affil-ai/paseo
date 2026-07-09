import { describe, expect, it } from "vitest";
import {
  CHAT_STARTED_BY_AVATAR_URL_LABEL,
  CHAT_STARTED_BY_HANDLE_LABEL,
  CHAT_STARTED_BY_NAME_LABEL,
  CHAT_STARTED_BY_SOURCE_LABEL,
  CHAT_STARTED_BY_USER_ID_LABEL,
  CHAT_SOURCE_LABEL,
  CHAT_THREAD_ID_LABEL,
  getChatStartedByFromLabels,
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

describe("getChatStartedByFromLabels", () => {
  it("reads Slack starter identity metadata from labels", () => {
    expect(
      getChatStartedByFromLabels({
        [CHAT_STARTED_BY_SOURCE_LABEL]: "slack",
        [CHAT_STARTED_BY_USER_ID_LABEL]: "U123",
        [CHAT_STARTED_BY_NAME_LABEL]: "Jane Doe",
        [CHAT_STARTED_BY_HANDLE_LABEL]: "jane",
        [CHAT_STARTED_BY_AVATAR_URL_LABEL]: "https://example.com/jane.png",
      }),
    ).toEqual({
      source: "slack",
      userId: "U123",
      name: "Jane Doe",
      handle: "jane",
      avatarUrl: "https://example.com/jane.png",
    });
  });

  it("requires a source, user id, and name", () => {
    expect(getChatStartedByFromLabels({ [CHAT_STARTED_BY_SOURCE_LABEL]: "slack" })).toBeNull();
    expect(
      getChatStartedByFromLabels({
        [CHAT_STARTED_BY_SOURCE_LABEL]: "unknown",
        [CHAT_STARTED_BY_USER_ID_LABEL]: "U123",
        [CHAT_STARTED_BY_NAME_LABEL]: "Jane Doe",
      }),
    ).toBeNull();
  });
});
