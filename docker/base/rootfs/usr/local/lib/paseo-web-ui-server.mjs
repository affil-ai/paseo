import { createReadStream, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const excludedPathPrefixes = ["/api/", "/mcp/", "/public/", "/ws/"];
const excludedPaths = new Set(["/api", "/mcp", "/public", "/ws"]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
};

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function isInsideDir(targetPath, dirPath) {
  const resolvedDir = path.resolve(dirPath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
}

function findDistDir() {
  const candidates = [
    process.env.PASEO_UI_DIST_DIR,
    "/usr/local/lib/node_modules/@getpaseo/server/dist/server/web-ui",
    "/home/paseo/.local/lib/node_modules/@getpaseo/server/dist/server/web-ui",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, "index.html");
    if (safeStat(indexPath)?.isFile()) {
      return path.resolve(candidate);
    }
  }
  throw new Error(`Unable to locate Paseo web UI dist directory. Tried: ${candidates.join(", ")}`);
}

function isProxyPath(requestPath) {
  for (const prefix of excludedPathPrefixes) {
    if (requestPath.startsWith(prefix)) return true;
  }
  return excludedPaths.has(requestPath);
}

function getRequestPath(req) {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function getContentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function selectEncoding(acceptEncoding) {
  if (!acceptEncoding) return null;
  const normalized = acceptEncoding.toLowerCase();
  if (normalized.includes("br")) return "br";
  if (normalized.includes("gzip")) return "gzip";
  return null;
}

function resolveContentEncoding(resolvedFile, acceptEncoding) {
  const encoding = selectEncoding(acceptEncoding);
  if (!encoding) return { finalFile: resolvedFile, contentEncoding: null };
  const compressedFile = `${resolvedFile}.${encoding === "br" ? "br" : "gz"}`;
  if (safeStat(compressedFile)?.isFile()) {
    return { finalFile: compressedFile, contentEncoding: encoding };
  }
  return { finalFile: resolvedFile, contentEncoding: null };
}

function isHashedAsset(filePath) {
  return /[-.][0-9a-f]{16,}[-.]/i.test(path.basename(filePath));
}

function setCacheHeaders(res, isIndexHtml, resolvedFile) {
  if (isIndexHtml) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else if (isHashedAsset(resolvedFile)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
}

function resolveTargetFile(distDir, requestPath) {
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath);

  if (safeStat(filePath)?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!safeStat(filePath)?.isFile()) {
    filePath = path.join(distDir, "index.html");
  }

  if (!safeStat(filePath)?.isFile() || !isInsideDir(filePath, distDir)) {
    return null;
  }

  const resolvedFile = path.resolve(filePath);
  return {
    resolvedFile,
    isIndexHtml: path.basename(resolvedFile).toLowerCase() === "index.html",
  };
}

function serializeInlineScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : "";
}

function readCloudflareAuthenticatedUserEmail(req) {
  const email = firstHeaderValue(req.headers["cf-access-authenticated-user-email"]).trim();
  return email.length > 0 ? email : null;
}

function hostHasExplicitPort(host) {
  if (host.startsWith("[")) return /\]:\d+$/.test(host);
  return /:\d+$/.test(host);
}

function buildInitialConnectionListen(host, useTls) {
  const trimmed = host.trim();
  if (!trimmed || hostHasExplicitPort(trimmed)) return trimmed;
  return `${trimmed}:${useTls ? 443 : 80}`;
}

function readForwardedProto(req) {
  const proto = firstHeaderValue(req.headers["x-forwarded-proto"]).split(",")[0]?.trim();
  return proto || "http";
}

function buildConnectionHint(req) {
  const configuredListen = process.env.PASEO_UI_INITIAL_DAEMON_CONNECTION?.trim();
  const configuredTls = process.env.PASEO_UI_INITIAL_DAEMON_TLS?.trim().toLowerCase();
  const forwardedProto = readForwardedProto(req);
  let useTls = forwardedProto === "https";
  if (configuredTls === "true" || configuredTls === "1") {
    useTls = true;
  } else if (configuredTls === "false" || configuredTls === "0") {
    useTls = false;
  }
  const host = configuredListen || firstHeaderValue(req.headers.host);
  const authenticatedUserEmail = readCloudflareAuthenticatedUserEmail(req);

  return {
    listen: configuredListen ? configuredListen : buildInitialConnectionListen(host, useTls),
    useTls,
    label: process.env.PASEO_UI_LABEL || "paseo",
    ...(authenticatedUserEmail ? { authenticatedUserEmail } : {}),
  };
}

function injectConnectionHint(html, req) {
  const script = `<script>window.__PASEO_INITIAL_DAEMON_CONNECTION__=${serializeInlineScriptJson(
    buildConnectionHint(req),
  )}</script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${script}</head>`);
  }
  return script + html;
}

function serveStatic(distDir, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  const target = resolveTargetFile(distDir, getRequestPath(req));
  if (!target) {
    res.writeHead(404);
    res.end();
    return;
  }

  const acceptEncoding = target.isIndexHtml
    ? undefined
    : firstHeaderValue(req.headers["accept-encoding"]);
  const { finalFile, contentEncoding } = resolveContentEncoding(
    target.resolvedFile,
    acceptEncoding,
  );
  res.setHeader("Content-Type", getContentType(target.resolvedFile));
  if (contentEncoding) {
    res.setHeader("Content-Encoding", contentEncoding);
    res.setHeader("Vary", "Accept-Encoding");
  }
  setCacheHeaders(res, target.isIndexHtml, target.resolvedFile);

  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (target.isIndexHtml) {
    res.writeHead(200);
    res.end(injectConnectionHint(readFileSync(finalFile, "utf8"), req));
    return;
  }

  res.writeHead(200);
  createReadStream(finalFile)
    .on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

function createProxyRequestOptions(target, req) {
  const headers = { ...req.headers, host: target.host };
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: req.url ?? "/",
    headers,
  };
}

function proxyHttp(target, req, res) {
  const client = target.protocol === "https:" ? https : http;
  const proxyReq = client.request(createProxyRequestOptions(target, req), (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (error) => {
    console.error("[paseo-ui] daemon proxy request failed", error);
    if (!res.headersSent) res.writeHead(502);
    res.end("bad gateway");
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(target, req, socket, head) {
  if (target.protocol !== "http:") {
    socket.destroy();
    return;
  }
  const port = Number(target.port || 80);
  const upstream = net.connect(port, target.hostname, () => {
    upstream.write(`${req.method} ${req.url ?? "/"} HTTP/${req.httpVersion}\r\n`);
    const headers = { ...req.headers, host: target.host };
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) upstream.write(`${key}: ${item}\r\n`);
      } else if (value !== undefined) {
        upstream.write(`${key}: ${value}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

const distDir = findDistDir();
const target = new URL(process.env.PASEO_UI_DAEMON_TARGET || "http://paseo-daemon:6767");
const host = process.env.PASEO_UI_HOST || "0.0.0.0";
const port = Number(process.env.PASEO_UI_PORT || 6767);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "paseo-web-ui" }));
    return;
  }

  if (isProxyPath(getRequestPath(req))) {
    proxyHttp(target, req, res);
    return;
  }

  serveStatic(distDir, req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxyUpgrade(target, req, socket, head);
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Paseo web UI proxy ready",
      listen: `${host}:${port}`,
      daemonTarget: target.toString(),
      distDir,
      script: fileURLToPath(import.meta.url),
    }),
  );
});
