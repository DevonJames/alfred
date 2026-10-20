import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  agendaBlocksPath,
  blockRunsOn,
  formatClock,
  nextFittingDay,
  parseClock,
  placeInBlock,
  shiftDate,
  weekdayOf,
  type BusySpan,
  type TimeBlockRule,
} from "./agenda-blocks.js";

export type PlanCadence = "day" | "week" | "fortnight" | "month";

export type MonthAnchor =
  | { kind: "month-edge"; edge: "first" | "last" }
  | { kind: "month-day"; day: number }
  | { kind: "nth-weekday"; n: 1 | 2 | 3 | 4 | 5 | -1; weekday: number };

export interface PlanCategory {
  id: string;
  name: string;
  cadence: PlanCadence;
  /** Hours for one day, one week, or one month, depending on cadence. */
  hours: number;
  monthAnchor?: MonthAnchor;
}

export interface StandardWeeklyPlan {
  weeklyHours: number;
  categories: PlanCategory[];
}

export interface FillSlice {
  categoryId: string;
  date: string;
  startMin: number;
  endMin: number;
}

export interface FillResult {
  slices: FillSlice[];
  unplaced: { categoryId: string; minutes: number }[];
}

export interface SessionPlacement {
  status: "fit" | "overlap" | "too-short" | "off-day" | "none";
  startMin: number | null;
  endMin: number | null;
  overlapTitle: string | null;
  next: { date: string; startMin: number } | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Every hour in a week. Sleep is a category, not a guess subtracted up front. */
export const HOURS_IN_A_WEEK = 168;
const EMPTY: StandardWeeklyPlan = { weeklyHours: 0, categories: [] };

export function standardPlanPath(profileId?: string): string {
  return path.join(path.dirname(agendaBlocksPath(profileId)), "agenda-standard-plan.json");
}

export function planIsSaved(plan: StandardWeeklyPlan): boolean {
  return plan.weeklyHours > 0;
}

/** Weekly hours this category claims. A month is 12/52 of a week. */
export function claimedWeeklyHours(category: { cadence: PlanCadence; hours: number }): number {
  if (category.cadence === "day") return category.hours * 7;
  if (category.cadence === "fortnight") return category.hours / 2;
  if (category.cadence === "month") return (category.hours * 12) / 52;
  return category.hours;
}

export function totalClaimedHours(categories: { cadence: PlanCadence; hours: number }[]): number {
  return categories.reduce((sum, category) => sum + claimedWeeklyHours(category), 0);
}

export function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

/** Divide minutes across hosts. Earlier hosts receive any remainder. */
export function splitMinutes(minutes: number, count: number): number[] {
  if (count <= 0) return [];
  const total = Math.max(0, Math.round(minutes));
  const share = Math.floor(total / count);
  let extra = total - share * count;
  return Array.from({ length: count }, () => {
    const amount = share + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    return amount;
  });
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The calendar day this anchor lands on in a given month.
 * A day number past the end of a short month clamps to the last day.
 * A 5th weekday that the month does not contain is missing.
 */
export function resolveMonthDate(
  anchor: MonthAnchor,
  year: number,
  month: number,
): { date: string | null; clamped: boolean; missing: boolean } {
  const days = daysInMonth(year, month);
  if (anchor.kind === "month-edge") {
    const day = anchor.edge === "first" ? 1 : days;
    return { date: isoDate(year, month, day), clamped: false, missing: false };
  }
  if (anchor.kind === "month-day") {
    const day = Math.min(Math.max(anchor.day, 1), days);
    return { date: isoDate(year, month, day), clamped: day !== anchor.day, missing: false };
  }
  if (anchor.n === -1) {
    const last = isoDate(year, month, days);
    const delta = (weekdayOf(last) - anchor.weekday + 7) % 7;
    return { date: shiftDate(last, -delta), clamped: false, missing: false };
  }
  const first = isoDate(year, month, 1);
  const delta = (anchor.weekday - weekdayOf(first) + 7) % 7;
  const day = 1 + delta + (anchor.n - 1) * 7;
  if (day > days) return { date: null, clamped: false, missing: true };
  return { date: isoDate(year, month, day), clamped: false, missing: false };
}

export function monthAnchorLabel(anchor: MonthAnchor): string {
  if (anchor.kind === "month-edge") {
    return anchor.edge === "first" ? "First day of the month" : "Last day of the month";
  }
  if (anchor.kind === "month-day") return `The ${ordinal(anchor.day)} of the month`;
  const nth = anchor.n === -1 ? "Last" : ordinal(anchor.n);
  return `${nth} ${WEEKDAYS[anchor.weekday] ?? "day"}`;
}

function ordinal(day: number): string {
  const mod = day % 100;
  if (mod >= 11 && mod <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

function freeGaps(
  blockStart: number,
  blockEnd: number,
  busy: { startMin: number; endMin: number }[],
): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  const spans = busy
    .map((span) => ({ start: Math.max(blockStart, span.startMin), end: Math.min(blockEnd, span.endMin) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  const gaps: { start: number; end: number }[] = [];
  let cursor = blockStart;
  for (const span of merged) {
    if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < blockEnd) gaps.push({ start: cursor, end: blockEnd });
  return gaps;
}

/**
 * Fill each request from the start of the block, day by day.
 * Later requests continue in the gaps the earlier ones left.
 */
export function fillBlockHours(input: {
  dates: string[];
  blockStart: number;
  blockEnd: number;
  requests: { categoryId: string; minutes: number }[];
  busyOn: (date: string) => { startMin: number; endMin: number }[];
}): FillResult {
  const slices: FillSlice[] = [];
  const unplaced: { categoryId: string; minutes: number }[] = [];
  const added = new Map<string, { startMin: number; endMin: number }[]>();
  if (input.blockEnd <= input.blockStart) {
    return {
      slices,
      unplaced: input.requests
        .filter((request) => request.minutes > 0)
        .map((request) => ({ categoryId: request.categoryId, minutes: request.minutes })),
    };
  }
  for (const request of input.requests) {
    let remaining = Math.max(0, Math.round(request.minutes));
    if (remaining === 0) continue;
    for (const date of input.dates) {
      if (remaining <= 0) break;
      const busy = [...(input.busyOn(date) ?? []), ...(added.get(date) ?? [])];
      for (const gap of freeGaps(input.blockStart, input.blockEnd, busy)) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, gap.end - gap.start);
        if (take <= 0) continue;
        const slice = { categoryId: request.categoryId, date, startMin: gap.start, endMin: gap.start + take };
        slices.push(slice);
        const day = added.get(date) ?? [];
        day.push({ startMin: slice.startMin, endMin: slice.endMin });
        added.set(date, day);
        remaining -= take;
      }
    }
    if (remaining > 0) unplaced.push({ categoryId: request.categoryId, minutes: remaining });
  }
  return { slices, unplaced };
}

/** One session in the block. An off day offers the next day in `dates` the block runs and has room. */
export function placeSession(input: {
  date: string;
  block: TimeBlockRule;
  minutes: number;
  dates: string[];
  busyOn: (date: string) => BusySpan[];
}): SessionPlacement {
  const minutes = Math.round(input.minutes);
  const blockStart = parseClock(input.block.start);
  const blockEnd = parseClock(input.block.end);
  const none: SessionPlacement = { status: "none", startMin: null, endMin: null, overlapTitle: null, next: null };
  if (minutes <= 0 || blockStart == null || blockEnd == null || !input.dates.includes(input.date)) return none;
  const later = input.dates.filter((date) => date > input.date);
  const nextInWeek = () => {
    if (!later.length) return null;
    return nextFittingDay({
      fromDate: later[0]!,
      block: input.block,
      duration: minutes,
      eventsOn: input.busyOn,
      reminderIds: [],
      horizon: later.length,
    });
  };
  if (!blockRunsOn(input.block, input.date)) {
    return { status: "off-day", startMin: null, endMin: null, overlapTitle: null, next: nextInWeek() };
  }
  const placed = placeInBlock({
    blockStart,
    blockEnd,
    duration: minutes,
    events: input.busyOn(input.date),
    reminderIds: [],
  });
  if (!placed) return none;
  if (placed.status === "fit") {
    return { status: "fit", startMin: placed.startMin, endMin: placed.endMin, overlapTitle: null, next: null };
  }
  return {
    status: placed.status,
    startMin: placed.startMin,
    endMin: placed.endMin,
    overlapTitle: placed.overlapTitle,
    next: nextInWeek(),
  };
}

export function coveredMinutes(
  lines: { date: string; start: string; end: string; title: string; calendarId: string }[],
  title: string,
  dates: readonly string[],
  blockStart: number,
  blockEnd: number,
  skipOverlapIds: ReadonlySet<string>,
): number {
  const wanted = new Set(dates);
  let total = 0;
  for (const line of lines) {
    if (line.title !== title || !wanted.has(line.date) || skipOverlapIds.has(line.calendarId)) continue;
    const start = parseClock(line.start);
    const end = parseClock(line.end);
    if (start == null || end == null) continue;
    total += Math.max(0, Math.min(end, blockEnd) - Math.max(start, blockStart));
  }
  return total;
}

export function busyFromLines(
  lines: { date: string; start: string; end: string; title: string; calendarId: string }[],
  date: string,
  skipOverlapIds: ReadonlySet<string>,
): BusySpan[] {
  return lines.flatMap((line) => {
    if (line.date !== date || skipOverlapIds.has(line.calendarId)) return [];
    const startMin = parseClock(line.start);
    const endMin = parseClock(line.end);
    if (startMin == null || endMin == null || endMin <= startMin) return [];
    return [{ id: `${line.date}:${line.start}:${line.title}`, title: line.title, startMin, endMin }];
  });
}

export function draftFromSlice(input: {
  categoryName: string;
  calendarId: string;
  date: string;
  startMin: number;
  endMin: number;
  key?: string;
}): {
  key: string;
  date: string;
  start: string;
  end: string;
  title: string;
  calendarId: string;
  origin: "draft";
  dirty: true;
} {
  return {
    key: input.key ?? randomUUID(),
    date: input.date,
    start: formatClock(input.startMin),
    end: formatClock(input.endMin),
    title: input.categoryName,
    calendarId: input.calendarId,
    origin: "draft",
    dirty: true,
  };
}

function halfHour(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const snapped = Math.round(value * 2) / 2;
  if (Math.abs(snapped - value) > 0.001) return null;
  return snapped;
}

function cleanAnchor(raw: unknown): MonthAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === "month-edge" && (row.edge === "first" || row.edge === "last")) {
    return { kind: "month-edge", edge: row.edge };
  }
  if (row.kind === "month-day" && typeof row.day === "number" && Number.isInteger(row.day) && row.day >= 1 && row.day <= 31) {
    return { kind: "month-day", day: row.day };
  }
  if (row.kind === "nth-weekday") {
    const n = row.n;
    const weekday = row.weekday;
    const okN = n === -1 || n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
    if (okN && typeof weekday === "number" && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      return { kind: "nth-weekday", n, weekday };
    }
  }
  return null;
}

function hourCap(cadence: PlanCadence): number {
  if (cadence === "day") return 24;
  if (cadence === "fortnight") return 336;
  if (cadence === "month") return 744;
  return 168;
}

/** Strict read of a save payload. Rejects a bad category and duplicate names. */
export function parseStandardPlan(raw: unknown): { ok: true; plan: StandardWeeklyPlan } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Expected a weekly plan." };
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.categories)) return { ok: false, error: "Expected categories." };
  const categories: PlanCategory[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const rawCategory of body.categories) {
    if (!rawCategory || typeof rawCategory !== "object") return { ok: false, error: "Each category needs a name and hours." };
    const row = rawCategory as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
    if (!name) return { ok: false, error: "Each category needs a name." };
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) return { ok: false, error: `Two categories are named ${name}.` };
    names.add(nameKey);
    const cadence =
      row.cadence === "day" || row.cadence === "week" || row.cadence === "fortnight" || row.cadence === "month"
        ? row.cadence
        : null;
    if (!cadence) return { ok: false, error: `${name} needs a daily, weekly, every-two-weeks, or monthly cadence.` };
    const hours = halfHour(row.hours);
    if (hours == null || hours < 0.5 || hours > hourCap(cadence)) {
      return { ok: false, error: `${name} needs hours in half-hour steps.` };
    }
    const monthAnchor = cadence === "month" ? cleanAnchor(row.monthAnchor) : undefined;
    if (cadence === "month" && !monthAnchor) return { ok: false, error: `${name} needs a day of the month.` };
    let id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || ids.has(id)) id = randomUUID();
    ids.add(id);
    categories.push({ id, name, cadence, hours, ...(monthAnchor ? { monthAnchor } : {}) });
  }
  return { ok: true, plan: { weeklyHours: HOURS_IN_A_WEEK, categories } };
}

