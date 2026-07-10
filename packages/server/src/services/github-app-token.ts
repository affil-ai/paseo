let cached: { token: string; expiresAt: number } | null = null;

export async function getConfiguredGitHubAppToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const url = env.PASEO_GITHUB_APP_TOKEN_URL;
  const secret = env.PASEO_GITHUB_APP_TOKEN_SECRET;
  if (!url || !secret) return null;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`GitHub App token broker returned ${response.status}`);
  const value = (await response.json()) as Record<string, unknown>;
  if (typeof value.token !== "string") {
    throw new Error("GitHub App token broker returned an invalid token response");
  }
  const parsedExpiry =
    typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  cached = {
    token: value.token,
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 50 * 60_000,
  };
  return cached.token;
}
