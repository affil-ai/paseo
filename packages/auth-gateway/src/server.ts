import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { sendAccountPage, sendLoginFont, sendLoginPage, sendLogoutPage } from "./login.js";
import type { OfficeIdentity } from "./auth.js";

export interface AuthenticatedUser {
  email: string;
  name: string;
}

export interface AuthGatewayOptions {
  upstreamUrl: string;
  publicUrl: string;
  resolveSession(headers: IncomingMessage["headers"]): Promise<AuthenticatedUser | null>;
  handleAuthRequest(request: IncomingMessage, response: ServerResponse): unknown;
  resolveIdentity?(email: string): Promise<OfficeIdentity | null>;
  getGitHubAppToken?(): Promise<{ token: string; expiresAt: string }>;
  githubLinkingEnabled?: boolean;
  officeSharedSecret?: string;
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
  if (await handleGatewayPage(options, request, response, requestUrl)) return;
  if (handleBetterAuthApi(options, request, response, requestUrl)) return;
  if (await handleOfficeApi(options, request, response, requestUrl)) return;
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

async function handleGatewayPage(
  options: AuthGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<boolean> {
  if (requestUrl.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return true;
  }
  if (request.method !== "GET") return false;
  if (requestUrl.pathname === "/auth/login") {
    sendLoginPage(response, requestUrl.searchParams.get("returnTo"));
    return true;
  }
  if (requestUrl.pathname === "/auth/logout") {
    sendLogoutPage(response);
    return true;
  }
  if (requestUrl.pathname === "/auth/assets/inter.woff2") {
    sendLoginFont(response);
    return true;
  }
  if (requestUrl.pathname !== "/auth/account") return false;
  const user = await options.resolveSession(request.headers);
  if (!user) {
    response.statusCode = 302;
    response.setHeader("location", "/auth/login?returnTo=%2Fauth%2Faccount");
    response.end();
    return true;
  }
  const identity = await options.resolveIdentity?.(user.email);
  sendAccountPage(
    response,
    user,
    identity?.githubLogin ? { login: identity.githubLogin } : null,
    options.githubLinkingEnabled === true,
  );
  return true;
}

function handleBetterAuthApi(
  options: AuthGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): boolean {
  if (!requestUrl.pathname.startsWith("/api/auth/")) return false;
  void Promise.resolve(options.handleAuthRequest(request, response)).catch((error: unknown) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    sendJson(response, 500, { error: "Authentication service unavailable" });
  });
  return true;
}

async function handleOfficeApi(
  options: AuthGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<boolean> {
  const isIdentityRequest =
    requestUrl.pathname === "/api/office/identity/resolve" && request.method === "POST";
  const isTokenRequest =
    requestUrl.pathname === "/api/office/github/token" && request.method === "GET";
  if (!isIdentityRequest && !isTokenRequest) return false;
  if (!isOfficeAuthorized(request, options.officeSharedSecret)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return true;
  }
  if (isTokenRequest) {
    const token = await options.getGitHubAppToken?.();
    sendJson(response, token ? 200 : 503, token ?? { error: "GitHub App is not configured" });
    return true;
  }
  const body = await readJsonBody(request);
  const email = typeof body.email === "string" ? body.email : "";
  const identity = email ? await options.resolveIdentity?.(email) : null;
  sendJson(response, identity ? 200 : 404, identity ?? { error: "Identity not found" });
  return true;
}

function isOfficeAuthorized(request: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return false;
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
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
  delete request.headers["x-paseo-authenticated-user-name-b64"];
  delete request.headers["cf-access-authenticated-user-email"];
  request.headers["x-paseo-authenticated-user-email"] = user.email;
  request.headers["x-paseo-authenticated-user-name-b64"] = Buffer.from(user.name, "utf8").toString(
    "base64url",
  );
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
