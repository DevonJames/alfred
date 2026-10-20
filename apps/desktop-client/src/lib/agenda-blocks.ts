import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { calendarPolicyPath } from "@alfred/calendar-gateway";

export type BlockRepeat = "all" | "weekdays" | "weekends" | "custom";

export interface TimeBlockRule {
  start: string;
  end: string;
  repeat: BlockRepeat;
  /** Weekdays, Sunday = 0. Used when repeat is custom. */
  days: number[];
}

export interface AgendaTimeBlock extends TimeBlockRule {
  id: string;
  name: string;
  calendarId: string;
  /** Categories from the standard weekly plan that this block hosts. */
  categoryIds: string[];
}

export interface AgendaBlocksFile {
  blocks: AgendaTimeBlock[];
  /** Calendar events created by placing a reminder. The next one in that block starts after these. */
  placed: string[];
}

export interface BusySpan {
  id: string;
  title: string;
  startMin: number;
  endMin: number;
}

export interface Placement {
  status: "fit" | "overlap" | "too-short";
  startMin: number;
  endMin: number;
  overlapTitle: string | null;
}

export function categoryIdsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim()] : [])),
    ),
  ];
}

export function agendaBlocksPath(profileId?: string): string {
  return path.join(path.dirname(calendarPolicyPath(profileId)), "agenda-blocks.json");
}

export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function weekdayOf(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, 12)).getUTCDay();
}

export function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days, 12)).toISOString().slice(0, 10);
}

export function blockRunsOn(block: TimeBlockRule, isoDate: string): boolean {
  const weekday = weekdayOf(isoDate);
  if (block.repeat === "weekdays") return weekday >= 1 && weekday <= 5;
  if (block.repeat === "weekends") return weekday === 0 || weekday === 6;
  if (block.repeat === "custom") return block.days.includes(weekday);
  return true;
}

function firstOpen(from: number, until: number, duration: number, events: BusySpan[]): number | null {
  let cursor = from;
  for (const event of events) {
    const start = Math.max(event.startMin, from);
    const end = Math.min(event.endMin, until);
    if (end <= from || start >= until) continue;
    if (start - cursor >= duration) return cursor;
    cursor = Math.max(cursor, end);
  }
  if (until - cursor >= duration) return cursor;
  return null;
}

/** First open stretch inside the block. A reminder already placed there pushes the start to after it. */
export function placeInBlock(input: {
  blockStart: number;
  blockEnd: number;
  duration: number;
  events: BusySpan[];
  reminderIds: string[];
}): Placement | null {
  const { blockStart, blockEnd, duration } = input;
  if (duration <= 0 || blockEnd <= blockStart) return null;
  const inside = input.events
    .filter((event) => event.endMin > blockStart && event.startMin < blockEnd)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const reminderEnds = inside
    .filter((event) => input.reminderIds.includes(event.id))
    .map((event) => Math.min(event.endMin, blockEnd));
  const from = reminderEnds.length ? Math.max(blockStart, ...reminderEnds) : blockStart;
  const fitAt = firstOpen(from, blockEnd, duration, inside);
  if (fitAt != null) {
    return { status: "fit", startMin: fitAt, endMin: fitAt + duration, overlapTitle: null };
  }
  const end = from + duration;
  const hit = inside.find((event) => event.startMin < end && event.endMin > from);
  if (!hit && end > blockEnd) {
    return { status: "too-short", startMin: from, endMin: blockEnd, overlapTitle: null };
  }
  return {
    status: "overlap",
    startMin: from,
    endMin: end,
    overlapTitle: hit?.title ?? "another event",
  };
}

/** The next day this block runs and has room, searching forward from `fromDate` inclusive. */
export function nextFittingDay(input: {
  fromDate: string;
  block: TimeBlockRule;
  duration: number;
  eventsOn: (isoDate: string) => BusySpan[];
  reminderIds: string[];
  horizon?: number;
}): { date: string; startMin: number } | null {
  const horizon = input.horizon ?? 14;
  const blockStart = parseClock(input.block.start);
  const blockEnd = parseClock(input.block.end);
  if (blockStart == null || blockEnd == null) return null;
  for (let offset = 0; offset < horizon; offset += 1) {
    const date = shiftDate(input.fromDate, offset);
    if (!blockRunsOn(input.block, date)) continue;
    const placed = placeInBlock({
      blockStart,
      blockEnd,
      duration: input.duration,
      events: input.eventsOn(date),
      reminderIds: input.reminderIds,
    });
    if (placed?.status === "fit") return { date, startMin: placed.startMin };
  }
  return null;
}

export async function loadAgendaBlocks(profileId?: string): Promise<AgendaBlocksFile> {
  try {
    const raw = JSON.parse(await readFile(agendaBlocksPath(profileId), "utf8")) as AgendaBlocksFile;
    const blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
    return {
      blocks: blocks.map((block) => ({ ...block, categoryIds: categoryIdsOf(block?.categoryIds) })),
      placed: Array.isArray(raw?.placed) ? raw.placed.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return { blocks: [], placed: [] };
  }
}

export async function saveAgendaBlocks(file: AgendaBlocksFile, profileId?: string): Promise<void> {
  const target = agendaBlocksPath(profileId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Normalize a client/time-block payload, or null if required fields are missing. */
export function cleanAgendaBlock(raw: unknown): AgendaTimeBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const start = typeof row.start === "string" ? row.start : "";
  const end = typeof row.end === "string" ? row.end : "";
  const calendarId = typeof row.calendarId === "string" ? row.calendarId.trim() : "";
  const repeat = row.repeat;
  const days = Array.isArray(row.days)
    ? [...new Set(row.days.filter((day): day is number => typeof day === "number" && day >= 0 && day <= 6))]
    : [];
  const startMin = parseClock(start);
  const endMin = parseClock(end);
  if (!name || !calendarId || startMin == null || endMin == null || startMin >= endMin) return null;
  if (repeat !== "all" && repeat !== "weekdays" && repeat !== "weekends" && repeat !== "custom") return null;
  if (repeat === "custom" && !days.length) return null;
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : randomUUID();
  return {
    id,
    name: name.slice(0, 80),
    start,
    end,
    repeat: repeat as BlockRepeat,
    days,
    calendarId,
    categoryIds: categoryIdsOf(row.categoryIds),
  };
}
