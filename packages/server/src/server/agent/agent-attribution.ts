import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { MessageAttribution } from "@getpaseo/protocol/agent-types";
import type { Logger } from "pino";

interface ResolvedAttribution extends MessageAttribution {
  commitEmail: string;
}

export interface AgentAttributionServiceOptions {
  paseoHome: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

export class AgentAttributionService {
  private readonly attributionDir: string;
  private readonly hooksDir: string;
  private readonly binDir: string;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: AgentAttributionServiceOptions) {
    this.attributionDir = join(options.paseoHome, "attribution", "agents");
    this.hooksDir = join(options.paseoHome, "attribution", "git-hooks");
    this.binDir = join(options.paseoHome, "attribution", "bin");
    this.logger = options.logger.child({ module: "agent-attribution" });
    this.env = options.env ?? process.env;
  }

  async initialize(): Promise<void> {
    await mkdir(this.attributionDir, { recursive: true });
    await mkdir(this.hooksDir, { recursive: true });
    await mkdir(this.binDir, { recursive: true });
    await this.writeExecutable(join(this.hooksDir, "commit-msg"), COMMIT_MESSAGE_HOOK);
    await this.writeExecutable(join(this.binDir, "gh"), GITHUB_CLI_WRAPPER);

    const entries: Array<[string, string]> = [
      ["core.hooksPath", this.hooksDir],
      ["commit.gpgsign", "false"],
    ];

    if (this.env.PASEO_GITHUB_APP_TOKEN_URL && this.env.PASEO_GITHUB_APP_TOKEN_SECRET) {
      const helperPath = join(this.hooksDir, "github-credential");
      await this.writeExecutable(helperPath, GITHUB_CREDENTIAL_HELPER);
      entries.push(["user.name", this.env.PASEO_GITHUB_BOT_NAME ?? "office-of-the-cto[bot]"]);
      entries.push([
        "user.email",
        this.env.PASEO_GITHUB_BOT_EMAIL ?? "office-of-the-cto[bot]@users.noreply.github.com",
      ]);
      entries.push(["credential.https://github.com.helper", helperPath]);
    }
    appendGitConfigEnvironment(this.env, entries);
  }

  getLaunchEnvironment(agentId: string): Record<string, string> {
    return {
      PASEO_AGENT_ATTRIBUTION_FILE: this.fileForAgent(agentId),
      PATH: `${this.binDir}${delimiter}${this.env.PATH ?? ""}`,
    };
  }

  async setForAgent(agentId: string, attribution: MessageAttribution): Promise<void> {
    const resolved = await this.resolve(attribution);
    await this.writeAgentFile(agentId, resolved);
  }

  async inheritForChild(parentAgentId: string, childAgentId: string): Promise<void> {
    const parentPath = this.fileForAgent(parentAgentId);
    const contents = await readFile(parentPath, "utf8").catch(() => null);
    if (!contents) return;
    await this.writeAtomically(this.fileForAgent(childAgentId), contents);
  }

  private async resolve(attribution: MessageAttribution): Promise<ResolvedAttribution> {
    const remote = await this.resolveRemote(attribution.email).catch((error) => {
      this.logger.warn({ err: error, email: attribution.email }, "Identity resolution failed");
      return null;
    });
    return {
      ...attribution,
      ...(remote?.githubLogin ? { githubLogin: remote.githubLogin } : {}),
      ...(remote?.githubAccountId ? { githubAccountId: remote.githubAccountId } : {}),
      commitEmail:
        attribution.commitEmail ??
        remote?.commitEmail ??
        this.env.PASEO_ATTRIBUTION_DEFAULT_EMAIL ??
        "vivek@affil.ai",
    };
  }

