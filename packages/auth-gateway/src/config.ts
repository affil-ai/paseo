import { z } from "zod";

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Must be an HTTP or HTTPS URL");

const AuthGatewayConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  PASEO_AUTH_PUBLIC_URL: HttpUrlSchema,
  PASEO_AUTH_UPSTREAM_URL: HttpUrlSchema,
  PASEO_AUTH_DATABASE_PATH: z.string().min(1).default("/data/auth.sqlite"),
  PASEO_AUTH_GOOGLE_HOSTED_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  PASEO_OFFICE_SHARED_SECRET: z.string().min(32).optional(),
  PASEO_AUTH_SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
});

export type AuthGatewayConfig = z.infer<typeof AuthGatewayConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AuthGatewayConfig {
  return AuthGatewayConfigSchema.parse(env);
}
