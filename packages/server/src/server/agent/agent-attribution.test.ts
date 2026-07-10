import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAttributionService } from "./agent-attribution.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AgentAttributionService", () => {
  it("authors as the office bot and appends the active human as co-author", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-attribution-"));
    directories.push(directory);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PASEO_ATTRIBUTION_DEFAULT_EMAIL: "vivek@affil.ai",
      PASEO_GITHUB_APP_TOKEN_URL: "https://gateway.example.test/api/office/github/token",
      PASEO_GITHUB_APP_TOKEN_SECRET: "a-shared-service-secret-that-is-long-enough",
    };
    const service = new AgentAttributionService({
      paseoHome: join(directory, "home"),
      logger: pino({ enabled: false }),
      env,
    });
    await service.initialize();
    await service.setForAgent("agent-one", {
      source: "slack",
      userId: "U123",
      name: "Jenny Example",
      email: "jenny@example.com",
    });

    const repo = join(directory, "repo");
    await execFileAsync("git", ["init", repo], { env });
    await writeFile(join(repo, "page.txt"), "new page\n");
    const commitEnv = { ...env, ...service.getLaunchEnvironment("agent-one") };
    await execFileAsync("git", ["add", "page.txt"], { cwd: repo, env: commitEnv });
    await execFileAsync("git", ["commit", "-m", "Build page"], { cwd: repo, env: commitEnv });

    const { stdout: message } = await execFileAsync("git", ["log", "-1", "--format=%B"], {
      cwd: repo,
      env: commitEnv,
    });
    const { stdout: author } = await execFileAsync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: repo,
      env: commitEnv,
    });
    expect(message).toContain("Co-authored-by: Jenny Example <vivek@affil.ai>");
    expect(author.trim()).toBe(
      "office-of-the-cto[bot] <office-of-the-cto[bot]@users.noreply.github.com>",
    );
  });

  it("inherits the initiating human when an office agent creates a child agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-attribution-"));
    directories.push(directory);
    const service = new AgentAttributionService({
      paseoHome: join(directory, "home"),
      logger: pino({ enabled: false }),
      env: { ...process.env },
    });
    await service.initialize();
    await service.setForAgent("parent", {
      source: "paseo",
      name: "Vivek",
      email: "vivek@affil.ai",
      commitEmail: "123+volumbe@users.noreply.github.com",
    });
    await service.inheritForChild("parent", "child");

    const inherited = JSON.parse(
      await readFile(service.getLaunchEnvironment("child").PASEO_AGENT_ATTRIBUTION_FILE, "utf8"),
    ) as Record<string, unknown>;
    expect(inherited).toMatchObject({
      name: "Vivek",
      commitEmail: "123+volumbe@users.noreply.github.com",
    });
  });
});
