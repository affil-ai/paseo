import { promises as fs } from "node:fs";
import path from "node:path";

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export class JsonFileStore<T> {
  private value: T | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly fallback: T,
    private readonly parse: (value: unknown) => T,
  ) {}

  async load(): Promise<T> {
    if (this.value) return this.value;
    const raw = await readJsonFile<unknown>(this.filePath, this.fallback);
    this.value = this.parse(raw);
    return this.value;
  }

  async update(mutator: (value: T) => void | T | Promise<void | T>): Promise<T> {
    const run = async () => {
      const current = await this.load();
      const next = (await mutator(current)) ?? current;
      this.value = next;
      await writeJsonFileAtomic(this.filePath, next);
      return next;
    };
    const nextWrite = this.writeQueue.then(run, run);
    this.writeQueue = nextWrite.then(
      () => undefined,
      () => undefined,
    );
    return nextWrite;
  }
}
