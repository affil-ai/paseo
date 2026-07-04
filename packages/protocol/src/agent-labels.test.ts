import { describe, expect, it } from "vitest";
import { CHAT_THREAD_ID_LABEL, isChatOfficeAgent, PARENT_AGENT_ID_LABEL } from "./agent-labels.js";

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
