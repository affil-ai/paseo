import { describe, expect, test } from "vitest";

import { isOriginAllowed } from "./origin-allowlist.js";

describe("isOriginAllowed", () => {
  test("accepts exact origins", () => {
    expect(isOriginAllowed("https://app.example.com", ["https://app.example.com"])).toBe(true);
    expect(isOriginAllowed("https://admin.example.com", ["https://app.example.com"])).toBe(false);
  });

  test("accepts global wildcard", () => {
    expect(isOriginAllowed("https://anything.example.com", ["*"])).toBe(true);
  });

  test("accepts regex prefix entries", () => {
    const allowed = ["regex:^https://[a-z0-9-]+\\.example\\.com$"];

    expect(isOriginAllowed("https://app--local-only-mcp-gateway--paseo.example.com", allowed)).toBe(
      true,
    );
    expect(isOriginAllowed("http://app--local-only-mcp-gateway--paseo.example.com", allowed)).toBe(
      false,
    );
    expect(isOriginAllowed("https://admin.example.com.evil.test", allowed)).toBe(false);
  });

  test("accepts slash-delimited regex entries", () => {
    const allowed = ["/^https:\\/\\/[a-z0-9-]+\\.example\\.com$/"];

    expect(isOriginAllowed("https://app--local-only-mcp-gateway--paseo.example.com", allowed)).toBe(
      true,
    );
  });

  test("ignores invalid regex entries", () => {
    expect(isOriginAllowed("https://app.example.com", ["regex:["])).toBe(false);
  });
});
