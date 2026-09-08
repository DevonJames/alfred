import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BriefingPayload } from "./types.js";

export class BriefingCache {
  constructor(readonly dir: string) {}

  private fileFor(dayKey: string, includeLaunches = false): string {
    const suffix = includeLaunches ? "-launches" : "";
    return path.join(this.dir, `cache-${dayKey}${suffix}.json`);
  }

  async get(dayKey: string, includeLaunches = false): Promise<BriefingPayload | null> {
    try {
      const raw = await readFile(this.fileFor(dayKey, includeLaunches), "utf8");
      return JSON.parse(raw) as BriefingPayload;
    } catch {
      return null;
    }
  }

  async set(dayKey: string, payload: BriefingPayload, includeLaunches = false): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.fileFor(dayKey, includeLaunches),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }

  async invalidate(dayKey: string): Promise<void> {
    for (const includeLaunches of [false, true]) {
      try {
        await unlink(this.fileFor(dayKey, includeLaunches));
      } catch {
        /* missing is fine */
      }
    }
  }
}
