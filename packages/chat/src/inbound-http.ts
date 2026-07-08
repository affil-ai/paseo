import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Chat } from "chat";

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function requestUrl(req: IncomingMessage, host: string): string {
  const proto = req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim() || "http";
  return `${proto}://${host}${req.url ?? "/"}`;
}

async function nodeRequestToFetchRequest(req: IncomingMessage, body: Buffer): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return new Request(requestUrl(req, host), {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

export function startInboundHttpServer(input: {
  chat: Chat;
  port: number;
  host?: string;
  slackWebhookEnabled?: boolean;
  emailWebhook?: (
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    requestUrl: string | undefined,
  ) => Promise<{ status: number; body: unknown }>;
  githubWebhook?: (
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<{ status: number; body: unknown }>;
}) {
  const slackWebhookEnabled = input.slackWebhookEnabled ?? true;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, service: "office-chat-bridge" }));
        return;
      }

      if (slackWebhookEnabled && req.method === "POST" && req.url?.startsWith("/slack/events")) {
        const body = await readBody(req);
        const request = await nodeRequestToFetchRequest(req, body);
        const response = await input.chat.webhooks.slack(request);
        await writeFetchResponse(res, response);
        return;
      }

      if (input.githubWebhook && req.method === "POST" && req.url?.startsWith("/github/webhook")) {
        const body = await readBody(req);
        const result = await input.githubWebhook(body, req.headers);
        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.body));
        return;
      }

      if (
        input.emailWebhook &&
        req.method === "POST" &&
        req.url?.startsWith("/support-email/resend")
      ) {
        // The Svix signature covers the exact raw bytes, so pass them through untouched.
        const body = (await readBody(req)).toString("utf8");
        const result = await input.emailWebhook(body, req.headers, req.url);
        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.body));
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    } catch (error) {
      console.error("HTTP bridge request failed", error);
      res.statusCode = 500;
      res.end("internal error");
    }
  });

  server.listen(input.port, input.host ?? "127.0.0.1");
  return server;
}
