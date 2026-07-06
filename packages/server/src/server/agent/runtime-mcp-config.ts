import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";

const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
}): AgentSessionConfig {
  return withRuntimeMcpServers({
    ...params,
    mcpServers: {},
  });
}

export function withRuntimeMcpServers(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
  mcpServers?: Record<string, McpServerConfig>;
}): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  const runtimeMcpServers: Record<string, McpServerConfig> = {};

  if (params.mcpBaseUrl && !storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    runtimeMcpServers[PASEO_MCP_SERVER_NAME] = {
      type: "http",
      url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
      ...(params.mcpAuthToken
        ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
        : {}),
    };
  }

  for (const [name, serverConfig] of Object.entries(params.mcpServers ?? {})) {
    if (storedConfig.mcpServers?.[name]) {
      continue;
    }
    runtimeMcpServers[name] = serverConfig;
  }

  if (Object.keys(runtimeMcpServers).length === 0) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      ...runtimeMcpServers,
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPaseoMcpServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}
