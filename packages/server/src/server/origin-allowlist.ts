const REGEX_PREFIX = "regex:";
const REGEX_LITERAL_RE = /^\/(.+)\/([a-z]*)$/;

function compileOriginPattern(entry: string): RegExp | null {
  if (entry.startsWith(REGEX_PREFIX)) {
    const pattern = entry.slice(REGEX_PREFIX.length).trim();
    if (!pattern) return null;
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }

  const literal = REGEX_LITERAL_RE.exec(entry);
  if (!literal) return null;

  try {
    return new RegExp(literal[1], literal[2]);
  } catch {
    return null;
  }
}

export function isOriginAllowed(
  origin: string,
  allowedOrigins: ReadonlySet<string> | readonly string[],
): boolean {
  const entries = Array.isArray(allowedOrigins) ? allowedOrigins : Array.from(allowedOrigins);
  for (const entry of entries) {
    if (entry === "*" || entry === origin) {
      return true;
    }

    const regex = compileOriginPattern(entry);
    if (regex?.test(origin)) {
      return true;
    }
  }

  return false;
}
