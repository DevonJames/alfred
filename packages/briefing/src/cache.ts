import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BriefingPayload } from "./types.js";

export class BriefingCache {
  constructor(readonly dir: string) {}

  private fileFor(dayKey: string): string {
    return path.join(this.dir, `cache-${dayKey}.json`);
  }

  async get(dayKey: string): Promise<BriefingPayload | null> {
    try {
      const raw = await readFile(this.fileFor(dayKey), "utf8");
      return JSON.parse(raw) as BriefingPayload;
    } catch {
      return null;
    }
  }

  async set(dayKey: string, payload: BriefingPayload): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(dayKey), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
