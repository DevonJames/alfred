/**
 * Shared medicine schedule HTTP logic for local /medicine UI and /api/medicine.
 */
import {
  MedicineStoreError,
  attachDraftImages,
  deleteMedicineItem,
  isMedicineLogMode,
  isMedicinePeriod,
  loadBriefingConfig,
  medicineScheduleView,
  mergeMedicineItems,
  mergeSummary,
  readMedicineImage,
  readMedicineSchedule,
  saveMedicineImage,
  saveMedicineSchedule,
  storeMedicineLog,
  updateMedicineItem,
  type MedicineDays,
  type MedicineItemPatch,
  type MedicineLogRequest,
  type MedicinePeriod,
  type MedicineScheduleViewItem,
} from "@alfred/briefing";
import { isPhotoFilename, photoMimeFromFilename, preparePhotoForVision } from "@alfred/memory";
import { randomUUID } from "node:crypto";
import { MedicineLlmError, draftMedicineItems } from "./medicine-llm.js";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PLAN_CHARS = 8_000;

export function medicineProfileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

export function medicineStoreOpts() {
  return { profileId: medicineProfileId() };
}

export function medicineClock() {
  const config = loadBriefingConfig({ profileId: medicineProfileId() });
  return {
    now: new Date(),
    timezone: config.timezone,
    dayStart: config.dayStart,
    opts: medicineStoreOpts(),
  };
}

export async function medicineSchedulePayload(): Promise<{
  dayKey: string;
  items: MedicineScheduleViewItem[];
}> {
  const { now, timezone, dayStart, opts } = medicineClock();
  return medicineScheduleView(now, timezone, dayStart, opts);
}

export async function medicineImagePayload(
  id: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  return readMedicineImage(id, medicineStoreOpts());
}

export async function medicineAnalyzeFromForm(body: Record<string, unknown>): Promise<{
  dayKey: string;
  items: MedicineScheduleViewItem[];
  summary: string;
}> {
  const plan = (typeof body.plan === "string" ? body.plan : "").trim().slice(0, MAX_PLAN_CHARS);
  const uploads = [
    ...asFiles(body.images),
    ...asFiles(body.image),
    ...asFiles(body.file),
  ].filter((file) => isPhotoFilename(file.name || "upload.jpg"));
  if (!plan && !uploads.length) {
    throw new MedicineStoreError(400, "Add a photo or a note about the plan.");
  }
  if (uploads.length > MAX_IMAGES) {
    throw new MedicineStoreError(400, `Add up to ${MAX_IMAGES} photos at a time.`);
  }

  const photos = [];
  for (const file of uploads) {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new MedicineStoreError(400, `${file.name || "A photo"} is larger than 8 MB.`);
    }
    const prepared = await preparePhotoForVision({
      filename: file.name || "bottle.jpg",
      bytes,
      mimeType: file.type || photoMimeFromFilename(file.name || "bottle.jpg"),
    });
    photos.push({
      filename: file.name || "bottle.jpg",
      bytes: prepared.bytes,
      mimeType: prepared.mimeType,
    });
  }

  const opts = medicineStoreOpts();
  const imageIds: string[] = [];
  for (const photo of photos) {
    imageIds.push(await saveMedicineImage(photo.bytes, photo.mimeType, opts));
  }
  const current = await readMedicineSchedule(opts);
  const drafts = await draftMedicineItems({ plan, images: photos, current });
  const merged = mergeMedicineItems(
    current,
    attachDraftImages(drafts, imageIds),
    () => `med_${randomUUID().slice(0, 8)}`,
  );
  await saveMedicineSchedule(merged.items, opts);
  const view = await medicineSchedulePayload();
  return { ...view, summary: mergeSummary(merged.added, merged.updated) };
}

export async function medicinePatchItem(
  id: string,
  body: unknown,
): Promise<{ dayKey: string; items: MedicineScheduleViewItem[] }> {
  await updateMedicineItem(id, parsePatch(body), medicineStoreOpts());
  return medicineSchedulePayload();
}

export async function medicineDeleteItem(
  id: string,
): Promise<{ dayKey: string; items: MedicineScheduleViewItem[] }> {
  await deleteMedicineItem(id, medicineStoreOpts());
  return medicineSchedulePayload();
}

export async function medicineLog(body: unknown): Promise<{
  speech: string;
  dayKey: string;
  items: MedicineScheduleViewItem[];
}> {
  const request = parseLog(body);
  const { now, timezone, dayStart, opts } = medicineClock();
  return storeMedicineLog(request, now, timezone, dayStart, opts);
}

export function medicineHttpError(err: unknown): { message: string; status: number } {
  if (err instanceof MedicineStoreError || err instanceof MedicineLlmError) {
    return { message: err.message, status: err.status };
  }
  console.error("[medicine]", err);
  return {
    message: err instanceof Error ? err.message : "Medicine schedule failed",
    status: 500,
  };
}

function parsePatch(body: unknown): MedicineItemPatch {
  if (!body || typeof body !== "object") throw new MedicineStoreError(400, "Invalid item");
  const raw = body as Record<string, unknown>;
  const patch: MedicineItemPatch = {};
  if (typeof raw.name === "string") patch.name = raw.name;
  if (typeof raw.quantity === "string") patch.quantity = raw.quantity;
  if (typeof raw.instruction === "string") patch.instruction = raw.instruction;
  if (typeof raw.period === "string") {
    if (!isMedicinePeriod(raw.period)) throw new MedicineStoreError(400, "Invalid period");
    patch.period = raw.period;
  }
  if (raw.days !== undefined) patch.days = parseDays(raw.days);
  return patch;
}

function parseDays(value: unknown): MedicineDays {
  if (value === "daily") return "daily";
  if (!Array.isArray(value)) throw new MedicineStoreError(400, "Invalid days");
  const days = [...new Set(value.map(Number).filter((day) => day >= 0 && day <= 6))].sort(
    (a, b) => a - b,
  );
  if (!days.length || days.length === 7) return "daily";
  return days;
}

function parseLog(body: unknown): MedicineLogRequest {
  if (!body || typeof body !== "object") throw new MedicineStoreError(400, "Invalid log");
  const raw = body as Record<string, unknown>;
  if (typeof raw.mode !== "string" || !isMedicineLogMode(raw.mode)) {
    throw new MedicineStoreError(400, "Invalid mode");
  }
  let period: MedicinePeriod | undefined;
  if (typeof raw.period === "string" && raw.period) {
    if (!isMedicinePeriod(raw.period)) throw new MedicineStoreError(400, "Invalid period");
    period = raw.period;
  }
  const names = Array.isArray(raw.names)
    ? raw.names.map(String).map((name) => name.trim()).filter(Boolean).slice(0, 20)
    : undefined;
  const ids = Array.isArray(raw.ids)
    ? raw.ids.map(String).map((id) => id.trim()).filter(Boolean).slice(0, 40)
    : undefined;
  return { mode: raw.mode, period, names, ids };
}

function asFiles(value: unknown): File[] {
  if (value instanceof File) return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is File => entry instanceof File);
  return [];
}
