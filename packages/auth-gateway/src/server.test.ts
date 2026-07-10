import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createAuthGateway } from "./server.js";

const servers: Server[] = [];

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
});

describe("auth gateway", () => {
  it("redirects an unauthenticated browser request to login without reaching Paseo", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end("paseo");
    });
    const upstreamUrl = await listen(upstream);

    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/workspace?tab=agent`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/login?returnTo=%2Fworkspace%3Ftab%3Dagent",
    );
    expect(upstreamRequests).toBe(0);
  });

  it("returns JSON 401 for an unauthenticated API request", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/status`, {
      headers: { accept: "application/json" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("exposes an unauthenticated health check for the container platform", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("proxies authenticated requests with a trusted user header and without the session cookie", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          email: request.headers["x-paseo-authenticated-user-email"],
          name: Buffer.from(
            String(request.headers["x-paseo-authenticated-user-name-b64"] ?? ""),
            "base64url",
          ).toString("utf8"),
          legacyEmail: request.headers["cf-access-authenticated-user-email"],
          cookie: request.headers.cookie ?? null,
        }),
      );
    });
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async (headers) =>
        headers.cookie === "session=valid"
          ? { email: "user@example.com", name: "Example User" }
          : null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/status`, {
      headers: {
        cookie: "session=valid",
        "x-paseo-authenticated-user-email": "attacker@example.com",
        "cf-access-authenticated-user-email": "attacker@example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "user@example.com",
      name: "Example User",
      legacyEmail: "user@example.com",
      cookie: null,
    });
  });

  it("resolves an internal identity only with the shared service secret", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
      officeSharedSecret: "a-shared-service-secret-that-is-long-enough",
      resolveIdentity: async (email) => ({
        name: "Jenny",
        email,
        githubAccountId: "123",
        githubLogin: "jenny",
        commitEmail: "123+jenny@users.noreply.github.com",
      }),
    });
    const gatewayUrl = await listen(gateway);

    const unauthorized = await fetch(`${gatewayUrl}/api/office/identity/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "jenny@example.com" }),
    });
    const authorized = await fetch(`${gatewayUrl}/api/office/identity/resolve`, {
      method: "POST",
      headers: {
        authorization: "Bearer a-shared-service-secret-that-is-long-enough",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "jenny@example.com" }),
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      githubLogin: "jenny",
      commitEmail: "123+jenny@users.noreply.github.com",
    });
  });

  it("renders the current account and linked GitHub identity", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => ({ name: "Jenny", email: "jenny@example.com" }),
      handleAuthRequest: (_request, response) => response.end(),
      githubLinkingEnabled: true,
      resolveIdentity: async (email) => ({
        name: "Jenny",
        email,
        githubAccountId: "123",
        githubLogin: "jenny",
        commitEmail: "123+jenny@users.noreply.github.com",
      }),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/auth/account`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("jenny@example.com");
    expect(html).toContain("@jenny");
  });

  it("renders a responsive Google login page without accepting an external return URL", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(
      `${gatewayUrl}/auth/login?returnTo=${encodeURIComponent("https://attacker.example")}`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("Sign in to Paseo");
    expect(html).toContain("Continue with Google");
    expect(html).toContain('data-return-to="/"');
    expect(html).not.toContain("attacker.example");
  });

  it("serves the bundled Inter variable font used by the login page", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/auth/assets/inter.woff2`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(10_000);
  });

  it("rejects an unauthenticated WebSocket upgrade", async () => {
    const upstream = createServer();
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const status = await getRejectedWebSocketStatus(gatewayUrl.replace("http", "ws") + "/ws");

    expect(status).toBe(401);
  });

  it("proxies an authenticated WebSocket without forwarding its session cookie", async () => {
    const upstream = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstream, path: "/ws" });
    upstreamWebSocket.on("connection", echoWebSocketIdentity);
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async (headers) =>
        headers.cookie === "session=valid"
          ? { email: "user@example.com", name: "Example User" }
          : null,
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const payload = await exchangeWebSocketMessage(gatewayUrl.replace("http", "ws") + "/ws", {
      cookie: "session=valid",
      origin: "https://paseo.example.com",
      "x-paseo-authenticated-user-email": "attacker@example.com",
    });

    expect(payload).toEqual({
      message: "hello",
      email: "user@example.com",
      cookie: null,
    });
    upstreamWebSocket.close();
  });

  it("rejects a cross-origin WebSocket even when the session is valid", async () => {
    const upstream = createServer();
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => ({ email: "user@example.com", name: "Example User" }),
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const status = await getRejectedWebSocketStatus(gatewayUrl.replace("http", "ws") + "/ws", {
      origin: "https://attacker.example",
    });

    expect(status).toBe(403);
  });

  it("fails closed when session validation is unavailable", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => {
        throw new Error("database unavailable");
      },
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/status`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Authentication service unavailable" });
  });

  it("rejects a cross-origin authenticated mutation", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end("paseo");
    });
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => ({ email: "user@example.com", name: "Example User" }),
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/api/action`, {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(upstreamRequests).toBe(0);
  });

  it("provides a same-origin sign-out page", async () => {
    const upstream = createServer((_request, response) => response.end("paseo"));
    const upstreamUrl = await listen(upstream);
    const gateway = createAuthGateway({
      upstreamUrl,
      publicUrl: "https://paseo.example.com",
      resolveSession: async () => ({ email: "user@example.com", name: "Example User" }),
      handleAuthRequest: (_request, response) => response.end(),
    });
    const gatewayUrl = await listen(gateway);

    const response = await fetch(`${gatewayUrl}/auth/logout`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("Signing out...");
    expect(html).toContain('fetch("/api/auth/sign-out"');
    expect(html).toContain('window.location.replace("/auth/login")');
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

async function getRejectedWebSocketStatus(
  url: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => reject(new Error("Expected WebSocket upgrade to be rejected")));
    socket.once("error", reject);
  });
}

async function exchangeWebSocketMessage(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => socket.send("hello"));
    socket.once("message", (message) => {
      socket.close();
      resolve(JSON.parse(message.toString()));
    });
    socket.once("error", reject);
  });
}

function echoWebSocketIdentity(socket: WebSocket, request: IncomingMessage): void {
  socket.on("message", (message) => {
    socket.send(
      JSON.stringify({
        message: message.toString(),
        email: request.headers["x-paseo-authenticated-user-email"],
        cookie: request.headers.cookie ?? null,
      }),
    );
  });
}
