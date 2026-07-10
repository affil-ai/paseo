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
    },
    account: {
      encryptOAuthTokens: true,
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
  };
}
