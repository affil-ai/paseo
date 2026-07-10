import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const interVariableFont = readFileSync(
  require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
);

export function sendLoginFont(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "font/woff2");
  response.setHeader("content-length", interVariableFont.byteLength);
  response.setHeader("cache-control", "public, max-age=31536000, immutable");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(interVariableFont);
}

export function sendLoginPage(response: ServerResponse, requestedReturnTo: string | null): void {
  const returnTo = normalizeReturnTo(requestedReturnTo);
  const nonce = randomBytes(18).toString("base64url");
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader(
    "content-security-policy",
    `default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(renderLoginPage({ nonce, returnTo }));
}

export function sendLogoutPage(response: ServerResponse): void {
  const nonce = randomBytes(18).toString("base64url");
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader(
    "content-security-policy",
    `default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Signing out of Paseo</title>
    <style>
      @font-face { font-family: "InterVariable"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/auth/assets/inter.woff2") format("woff2-variations"); }
      :root { color-scheme: light dark; font-family: InterVariable, Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-feature-settings: "cv02", "cv03", "cv04", "cv11", "ss01", "ss03"; -webkit-font-smoothing: antialiased; --canvas: #ffffff; --foreground: #1a1a1e; --muted: #71717a; --accent: #20744a; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; background: var(--canvas); color: var(--foreground); }
      main { isolation: isolate; min-height: 100dvh; display: grid; place-items: center; padding: 32px 24px; }
      section { width: min(100%, 320px); display: flex; min-width: 0; flex-direction: column; gap: 12px; }
      .wordmark { margin: 0; color: var(--accent); font-size: 14px; font-weight: 500; }
      h1 { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; text-wrap: balance; }
      p { margin: 0; color: var(--muted); font-size: 16px; line-height: 1.6; text-wrap: pretty; }
      a { color: var(--accent); }
      a:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
      @media (min-width: 640px) { main { padding: 48px 32px; } p { font-size: 14px; } }
      @media (prefers-color-scheme: dark) { :root { --canvas: #181b1a; --foreground: #fafafa; --muted: #a1a1aa; --accent: #329d68; } }
    </style>
  </head>
  <body>
    <main>
      <section aria-labelledby="logout-title">
        <p class="wordmark">Paseo</p>
        <h1 id="logout-title">Signing out...</h1>
        <p id="status">Your session is being closed.</p>
      </section>
    </main>
    <script nonce="${nonce}">
      fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" } })
        .then((response) => {
          if (!response.ok) throw new Error("Sign-out failed");
          window.location.replace("/auth/login");
        })
        .catch(() => {
          document.querySelector("h1").textContent = "Unable to sign out";
          document.querySelector("#status").innerHTML = 'Return to <a href="/">Paseo</a> and try again.';
        });
    </script>
  </body>
</html>`);
}

export function sendAccountPage(
  response: ServerResponse,
  user: { name: string; email: string },
  github: { login?: string } | null,
  githubLinkingEnabled: boolean,
): void {
  const nonce = randomBytes(18).toString("base64url");
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader(
    "content-security-policy",
    `default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  const status = github?.login
    ? `Connected as <strong>@${escapeHtml(github.login)}</strong>`
    : "No GitHub account connected";
  let action = "";
  if (!github?.login) {
    action = githubLinkingEnabled
      ? '<button type="button" id="github-link">Connect GitHub</button>'
      : '<p class="muted">GitHub linking is not configured.</p>';
  }
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paseo account</title><style>
@font-face{font-family:InterVariable;src:url('/auth/assets/inter.woff2')}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;font-family:InterVariable,system-ui;background:#fff;color:#1a1a1e}.card{width:min(100%,420px);display:grid;gap:20px}.wordmark{color:#20744a}h1,p{margin:0}.muted{color:#71717a}.identity{padding:16px;border:1px solid #e4e4e7;border-radius:12px;display:grid;gap:6px}button,a.button{display:inline-flex;justify-content:center;min-height:40px;align-items:center;border:0;border-radius:10px;padding:8px 14px;background:#20744a;color:#fff;text-decoration:none;font:inherit;cursor:pointer}.actions{display:flex;gap:12px;flex-wrap:wrap}@media(prefers-color-scheme:dark){body{background:#181b1a;color:#fafafa}.identity{border-color:#3f3f46}.muted{color:#a1a1aa}}
</style></head><body><main class="card"><p class="wordmark">Paseo</p><h1>Account</h1>
<section class="identity"><strong>${escapeHtml(user.name)}</strong><span class="muted">${escapeHtml(user.email)}</span></section>
<section class="identity"><strong>GitHub</strong><span>${status}</span>${action}</section>
<div class="actions"><a class="button" href="/">Back to Paseo</a><a href="/auth/logout">Sign out</a></div>
<p id="error" class="muted" role="alert"></p></main>
<script nonce="${nonce}">const button=document.querySelector('#github-link');button?.addEventListener('click',async()=>{button.disabled=true;const response=await fetch('/api/auth/link-social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'github',callbackURL:'/auth/account'})});const payload=await response.json();if(response.ok&&typeof payload.url==='string'){location.assign(payload.url);return}button.disabled=false;document.querySelector('#error').textContent='Unable to start GitHub linking.'});</script>
</body></html>`);
}

function normalizeReturnTo(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  const url = new URL(value, "https://paseo.invalid");
  return url.pathname + url.search + url.hash;
}

function renderLoginPage(options: { nonce: string; returnTo: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in to Paseo</title>
    <style>
      @font-face {
        font-family: "InterVariable";
        font-style: normal;
        font-weight: 100 900;
        font-display: swap;
        src: url("/auth/assets/inter.woff2") format("woff2-variations");
      }
      :root {
        color-scheme: light dark;
        font-family: InterVariable, Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-synthesis: none;
        font-feature-settings: "cv02", "cv03", "cv04", "cv11", "ss01", "ss03";
        -webkit-font-smoothing: antialiased;
        --canvas: #ffffff;
        --foreground: #1a1a1e;
        --muted: #71717a;
        --accent: #20744a;
        --accent-hover: #1b633f;
        --focus: #3b82f6;
        --error: #b42318;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100dvh;
        margin: 0;
        background: var(--canvas);
        color: var(--foreground);
      }
      main {
        isolation: isolate;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 32px 24px;
      }
      .login {
        width: min(100%, 320px);
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 24px;
      }
      .wordmark {
        margin: 0;
        color: var(--accent);
        font-size: 14px;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      .heading {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 8px;
      }
      h1 {
        max-width: 18ch;
        margin: 0;
        font-size: 30px;
        font-weight: 600;
        letter-spacing: -0.03em;
        text-wrap: balance;
      }
      .description {
        max-width: 42ch;
        margin: 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
        text-wrap: pretty;
      }
      .actions {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 12px;
      }
      button {
        min-height: 44px;
        width: 100%;
        border: 0;
        border-radius: 10px;
        padding: 10px 16px;
        background: var(--accent);
        color: #ffffff;
        cursor: pointer;
        font: inherit;
        font-size: 16px;
        font-weight: 400;
      }
      button:hover { background: var(--accent-hover); }
      button:focus-visible {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }
      button:disabled { cursor: wait; opacity: 0.5; }
      [role="alert"] {
        min-height: 24px;
        margin: 0;
        color: var(--error);
        font-size: 16px;
        line-height: 1.5;
        text-wrap: pretty;
      }
      @media (min-width: 640px) {
        main { padding: 48px 32px; }
        .description, button, [role="alert"] { font-size: 14px; }
        button { min-height: 36px; padding: 8px 12px; }
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --canvas: #181b1a;
          --foreground: #fafafa;
          --muted: #a1a1aa;
          --accent: #2b8a5b;
          --accent-hover: #329d68;
          --focus: #60a5fa;
          --error: #f97066;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="login" aria-labelledby="login-title">
        <p class="wordmark">Paseo</p>
        <div class="heading">
          <h1 id="login-title">Sign in to Paseo</h1>
          <p class="description">Use your organization’s Google account to continue.</p>
        </div>
        <div class="actions">
          <button type="button" data-return-to="${escapeHtml(options.returnTo)}">Continue with Google</button>
          <p role="alert" aria-live="polite"></p>
        </div>
      </section>
    </main>
    <script nonce="${options.nonce}">
      const button = document.querySelector("button[data-return-to]");
      const errorMessage = document.querySelector('[role="alert"]');
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Redirecting...";
        errorMessage.textContent = "";
        try {
          const response = await fetch("/api/auth/sign-in/social", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: "google", callbackURL: button.dataset.returnTo }),
          });
          const payload = await response.json();
          if (!response.ok || typeof payload.url !== "string") {
            throw new Error("Google sign-in did not return a redirect URL");
          }
          window.location.assign(payload.url);
        } catch {
          button.disabled = false;
          button.textContent = "Continue with Google";
          errorMessage.textContent = "Unable to start Google sign-in. Try again.";
        }
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
