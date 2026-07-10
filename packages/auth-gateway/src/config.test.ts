import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("auth gateway config", () => {
  it("requires an explicit Google Workspace domain", () => {
    expect(() =>
      loadConfig({
        PASEO_AUTH_PUBLIC_URL: "https://paseo.example.com",
        PASEO_AUTH_UPSTREAM_URL: "http://paseo:6767",
        PASEO_AUTH_DATABASE_PATH: "/data/auth.sqlite",
        BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
      }),
    ).toThrowError(/PASEO_AUTH_GOOGLE_HOSTED_DOMAIN/);
  });

  it("rejects a non-HTTP Paseo upstream", () => {
    expect(() =>
      loadConfig({
        PASEO_AUTH_PUBLIC_URL: "https://paseo.example.com",
        PASEO_AUTH_UPSTREAM_URL: "file:///etc/passwd",
        PASEO_AUTH_DATABASE_PATH: "/data/auth.sqlite",
        PASEO_AUTH_GOOGLE_HOSTED_DOMAIN: "example.com",
        BETTER_AUTH_SECRET: "a-secure-secret-that-is-at-least-32-characters",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
      }),
    ).toThrowError(/PASEO_AUTH_UPSTREAM_URL/);
  });
});
