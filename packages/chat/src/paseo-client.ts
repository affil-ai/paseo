import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import type { ChatBridgeConfig, ChatRepositoryConfig } from "./config.js";

function createWebSocketFactory() {
  return (
    url: string,
    options?: { headers?: Record<string, string>; protocols?: string[] },
  ): WebSocketLike =>
    new WebSocket(url, options?.protocols, {
      headers: options?.headers,
    }) as unknown as WebSocketLike;
}

function daemonUrl(host: string): string {
  if (host.startsWith("ws://") || host.startsWith("wss://")) return host;
  return `ws://${host.replace(/^http:\/\//, "").replace(/^https:\/\//, "")}/ws`;
}

export async function connectToPaseoDaemon(config: ChatBridgeConfig): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: daemonUrl(config.daemonHost),
    clientId: `chat-bridge-${process.pid}`,
    clientType: "cli",
    appVersion: "chat-bridge-v1",
    password: config.daemonPassword,
    connectTimeoutMs: 15_000,
    webSocketFactory: createWebSocketFactory(),
    reconnect: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 10_000 },
  });
  await client.connect();
  return client;
}

export async function resolveChatRepositoryPath(
  client: DaemonClient,
  repository?: ChatRepositoryConfig | null,
): Promise<string> {
  const configuredPath = repository?.projectRootPath.trim();
  if (configuredPath) {
    return configuredPath;
  }

  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    const workspace = page.entries.find((entry) => entry.chatRepository);
    const repoPath = workspace?.projectRootPath?.trim() || workspace?.workspaceDirectory?.trim();
    if (repoPath) {
      return repoPath;
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);

  throw new Error(
    "No chat repo configured. Use Settings -> Host -> Chat to choose the main chat project.",
  );
}
