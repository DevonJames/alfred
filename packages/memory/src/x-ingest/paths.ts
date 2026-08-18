import path from "node:path";
import { resolveRepoRoot } from "../local-provider.js";

export function defaultXIngestDir(profileId: string): string {
  const fromEnv = process.env.ALFRED_X_INGEST_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(resolveRepoRoot(), "data", "memory", profileId, "ingest");
}

export function defaultXSourcesPath(profileId: string): string {
  return path.join(defaultXIngestDir(profileId), "x-sources.json");
}

export function defaultXLedgerPath(profileId: string): string {
  return path.join(defaultXIngestDir(profileId), "x-ledger.jsonl");
}

export function defaultXIngestDigestPath(profileId: string, dayKey: string, dir?: string): string {
  const base =
    dir ??
    (process.env.BRIEFING_CACHE_DIR?.trim()
      ? path.resolve(process.env.BRIEFING_CACHE_DIR)
      : path.join(resolveRepoRoot(), "data", "briefing", profileId));
  return path.join(base, `x-ingest-${dayKey}.json`);
}

export function defaultBriefingCacheFile(profileId: string, dayKey: string, dir?: string): string {
  const base =
    dir ??
    (process.env.BRIEFING_CACHE_DIR?.trim()
      ? path.resolve(process.env.BRIEFING_CACHE_DIR)
      : path.join(resolveRepoRoot(), "data", "briefing", profileId));
  return path.join(base, `cache-${dayKey}.json`);
}

/** Briefing-day key (rolls at BRIEFING_DAY_START, default 04:30 local). */
export function ingestDayKey(now: Date, timezone?: string, dayStart?: string): string {
  const tz = timezone ?? process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  const start = dayStart ?? process.env.BRIEFING_DAY_START ?? "04:30";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const [sh, sm] = start.split(":").map(Number);
  const startMins = (sh ?? 4) * 60 + (sm ?? 30);
  let y = year;
  let m = month;
  let d = day;
  if (hour * 60 + minute < startMins) {
    const dt = new Date(Date.UTC(year, month - 1, day - 1, 12, 0, 0));
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
