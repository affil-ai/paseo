import { createSign } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import Database from "better-sqlite3";
import type { AuthGatewayConfig } from "./config.js";
import type { AuthenticatedUser } from "./server.js";

export interface AuthRuntime {
  close(): void;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  resolveSession(headers: IncomingMessage["headers"]): Promise<AuthenticatedUser | null>;
  resolveIdentity(email: string): Promise<OfficeIdentity | null>;
  getGitHubAppToken(): Promise<{ token: string; expiresAt: string }>;
  githubLinkingEnabled: boolean;
}

export interface OfficeIdentity {
  name: string;
  email: string;
  githubAccountId?: string;
  githubLogin?: string;
  commitEmail: string;
}

export async function createAuthRuntime(config: AuthGatewayConfig): Promise<AuthRuntime> {
  mkdirSync(dirname(config.PASEO_AUTH_DATABASE_PATH), { recursive: true });
  const database = new Database(config.PASEO_AUTH_DATABASE_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  const auth = betterAuth({
    appName: "Paseo",
    baseURL: config.PASEO_AUTH_PUBLIC_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [new URL(config.PASEO_AUTH_PUBLIC_URL).origin],
    socialProviders: {
      google: {
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        hd: config.PASEO_AUTH_GOOGLE_HOSTED_DOMAIN,
      },
      ...(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: config.GITHUB_CLIENT_ID,
              clientSecret: config.GITHUB_CLIENT_SECRET,
              disableSignUp: true,
            },
          }
        : {}),
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: ["google", "github"],
        allowDifferentEmails: true,
      },
    },
    session: {
      expiresIn: config.PASEO_AUTH_SESSION_HOURS * 60 * 60,
      disableSessionRefresh: true,
    },
    telemetry: {
      enabled: false,
    },
    advanced: {
      cookiePrefix: "paseo-auth",
    },
  });

  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const nodeHandler = toNodeHandler(auth);
  const githubLogins = new Map<string, string>();
  let installationToken: { token: string; expiresAt: string } | null = null;

  const resolveIdentity = async (email: string): Promise<OfficeIdentity | null> => {
    const row = database
      .prepare(
        `SELECT u.name, u.email, a.accountId AS githubAccountId
         FROM user u
         LEFT JOIN account a ON a.userId = u.id AND a.providerId = 'github'
         WHERE lower(u.email) = lower(?)
         LIMIT 1`,
      )
      .get(email) as { name: string; email: string; githubAccountId: string | null } | undefined;
    if (!row) return null;
    if (!row.githubAccountId) {
      return { name: row.name, email: row.email, commitEmail: "vivek@affil.ai" };
    }
    let githubLogin = githubLogins.get(row.githubAccountId);
    if (!githubLogin) {
      const response = await fetch(`https://api.github.com/user/${row.githubAccountId}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "office-of-the-cto",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const value = (await response.json()) as Record<string, unknown>;
        if (typeof value.login === "string") {
          githubLogin = value.login;
          githubLogins.set(row.githubAccountId, githubLogin);
        }
      }
    }
    return {
      name: row.name,
      email: row.email,
      githubAccountId: row.githubAccountId,
      ...(githubLogin ? { githubLogin } : {}),
      commitEmail: githubLogin
        ? `${row.githubAccountId}+${githubLogin}@users.noreply.github.com`
        : "vivek@affil.ai",
    };
  };

  return {
    close: () => database.close(),
    handleRequest: nodeHandler,
    resolveSession: async (headers) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!session) return null;
      return {
        email: session.user.email,
        name: session.user.name,
      };
    },
    resolveIdentity,
    githubLinkingEnabled: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
    getGitHubAppToken: async () => {
      if (installationToken && Date.parse(installationToken.expiresAt) > Date.now() + 60_000) {
        return installationToken;
      }
      if (
        !config.GITHUB_APP_ID ||
        !config.GITHUB_APP_INSTALLATION_ID ||
        !config.GITHUB_APP_PRIVATE_KEY
      ) {
        throw new Error("GitHub App installation credentials are not configured");
      }
      const jwt = createGitHubAppJwt(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY);
      const response = await fetch(
        `https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "user-agent": "office-of-the-cto",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub installation token request returned ${response.status}`);
      }
      const value = (await response.json()) as Record<string, unknown>;
      if (typeof value.token !== "string" || typeof value.expires_at !== "string") {
        throw new Error("GitHub installation token response was invalid");
      }
      installationToken = { token: value.token, expiresAt: value.expires_at };
      return installationToken;
    },
  };
}

function createGitHubAppJwt(appId: string, encodedPrivateKey: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const privateKey = encodedPrivateKey.includes("BEGIN")
    ? encodedPrivateKey.replace(/\\n/g, "\n")
    : Buffer.from(encodedPrivateKey, "base64").toString("utf8");
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
