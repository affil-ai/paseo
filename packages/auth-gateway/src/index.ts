#!/usr/bin/env node

import { createAuthRuntime } from "./auth.js";
import { loadConfig } from "./config.js";
import { createAuthGateway } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const auth = await createAuthRuntime(config);
  const server = createAuthGateway({
    upstreamUrl: config.PASEO_AUTH_UPSTREAM_URL,
    publicUrl: config.PASEO_AUTH_PUBLIC_URL,
    resolveSession: auth.resolveSession,
    handleAuthRequest: auth.handleRequest,
  });

  let isClosing = false;
  async function close(): Promise<void> {
    if (isClosing) return;
    isClosing = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    auth.close();
  }

  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));

  server.listen(config.PORT, "0.0.0.0", () => {
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        message: "Paseo auth gateway listening",
        port: config.PORT,
        publicUrl: config.PASEO_AUTH_PUBLIC_URL,
        upstreamUrl: config.PASEO_AUTH_UPSTREAM_URL,
      })}\n`,
    );
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ level: "error", message })}\n`);
  process.exitCode = 1;
});
