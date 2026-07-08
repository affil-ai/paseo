import http from "node:http";

function portFromListen(listen) {
  const match = String(listen ?? "").match(/:(\d+)$/);
  return match ? Number(match[1]) : 6767;
}

function requestOk({ port, path }) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, timeout: 4000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

const candidates = [
  { port: portFromListen(process.env.PASEO_LISTEN), path: "/api/health" },
  { port: Number(process.env.PASEO_UI_PORT ?? 6767), path: "/healthz" },
  { port: Number(process.env.PASEO_CHAT_HTTP_PORT ?? 8787), path: "/health" },
  { port: Number(process.env.PASEO_CHAT_SERVICE_PORT ?? 8788), path: "/health" },
];

for (const candidate of candidates) {
  if (await requestOk(candidate)) {
    process.exit(0);
  }
}

process.exit(1);
