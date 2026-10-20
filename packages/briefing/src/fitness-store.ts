import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRepoRoot } from "@alfred/memory";
import {
  isFitnessItemStatus,
  isFitnessMealType,
  fitnessPlanIsCurrent,
  type FitnessDayPlan,
  type FitnessMeal,
  type FitnessWorkout,
} from "./fitness.js";

const FOCUS_TTL_MS = 15 * 60 * 1000;
const FOCUS_MAX_CHARS = 12_000;
const MAX_MEALS = 12;
const MAX_WORKOUTS = 8;

export class FitnessStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FitnessFocusRecord {
  deviceId: string;
  updatedAt: string;
  card: Record<string, unknown>;
}

interface FocusFile {
  devices: FitnessFocusRecord[];
}

export function fitnessDir(dir?: string): string {
  if (dir?.trim()) return path.resolve(dir);
  const fromEnv = process.env.ALFRED_FITNESS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(resolveRepoRoot(), "data", "desktop-client");
}

function planPath(dir?: string): string {
  return path.join(fitnessDir(dir), "fitness-plan.json");
}

function focusPath(dir?: string): string {
  return path.join(fitnessDir(dir), "fitness-focus.json");
}

export async function readFitnessDayPlan(dir?: string): Promise<FitnessDayPlan | null> {
  try {
    const raw = await readFile(planPath(dir), "utf8");
    const parsed = JSON.parse(raw) as FitnessDayPlan;
    return parsed?.date ? parsed : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function loadCurrentFitnessDayPlan(
  now: Date,
  timezone: string,
  dayStart?: string,
  dir?: string,
): Promise<FitnessDayPlan | null> {
  const plan = await readFitnessDayPlan(dir);
  if (!plan || !fitnessPlanIsCurrent(plan, now, timezone, dayStart)) return null;
  return plan;
}

/** Later `asOf` wins. An older snapshot is refused so a delayed client cannot overwrite a newer plan. */
export async function saveFitnessDayPlan(body: unknown, dir?: string): Promise<FitnessDayPlan> {
  const plan = parseDayPlan(body);
  const existing = await readFitnessDayPlan(dir);
  if (existing && Date.parse(plan.asOf) < Date.parse(existing.asOf)) {
    throw new FitnessStoreError(409, "stale");
  }
  await writeJson(planPath(dir), plan);
  return plan;
}

export async function clearFitnessDayPlan(dir?: string): Promise<void> {
  await writeJson(planPath(dir), null);
}

export function parseDayPlan(body: unknown): FitnessDayPlan {
  if (!body || typeof body !== "object") throw new FitnessStoreError(400, "A day plan object is required");
  const raw = body as Record<string, unknown>;
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  const timezone = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
  const asOf = typeof raw.asOf === "string" ? raw.asOf.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new FitnessStoreError(400, "date must be YYYY-MM-DD");
  if (!timezone || timezone.length > 80) throw new FitnessStoreError(400, "timezone is required");
  if (!Number.isFinite(Date.parse(asOf))) throw new FitnessStoreError(400, "asOf must be an ISO time");
  if (!Array.isArray(raw.meals) || !Array.isArray(raw.workouts)) {
    throw new FitnessStoreError(400, "meals and workouts must be arrays");
  }
  if (raw.meals.length > MAX_MEALS) throw new FitnessStoreError(400, `At most ${MAX_MEALS} meals`);
  if (raw.workouts.length > MAX_WORKOUTS) throw new FitnessStoreError(400, `At most ${MAX_WORKOUTS} workouts`);
  return {
    date,
    timezone,
    asOf: new Date(asOf).toISOString(),
    meals: raw.meals.map(parseMeal),
    workouts: raw.workouts.map(parseWorkout),
  };
}

export async function saveFitnessFocus(deviceId: string, body: unknown, dir?: string): Promise<FitnessFocusRecord> {
  const card = parseFocusCard(body);
  const file = await readFocusFile(dir);
  const next: FitnessFocusRecord = { deviceId, updatedAt: new Date().toISOString(), card };
  const devices = file.devices.filter((item) => item.deviceId !== deviceId);
  devices.push(next);
  await writeJson(focusPath(dir), { devices });
  return next;
}

export async function clearFitnessFocus(deviceId: string, dir?: string): Promise<void> {
  const file = await readFocusFile(dir);
  await writeJson(focusPath(dir), { devices: file.devices.filter((item) => item.deviceId !== deviceId) });
}

export async function readFitnessFocus(deviceId: string, now = new Date(), dir?: string): Promise<FitnessFocusRecord | null> {
  const file = await readFocusFile(dir);
  const found = file.devices.find((item) => item.deviceId === deviceId);
  if (!found || focusExpired(found, now)) return null;
  return found;
}

export async function readNewestFitnessFocus(now = new Date(), dir?: string): Promise<FitnessFocusRecord | null> {
  const file = await readFocusFile(dir);
  const live = file.devices.filter((item) => !focusExpired(item, now));
  live.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return live[0] ?? null;
}

export function formatFitnessFocusPrompt(card: Record<string, unknown>): string {
  return [
    "The user has a FitnessAlly recipe or workout on screen. \"This recipe\", \"this exercise\", and \"this one\" mean this card.",
    "Answer from the card. If a detail is not in the card, say so. Do not store the card as a memory.",
    JSON.stringify(card),
  ].join("\n");
}

export function parseFocusCard(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FitnessStoreError(400, "A focus card object is required");
  }
  const card = body as Record<string, unknown>;
  if (card.kind !== "recipe" && card.kind !== "workout") {
    throw new FitnessStoreError(400, "kind must be recipe or workout");
  }
  if (typeof card.name !== "string" || !card.name.trim()) {
    throw new FitnessStoreError(400, "name is required");
  }
  const encoded = JSON.stringify(card);
  if (encoded.length > FOCUS_MAX_CHARS) {
    throw new FitnessStoreError(400, "Focus card is too large");
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

async function readFocusFile(dir?: string): Promise<FocusFile> {
  try {
    const raw = await readFile(focusPath(dir), "utf8");
    const parsed = JSON.parse(raw) as Partial<FocusFile>;
    return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { devices: [] };
    throw err;
  }
}

function focusExpired(record: FitnessFocusRecord, now: Date): boolean {
  const at = Date.parse(record.updatedAt);
  return !Number.isFinite(at) || now.getTime() - at > FOCUS_TTL_MS;
}

function parseMeal(value: unknown): FitnessMeal {
  if (!value || typeof value !== "object") throw new FitnessStoreError(400, "Each meal must be an object");
  const raw = value as Record<string, unknown>;
  const id = cleanId(raw.id);
  const name = cleanName(raw.name);
  const mealType = typeof raw.mealType === "string" ? raw.mealType : "";
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!isFitnessMealType(mealType)) throw new FitnessStoreError(400, "mealType is invalid");
  if (!isFitnessItemStatus(status)) throw new FitnessStoreError(400, "meal status is invalid");
  const meal: FitnessMeal = { id, name, mealType, status };
  if (typeof raw.servings === "number" && Number.isFinite(raw.servings) && raw.servings >= 0) {
    meal.servings = raw.servings;
  }
  const notes = cleanNotes(raw.notes);
  if (notes) meal.notes = notes;
  return meal;
}

function parseWorkout(value: unknown): FitnessWorkout {
  if (!value || typeof value !== "object") throw new FitnessStoreError(400, "Each workout must be an object");
  const raw = value as Record<string, unknown>;
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!isFitnessItemStatus(status)) throw new FitnessStoreError(400, "workout status is invalid");
  const workout: FitnessWorkout = { id: cleanId(raw.id), name: cleanName(raw.name), status };
  const notes = cleanNotes(raw.notes);
  if (notes) workout.notes = notes;
  return workout;
}

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) throw new FitnessStoreError(400, "id is required");
  return id;
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 200) throw new FitnessStoreError(400, "name is required");
  return name;
}

function cleanNotes(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const notes = value.trim();
  if (!notes) return undefined;
  return notes.slice(0, 500);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
