/**
 * Medicine schedule, bottle photos, and the daily taken log.
 * Files live beside briefing prefs. Photos are not written into memory.
 */
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defaultBriefingDataDir } from "@alfred/memory";
import { getBriefingDayKey } from "./day.js";
import {
  applyMedicineLog,
  emptyMedicineLog,
  isMedicineLogMode,
  isMedicinePeriod,
  patchMedicineItem,
  scheduleView,
  untakenMorningItems,
  type MedicineDayLog,
  type MedicineDays,
  type MedicineItem,
  type MedicineItemPatch,
  type MedicineLogRequest,
  type MedicineScheduleViewItem,
} from "./medicine.js";

const LOG_KEEP_DAYS = 21;
const IMAGE_EXTS: Array<[string, string]> = [
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
];

export class MedicineStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MedicineStoreOpts {
  dir?: string;
  profileId?: string;
}

interface ScheduleFile {
  items: MedicineItem[];
}

interface LogFile {
  days: Record<string, MedicineDayLog["entries"]>;
}

export function medicineDir(opts?: MedicineStoreOpts): string {
  if (opts?.dir?.trim()) return path.resolve(opts.dir);
  const profileId = opts?.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  return defaultBriefingDataDir(profileId);
}

export async function readMedicineSchedule(opts?: MedicineStoreOpts): Promise<MedicineItem[]> {
  try {
    const raw = await readFile(schedulePath(opts), "utf8");
    const parsed = JSON.parse(raw) as ScheduleFile;
    return Array.isArray(parsed.items) ? parsed.items.filter(isMedicineItem) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readMedicineDayLog(dayKey: string, opts?: MedicineStoreOpts): Promise<MedicineDayLog> {
  const file = await readLogFile(opts);
  const entries = file.days[dayKey];
  if (!Array.isArray(entries)) return emptyMedicineLog(dayKey);
  return {
    date: dayKey,
    entries: entries.filter(
      (entry) => entry && typeof entry.itemId === "string" && entry.taken === true,
    ),
  };
}

export async function loadUntakenMorningMedicine(
  now: Date,
  timezone: string,
  dayStart = "04:30",
  opts?: MedicineStoreOpts,
): Promise<MedicineItem[]> {
  const dayKey = getBriefingDayKey(now, timezone, dayStart);
  const [items, log] = await Promise.all([
    readMedicineSchedule(opts),
    readMedicineDayLog(dayKey, opts),
  ]);
  return untakenMorningItems(items, log, dayKey);
}

export async function medicineScheduleView(
  now: Date,
  timezone: string,
  dayStart = "04:30",
  opts?: MedicineStoreOpts,
): Promise<{ dayKey: string; items: MedicineScheduleViewItem[] }> {
  const dayKey = getBriefingDayKey(now, timezone, dayStart);
  const [items, log] = await Promise.all([
    readMedicineSchedule(opts),
    readMedicineDayLog(dayKey, opts),
  ]);
  return { dayKey, items: scheduleView(items, log, dayKey) };
}

export async function saveMedicineSchedule(
  items: MedicineItem[],
  opts?: MedicineStoreOpts,
): Promise<void> {
  await writeJson(schedulePath(opts), { items });
}

export async function saveMedicineImage(
  bytes: Buffer,
  mimeType: string,
  opts?: MedicineStoreOpts,
): Promise<string> {
  const ext = extForMime(mimeType);
  const id = randomBytes(9).toString("hex");
  const dir = path.join(medicineDir(opts), "medicine-images");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.${ext}`), bytes);
  return id;
}

export async function readMedicineImage(
  id: string,
  opts?: MedicineStoreOpts,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!/^[a-f0-9]{18}$/.test(id)) return null;
  const dir = path.join(medicineDir(opts), "medicine-images");
  for (const [ext, mimeType] of IMAGE_EXTS) {
    const file = path.join(dir, `${id}.${ext}`);
    try {
      await stat(file);
      return { bytes: await readFile(file), mimeType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

export async function updateMedicineItem(
  id: string,
  patch: MedicineItemPatch,
  opts?: MedicineStoreOpts,
): Promise<MedicineItem> {
  const items = await readMedicineSchedule(opts);
  const index = items.findIndex((item) => item.id === id);
  const current = items[index];
  if (!current) throw new MedicineStoreError(404, "Item not found");
  if (patch.period && !isMedicinePeriod(patch.period)) {
    throw new MedicineStoreError(400, "Invalid period");
  }
  let next: MedicineItem;
  try {
    next = patchMedicineItem(current, { ...patch, days: patch.days ? normalizeDays(patch.days) : patch.days });
  } catch (err) {
    throw new MedicineStoreError(400, err instanceof Error ? err.message : "Invalid item");
  }
  items[index] = next;
  await saveMedicineSchedule(items, opts);
  return next;
}

export async function deleteMedicineItem(id: string, opts?: MedicineStoreOpts): Promise<void> {
  const items = await readMedicineSchedule(opts);
  const current = items.find((item) => item.id === id);
  if (!current) throw new MedicineStoreError(404, "Item not found");
  const next = items.filter((item) => item.id !== id);
  await saveMedicineSchedule(next, opts);
  if (current.imageId && !next.some((item) => item.imageId === current.imageId)) {
    await deleteMedicineImage(current.imageId, opts);
  }
}

export async function storeMedicineLog(
  request: MedicineLogRequest,
  now: Date,
  timezone: string,
  dayStart = "04:30",
  opts?: MedicineStoreOpts,
): Promise<{ speech: string; dayKey: string; items: MedicineScheduleViewItem[] }> {
  if (!isMedicineLogMode(request.mode)) throw new MedicineStoreError(400, "Invalid mode");
  if (request.period && !isMedicinePeriod(request.period)) {
    throw new MedicineStoreError(400, "Invalid period");
  }
  const dayKey = getBriefingDayKey(now, timezone, dayStart);
  const items = await readMedicineSchedule(opts);
  const log = await readMedicineDayLog(dayKey, opts);
  const result = applyMedicineLog(items, log, request, dayKey);
  if (result.changed) await writeDayLog(result.log, opts);
  return { speech: result.speech, dayKey, items: scheduleView(items, result.log, dayKey) };
}

async function writeDayLog(log: MedicineDayLog, opts?: MedicineStoreOpts): Promise<void> {
  const file = await readLogFile(opts);
  file.days[log.date] = log.entries;
  const keys = Object.keys(file.days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - LOG_KEEP_DAYS))) {
    delete file.days[key];
  }
  await writeJson(logPath(opts), file);
}

async function readLogFile(opts?: MedicineStoreOpts): Promise<LogFile> {
  try {
    const raw = await readFile(logPath(opts), "utf8");
    const parsed = JSON.parse(raw) as LogFile;
    return parsed?.days && typeof parsed.days === "object" ? parsed : { days: {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { days: {} };
    throw err;
  }
}

async function deleteMedicineImage(id: string, opts?: MedicineStoreOpts): Promise<void> {
  if (!/^[a-f0-9]{18}$/.test(id)) return;
  const dir = path.join(medicineDir(opts), "medicine-images");
  for (const [ext] of IMAGE_EXTS) {
    await unlink(path.join(dir, `${id}.${ext}`)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

function schedulePath(opts?: MedicineStoreOpts): string {
  return path.join(medicineDir(opts), "medicine-schedule.json");
}

function logPath(opts?: MedicineStoreOpts): string {
  return path.join(medicineDir(opts), "medicine-log.json");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function extForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

function normalizeDays(days: MedicineDays): MedicineDays {
  if (days === "daily" || !Array.isArray(days)) return "daily";
  const next = [...new Set(days.filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
  if (!next.length || next.length === 7) return "daily";
  return next;
}

function isMedicineItem(value: unknown): value is MedicineItem {
  if (!value || typeof value !== "object") return false;
  const item = value as MedicineItem;
  return typeof item.id === "string" && typeof item.name === "string" && isMedicinePeriod(item.period);
}
