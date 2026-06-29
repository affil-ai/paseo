import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import type { ChatBridgeConfig } from "./config.js";

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
