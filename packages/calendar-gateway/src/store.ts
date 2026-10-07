import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyPolicy,
  isCalendarAccess,
  type CalendarGrant,
  type CalendarPolicy,
} from "./policy.js";

export async function loadCalendarPolicy(filePath: string): Promise<CalendarPolicy> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<CalendarPolicy>;
    const calendars: Record<string, CalendarGrant> = {};
    const entries = raw.calendars ?? {};
    for (const [id, grant] of Object.entries(entries)) {
      if (!grant || !isCalendarAccess(grant.access)) continue;
      calendars[id] = {
        access: grant.access,
        title: String(grant.title ?? ""),
        sourceIdentifier: String(grant.sourceIdentifier ?? ""),
        sourceTitle: String(grant.sourceTitle ?? ""),
        ignoreOverlaps: grant.ignoreOverlaps === true,
      };
    }
    return { version: 1, calendars };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyPolicy();
    throw err;
  }
}

export async function saveCalendarPolicy(filePath: string, policy: CalendarPolicy): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body: CalendarPolicy = { version: 1, calendars: policy.calendars };
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}
