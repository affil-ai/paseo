import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import Database from "better-sqlite3";
import { createAuthRuntime, type AuthRuntime } from "./auth.js";
import { loadConfig } from "./config.js";
import { createAuthGateway } from "./server.js";

const servers: Server[] = [];
const runtimes: AuthRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("Better Auth runtime", () => {
  it("migrates its SQLite database and mounts the auth API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-auth-gateway-"));
    directories.push(directory);
    const config = loadConfig({
      PASEO_AUTH_PUBLIC_URL: "http://127.0.0.1:3000",
      PASEO_AUTH_UPSTREAM_URL: "http://127.0.0.1:6767",
      PASEO_AUTH_DATABASE_PATH: join(directory, "auth.sqlite"),
      PASEO_AUTH_GOOGLE_HOSTED_DOMAIN: "example.com",
      BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
    });
    const runtime = await createAuthRuntime(config);
    runtimes.push(runtime);
    const upstream = createServer();
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: config.PASEO_AUTH_PUBLIC_URL,
      resolveSession: runtime.resolveSession,
      handleAuthRequest: runtime.handleRequest,
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/auth/ok`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("starts Google OAuth with the configured callback origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-auth-gateway-"));
    directories.push(directory);
    const config = loadConfig({
      PASEO_AUTH_PUBLIC_URL: "http://127.0.0.1:3000",
      PASEO_AUTH_UPSTREAM_URL: "http://127.0.0.1:6767",
      PASEO_AUTH_DATABASE_PATH: join(directory, "auth.sqlite"),
      PASEO_AUTH_GOOGLE_HOSTED_DOMAIN: "example.com",
      BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
    });
    const runtime = await createAuthRuntime(config);
    runtimes.push(runtime);
    const upstream = createServer();
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: config.PASEO_AUTH_PUBLIC_URL,
      resolveSession: runtime.resolveSession,
      handleAuthRequest: runtime.handleRequest,
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: config.PASEO_AUTH_PUBLIC_URL,
      },
      body: JSON.stringify({ provider: "google", callbackURL: "/workspace" }),
    });
    const payload = z.object({ url: z.string() }).parse(await response.json());

    expect(response.status).toBe(200);
    expect(new URL(payload.url).hostname).toBe("accounts.google.com");
    expect(new URL(payload.url).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/api/auth/callback/google",
    );
    expect(response.headers.get("set-cookie")).toContain("paseo-auth.state");
  });

  it("configures GitHub as an explicit secondary identity provider", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-auth-gateway-"));
    directories.push(directory);
    const config = loadConfig({
      PASEO_AUTH_PUBLIC_URL: "http://127.0.0.1:3000",
      PASEO_AUTH_UPSTREAM_URL: "http://127.0.0.1:6767",
      PASEO_AUTH_DATABASE_PATH: join(directory, "auth.sqlite"),
      PASEO_AUTH_GOOGLE_HOSTED_DOMAIN: "example.com",
      BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
    });
    const runtime = await createAuthRuntime(config);
    runtimes.push(runtime);
    const upstream = createServer();
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: config.PASEO_AUTH_PUBLIC_URL,
      resolveSession: runtime.resolveSession,
      handleAuthRequest: runtime.handleRequest,
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.PASEO_AUTH_PUBLIC_URL },
      body: JSON.stringify({ provider: "github", callbackURL: "/auth/account" }),
    });
    const payload = z.object({ url: z.string() }).parse(await response.json());

    expect(response.status).toBe(200);
    expect(new URL(payload.url).hostname).toBe("github.com");
    expect(new URL(payload.url).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/api/auth/callback/github",
    );
  });

  it("uses the configured office fallback email for an unlinked user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-auth-gateway-"));
    directories.push(directory);
    const databasePath = join(directory, "auth.sqlite");
    const config = loadConfig({
      PASEO_AUTH_PUBLIC_URL: "http://127.0.0.1:3000",
      PASEO_AUTH_UPSTREAM_URL: "http://127.0.0.1:6767",
      PASEO_AUTH_DATABASE_PATH: databasePath,
      PASEO_AUTH_GOOGLE_HOSTED_DOMAIN: "example.com",
      BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
    });
    const runtime = await createAuthRuntime(config);
    runtimes.push(runtime);
    const database = new Database(databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-1", "Jenny", "jenny@example.com", 1, now, now);
    database.close();

    await expect(runtime.resolveIdentity("jenny@example.com")).resolves.toEqual({
      name: "Jenny",
      email: "jenny@example.com",
      commitEmail: "vivek@affil.ai",
    });
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
}