  private async resolveRemote(email: string | undefined): Promise<{
    githubLogin?: string;
    githubAccountId?: string;
    commitEmail?: string;
  } | null> {
    const url = this.env.PASEO_IDENTITY_RESOLVER_URL;
    const secret = this.env.PASEO_IDENTITY_RESOLVER_SECRET;
    if (!email || !url || !secret) return null;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Identity resolver returned ${response.status}`);
    }
    const value = (await response.json()) as Record<string, unknown>;
    return {
      ...(typeof value.githubLogin === "string" ? { githubLogin: value.githubLogin } : {}),
      ...(typeof value.githubAccountId === "string"
        ? { githubAccountId: value.githubAccountId }
        : {}),
      ...(typeof value.commitEmail === "string" ? { commitEmail: value.commitEmail } : {}),
    };
  }

  private async writeAgentFile(agentId: string, attribution: ResolvedAttribution): Promise<void> {
    const safe = {
      ...attribution,
      name: singleLine(attribution.name),
      commitEmail: singleLine(attribution.commitEmail),
    };
    await this.writeAtomically(this.fileForAgent(agentId), `${JSON.stringify(safe)}\n`);
  }

  private fileForAgent(agentId: string): string {
    return join(this.attributionDir, `${agentId}.json`);
  }

  private async writeAtomically(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, path);
  }

  private async writeExecutable(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, { mode: 0o700 });
    await chmod(path, 0o700);
  }
}

function singleLine(value: string): string {
  return value.replace(/[\r\n<>]/g, " ").trim();
}

function appendGitConfigEnvironment(
  env: NodeJS.ProcessEnv,
  entries: Array<[string, string]>,
): void {
  const startingIndex = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  entries.forEach(([key, value], offset) => {
    const index = startingIndex + offset;
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(startingIndex + entries.length);
}

const COMMIT_MESSAGE_HOOK = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const attributionPath = process.env.PASEO_AGENT_ATTRIBUTION_FILE;
const messagePath = process.argv[2];
if (attributionPath && messagePath) {
  try {
    const attribution = JSON.parse(readFileSync(attributionPath, "utf8"));
    const name = String(attribution.name ?? "").replace(/[\\r\\n<>]/g, " ").trim();
    const email = String(attribution.commitEmail ?? "").replace(/[\\r\\n<>]/g, " ").trim();
    if (name && email) {
      const trailer = \`Co-authored-by: \${name} <\${email}>\`;
      const message = readFileSync(messagePath, "utf8").trimEnd();
      if (!message.includes(trailer)) writeFileSync(messagePath, \`\${message}\\n\\n\${trailer}\\n\`);
    }
  } catch {}
}
`;

const GITHUB_CREDENTIAL_HELPER = `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.argv[2] === "get" && input.includes("host=github.com")) {
  const url = process.env.PASEO_GITHUB_APP_TOKEN_URL;
  const secret = process.env.PASEO_GITHUB_APP_TOKEN_SECRET;
  if (url && secret) {
    const response = await fetch(url, { headers: { authorization: \`Bearer \${secret}\` } });
    if (response.ok) {
      const value = await response.json();
      if (typeof value.token === "string") {
        process.stdout.write(\`username=x-access-token\\npassword=\${value.token}\\n\\n\`);
      }
    }
  }
}
`;

const GITHUB_CLI_WRAPPER = `#!/usr/bin/env node
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const wrapperDir = dirname(process.argv[1]);
const searchPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && entry !== wrapperDir);
let realGh = "";
for (const directory of searchPath) {
  const candidate = join(directory, process.platform === "win32" ? "gh.exe" : "gh");
  try { accessSync(candidate, constants.X_OK); realGh = candidate; break; } catch {}
}
if (!realGh) { process.stderr.write("gh executable not found\\n"); process.exit(127); }
const url = process.env.PASEO_GITHUB_APP_TOKEN_URL;
const secret = process.env.PASEO_GITHUB_APP_TOKEN_SECRET;
let token = "";
if (url && secret) {
  const response = await fetch(url, { headers: { authorization: \`Bearer \${secret}\` } });
  if (response.ok) {
    const value = await response.json();
    if (typeof value.token === "string") token = value.token;
  }
}
const result = spawnSync(realGh, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
