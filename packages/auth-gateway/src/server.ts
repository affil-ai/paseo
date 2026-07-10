import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { sendLoginFont, sendLoginPage, sendLogoutPage } from "./login.js";

export interface AuthenticatedUser {
  email: string;
  name: string;
}

export interface AuthGatewayOptions {
  upstreamUrl: string;
  publicUrl: string;
  resolveSession(headers: IncomingMessage["headers"]): Promise<AuthenticatedUser | null>;
  handleAuthRequest(request: IncomingMessage, response: ServerResponse): unknown;
}

export function createAuthGateway(options: AuthGatewayOptions): Server {
  const proxy = httpProxy.createProxyServer({
    target: options.upstreamUrl,
    changeOrigin: false,
    xfwd: true,
    ws: true,
  });
  proxy.on("proxyRes", (proxyResponse) => {
    delete proxyResponse.headers["set-cookie"];
  });
  const server = createServer((request, response) => {
    void handleRequest(options, proxy, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "Authentication service unavailable" }));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(options, proxy, request, socket, head).catch(() => {
      rejectUpgrade(socket, 503, "Service Unavailable");
    });
  });
  return server;
}

async function handleRequest(
  options: AuthGatewayOptions,
  proxy: httpProxy,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", options.publicUrl);
  if (requestUrl.pathname === "/healthz") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/auth/login") {
    sendLoginPage(response, requestUrl.searchParams.get("returnTo"));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/auth/logout") {
    sendLogoutPage(response);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/auth/assets/inter.woff2") {
    sendLoginFont(response);
    return;
  }
  if (requestUrl.pathname.startsWith("/api/auth/")) {
    void Promise.resolve(options.handleAuthRequest(request, response)).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "Authentication service unavailable" }));
    });
    return;
  }
  if (isCrossOriginMutation(request, options.publicUrl)) {
    response.statusCode = 403;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  const user = await options.resolveSession(request.headers);
  if (user) {
    setUpstreamIdentity(request, user);
    proxy.web(request, response, {}, (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "Paseo is unavailable" }));
    });
    return;
  }

  if (!acceptsHtml(request)) {
    response.statusCode = 401;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const returnTo = requestUrl.pathname + requestUrl.search;
  response.statusCode = 302;
  response.setHeader("location", `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  response.end();
}

function acceptsHtml(request: IncomingMessage): boolean {
  return request.method === "GET" && request.headers.accept?.includes("text/html") === true;
}

function isCrossOriginMutation(request: IncomingMessage, publicUrl: string): boolean {
  const safeMethod =
    request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  if (safeMethod) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return true;
  const requestOrigin = request.headers.origin;
  return requestOrigin !== undefined && requestOrigin !== new URL(publicUrl).origin;
}

function setUpstreamIdentity(request: IncomingMessage, user: AuthenticatedUser): void {
  delete request.headers.authorization;
  delete request.headers.cookie;
  delete request.headers["x-paseo-authenticated-user-email"];
  delete request.headers["cf-access-authenticated-user-email"];
  request.headers["x-paseo-authenticated-user-email"] = user.email;
  request.headers["cf-access-authenticated-user-email"] = user.email;
}

async function handleUpgrade(
  options: AuthGatewayOptions,
  proxy: httpProxy,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const requestOrigin = request.headers.origin;
  const expectedOrigin = new URL(options.publicUrl).origin;
  if (requestOrigin && requestOrigin !== expectedOrigin) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }

  const user = await options.resolveSession(request.headers);
  if (!user) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  setUpstreamIdentity(request, user);
  proxy.ws(request, socket, head, {}, (error) => socket.destroy(error));
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
