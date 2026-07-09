import { describe, expect, it } from "vitest";
import { AgentTimelineItemPayloadSchema, SendAgentMessageRequestSchema } from "./messages.js";

describe("chat user message provenance", () => {
  it("accepts an optional Slack source on send requests and timeline items", () => {
    const request = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "request-1",
      agentId: "agent-1",
      text: "hello from Slack",
      userMessageSource: "slack",
    });
    const item = AgentTimelineItemPayloadSchema.parse({
      type: "user_message",
      text: "hello from Slack",
      messageId: "message-1",
      source: "slack",
    });

    expect(request.userMessageSource).toBe("slack");
    expect(item).toMatchObject({ source: "slack" });
  });

  it("keeps old source-less payloads valid", () => {
    expect(
      SendAgentMessageRequestSchema.parse({
        type: "send_agent_message_request",
        requestId: "request-2",
        agentId: "agent-1",
        text: "hello from Paseo",
      }).userMessageSource,
    ).toBeUndefined();
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "user_message",
        text: "hello from Paseo",
        messageId: "message-2",
      }),
    ).not.toHaveProperty("source");
  });
});