function lenientCategory(raw: unknown, ids: Set<string>, names: Set<string>): PlanCategory | null {
  const parsed = parseStandardPlan({ weeklyHours: 1, categories: [raw] });
  if (!parsed.ok) return null;
  const category = parsed.plan.categories[0];
  if (!category) return null;
  const nameKey = category.name.toLowerCase();
  if (names.has(nameKey)) return null;
  names.add(nameKey);
  if (ids.has(category.id)) category.id = randomUUID();
  ids.add(category.id);
  return category;
}

export async function loadStandardPlan(profileId?: string): Promise<StandardWeeklyPlan> {
  try {
    const raw = JSON.parse(await readFile(standardPlanPath(profileId), "utf8")) as Partial<StandardWeeklyPlan>;
    const weeklyHours = halfHour(raw?.weeklyHours);
    const ids = new Set<string>();
    const names = new Set<string>();
    const categories = Array.isArray(raw?.categories)
      ? raw.categories.flatMap((item) => {
          const category = lenientCategory(item, ids, names);
          return category ? [category] : [];
        })
      : [];
    if (weeklyHours == null || weeklyHours < 0.5 || weeklyHours > 168) return { weeklyHours: 0, categories };
    return { weeklyHours, categories };
  } catch {
    return { ...EMPTY, categories: [] };
  }
}

export async function saveStandardPlan(plan: StandardWeeklyPlan, profileId?: string): Promise<void> {
  const target = standardPlanPath(profileId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}
