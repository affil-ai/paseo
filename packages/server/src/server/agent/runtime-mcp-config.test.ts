import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { withRuntimeMcpServers, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });

  test("injects configured runtime MCP servers", () => {
    const result = withRuntimeMcpServers({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
      mcpServers: {
        executor: {
          type: "http",
          url: "https://executor.example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    });

    expect(result.mcpServers?.executor).toEqual({
      type: "http",
      url: "https://executor.example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect(result.mcpServers?.paseo).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("keeps per-agent MCP servers ahead of configured runtime MCP servers", () => {
    const result = withRuntimeMcpServers({
      config: {
        ...BASE_CONFIG,
        mcpServers: {
          executor: {
            type: "http",
            url: "https://workspace.example.com/mcp",
          },
        },
      },
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: null,
      mcpServers: {
        executor: {
          type: "http",
          url: "https://global.example.com/mcp",
        },
      },
    });

    expect(result.mcpServers?.executor).toEqual({
      type: "http",
      url: "https://workspace.example.com/mcp",
    });
  });
});
