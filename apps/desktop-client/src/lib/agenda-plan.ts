import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zonedDateTime } from "@alfred/calendar-gateway";
import {
  agendaBlocksPath,
  blockRunsOn,
  formatClock,
  parseClock,
  shiftDate,
  weekdayOf,
  type AgendaTimeBlock,
} from "./agenda-blocks.js";

export type PlanScope = "day" | "weekend" | "week";

export interface PlanPeriod {
  scope: PlanScope;
  anchor: string;
  start: string;
  end: string;
  dates: string[];
  label: string;
}

export interface PlanLine {
  key: string;
  eventId?: string;
  date: string;
  start: string;
  end: string;
  title: string;
  calendarId: string;
  origin: "calendar" | "draft";
  dirty: boolean;
}

export interface PlanChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface StoredPlan {
  scope: PlanScope;
  anchor: string;
  items: PlanLine[];
  chat: PlanChatTurn[];
}

interface PlanFile {
  plans: Record<string, StoredPlan>;
}

export interface ChatPlanItem {
  key?: string;
  eventId?: string;
  date: string;
  start: string;
  end: string;
  title: string;
  calendarId?: string;
  remove?: boolean;
}

const SCOPES = new Set<PlanScope>(["day", "weekend", "week"]);

export function planScope(value: unknown): PlanScope {
  return typeof value === "string" && SCOPES.has(value as PlanScope) ? (value as PlanScope) : "day";
}

export function planKey(scope: PlanScope, start: string): string {
  return `${scope}:${start}`;
}

export function agendaPlansPath(profileId?: string): string {
  return path.join(path.dirname(agendaBlocksPath(profileId)), "agenda-plans.json");
}

export function planPeriod(scope: PlanScope, anchor: string): PlanPeriod {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : "1970-01-01";
  if (scope === "day") {
    return { scope, anchor: day, start: day, end: day, dates: [day], label: dateLabel(day) };
  }
  const weekStart = shiftDate(day, -weekdayOf(day));
  if (scope === "week") {
    const dates = Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index));
    return {
      scope,
      anchor: day,
      start: dates[0]!,
      end: dates[6]!,
      dates,
      label: `${dateLabel(dates[0]!)} – ${dateLabel(dates[6]!)}`,
    };
  }
  const saturday = shiftDate(weekStart, 6);
  const sunday = shiftDate(saturday, 1);
  return {
    scope,
    anchor: day,
    start: saturday,
    end: sunday,
    dates: [saturday, sunday],
    label: `${dateLabel(saturday)} – ${dateLabel(sunday)}`,
  };
}

export function shiftPlanAnchor(scope: PlanScope, anchor: string, direction: number): string {
  const step = scope === "day" ? 1 : 7;
  return shiftDate(anchor, direction * step);
}

function dateLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12)));
}

export function clockOnPlanDate(date: string, hhmm: string, zone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const minutes = parseClock(hhmm) ?? 0;
  return zonedDateTime(zone, year ?? 0, month ?? 1, day ?? 1, Math.floor(minutes / 60), minutes % 60);
}

function sameLine(line: PlanLine, other: { date: string; start: string; end: string; title: string; calendarId: string }): boolean {
  return (
    line.date === other.date &&
    line.start === other.start &&
    line.end === other.end &&
    line.title === other.title &&
    line.calendarId === other.calendarId
  );
}

/** Calendar rows stay. A saved edit wins when it differs. Drafts without an event stay. */
export function mergePlan(calendarLines: PlanLine[], saved: PlanLine[]): PlanLine[] {
  const savedByEvent = new Map(saved.filter((line) => line.eventId).map((line) => [line.eventId!, line]));
  const seen = new Set<string>();
  const merged = calendarLines.map((calendar) => {
    const prior = calendar.eventId ? savedByEvent.get(calendar.eventId) : undefined;
    if (calendar.eventId) seen.add(calendar.eventId);
    if (!prior) return calendar;
    const dirty = !sameLine(prior, calendar);
    return {
      ...prior,
      key: prior.key || calendar.key,
      origin: "calendar" as const,
      dirty,
      eventId: calendar.eventId,
    };
  });
  for (const line of saved) {
    if (line.eventId) continue;
    if (!line.title.trim() && !line.start) continue;
    merged.push({ ...line, origin: "draft", dirty: true, eventId: undefined });
  }
  return merged.filter((line) => !line.eventId || seen.has(line.eventId) || line.origin === "draft");
}

const NAMED_DAY =
  /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|yesterday|this weekend|next week|(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|the\s+\d{1,2}(?:st|nd|rd|th))\b/i;

/** True when the user named a day. "This evening" does not count. */
export function messageNamesDate(message: string): boolean {
  return NAMED_DAY.test(message);
}

/**
 * Day for a new item when the user did not name one.
 * A selected day wins. Otherwise today, when it sits in the period.
 */
export function defaultPlanDate(input: {
  message: string;
  dates: string[];
  today: string;
  selected?: string | null;
}): string | null {
  if (messageNamesDate(input.message)) return null;
  if (input.selected && input.dates.includes(input.selected)) return input.selected;
  if (input.dates.includes(input.today)) return input.today;
  return input.dates[0] ?? null;
}

/** New rows land on the default day. Existing rows keep the day they already have. */
export function assignDefaultPlanDate(current: PlanLine[], incoming: ChatPlanItem[], day: string | null): ChatPlanItem[] {
  if (!day) return incoming;
  const eventIds = new Set(current.flatMap((line) => (line.eventId ? [line.eventId] : [])));
  const keys = new Set(current.map((line) => line.key));
  return incoming.map((item) => {
    if (item.remove) return item;
    if (item.eventId && eventIds.has(item.eventId)) return item;
    if (item.key && keys.has(item.key)) return item;
    return { ...item, date: day };
  });
}

/** Free stretches on a day. Calendars that skip overlaps do not take up time. */
export function openPlanGaps(
  lines: { date: string; start: string; end: string; calendarId: string }[],
  date: string,
  skipOverlapIds: ReadonlySet<string>,
  fromMin = 0,
  untilMin = 24 * 60,
): { start: number; end: number }[] {
  const busy = lines
    .filter((line) => line.date === date && !skipOverlapIds.has(line.calendarId))
    .flatMap((line) => {
      const start = parseClock(line.start);
      const end = parseClock(line.end);
      if (start == null || end == null || end <= start) return [];
      return [{ start: Math.max(fromMin, start), end: Math.min(untilMin, end) }];
    })
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of busy) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  const gaps: { start: number; end: number }[] = [];
  let cursor = fromMin;
  for (const span of merged) {
    if (span.start - cursor >= 15) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (untilMin - cursor >= 15) gaps.push({ start: cursor, end: untilMin });
  return gaps;
}

export function formatPlanGaps(gaps: { start: number; end: number }[]): string {
  if (!gaps.length) return "none";
  const clock = (minutes: number) => (minutes >= 24 * 60 ? "24:00" : formatClock(minutes));
  return gaps.map((gap) => `${clock(gap.start)}–${clock(gap.end)}`).join(", ");
}

/** The next hour boundary. 12:53 becomes 13:00. An exact hour stays put. */
export function nextHourStart(nowMin: number): number {
  if (nowMin <= 0) return 0;
  if (nowMin >= 24 * 60) return 24 * 60;
  if (nowMin % 60 === 0) return nowMin;
  return (Math.floor(nowMin / 60) + 1) * 60;
}

/** True when the note names this clock, including "at 1" for 13:00. */
export function messageNamesStart(message: string, hhmm: string): boolean {
  const minutes = parseClock(hhmm);
  if (minutes == null) return false;
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 || 12;
  const mm = String(minute).padStart(2, "0");
  const text = message.toLowerCase();
  if (new RegExp(`\\b${hour24}:${mm}\\b`).test(text)) return true;
  if (new RegExp(`\\b${hour12}:${mm}\\b`).test(text)) return true;
  const mer = hour24 >= 12 ? "p" : "a";
  if (new RegExp(`\\b${hour12}(?::${mm})?\\s*(?:${mer}\\.?m?\\.?)\\b`).test(text)) return true;
  if (minute === 0 && new RegExp(`\\b(?:at|around|by)\\s+${hour12}\\b`).test(text)) return true;
  return false;
}

/**
 * First hour boundary at or after now where the whole duration is free.
 * If none fits, the first hour boundary that is not already inside a busy span.
 */
export function nextOpenHour(nowMin: number, durationMin: number, busy: { start: number; end: number }[]): number {
  const aligned = Math.min(nextHourStart(nowMin), 23 * 60);
  const duration = Math.min(12 * 60, Math.max(15, durationMin));
  for (let start = aligned; start + duration <= 24 * 60; start += 60) {
    const end = start + duration;
    if (!busy.some((span) => start < span.end && end > span.start)) return start;
  }
  for (let start = aligned; start < 24 * 60; start += 60) {
    if (!busy.some((span) => start >= span.start && start < span.end)) return start;
  }
  return aligned;
}

/** New items on today land on the next open hour. A named clock, a named part of the day, and existing rows stay. */
export function placeNewItemsFromClock(input: {
  current: PlanLine[];
  incoming: ChatPlanItem[];
  today: string;
  nowMin: number;
  message: string;
  skipOverlapIds: ReadonlySet<string>;
}): ChatPlanItem[] {
  const cutoff = nextHourStart(input.nowMin);
  const namedDayPart = /\b(?:this\s+)?(?:morning|afternoon|evening|tonight)\b/i.test(input.message);
  const eventIds = new Set(input.current.flatMap((line) => (line.eventId ? [line.eventId] : [])));
  const keys = new Set(input.current.map((line) => line.key));
  const busy = busySpans(input.current, input.today, input.skipOverlapIds);
  return input.incoming.map((item) => {
    if (item.remove || item.date !== input.today) return item;
    if (item.eventId && eventIds.has(item.eventId)) return item;
    if (item.key && keys.has(item.key)) return item;
    const start = parseClock(item.start);
    const end = parseClock(item.end);
    if (messageNamesStart(input.message, item.start)) return item;
    if (namedDayPart && start != null && start >= cutoff) {
      if (end != null && end > start) busy.push({ start, end });
      return item;
    }
    const span = end != null && start != null && end > start ? end - start : null;
    const duration = span ?? durationFromMessage(input.message) ?? 60;
    const slot = nextOpenHour(input.nowMin, duration, busy);
    if (start != null && start === slot) {
      busy.push({ start, end: end != null && end > start ? end : slot + duration });
      return item;
    }
    const placedEnd = Math.min(slot + duration, 24 * 60 - 1);
    busy.push({ start: slot, end: placedEnd });
    return { ...item, start: formatClock(slot), end: formatClock(placedEnd) };
  });
}

const ADD_REQUEST = /\b(?:need to|want to|have to|going to|gonna|add|schedule|put|block off|give me|set aside|goto|go to|visit|book)\b/i;
const EDIT_REQUEST = /\b(?:make|move|shift|shorten|lengthen|change|rename|cancel|drop|remove|delete)\b/i;

/** A note that asks for a new activity, rather than a question or an edit of a row already there. */
export function requestsNewPlanItem(message: string): boolean {
  const text = message.trim();
  if (!text || /^(?:what|when|why|how|which|who|where)\b/i.test(text) || /\?\s*$/.test(text)) return false;
  if (EDIT_REQUEST.test(text) && !ADD_REQUEST.test(text)) return false;
  return ADD_REQUEST.test(text) || durationFromMessage(text) != null;
}

/** Minutes the note asks for, or null when it names no length. */
export function durationFromMessage(message: string): number | null {
  const text = message.toLowerCase();
  if (/\b(?:an|one|1)\s+hours?\s+and\s+a\s+half\b|\bhour\s+and\s+a\s+half\b|\b1\.5\s+hours?\b|\b90\s+minutes?\b/.test(text)) {
    return 90;
  }
  if (/\bhalf\s+(?:an?\s+)?hour\b|\b30\s+minutes?\b/.test(text)) return 30;
  const hours = text.match(/\b(\d+(?:\.\d+)?)\s+hours?\b/);
  if (hours) return Math.min(12 * 60, Math.round(Number(hours[1]) * 60));
  const mins = text.match(/\b(\d+)\s+minutes?\b/);
  if (mins) return Math.min(12 * 60, Number(mins[1]));
  if (/\b(?:an|one)\s+hour\b/.test(text)) return 60;
  return null;
}

/** A short title from the reply, then from the request. */
export function titleFromPlanRequest(message: string, reply: string): string {
  const fromReply = reply.match(
    /\b(?:couldn'?t schedule|could not schedule|scheduled|schedule|placed|place|added|add)\s+(?:the\s+)?([a-z0-9][^.,]{2,48}?)(?:\s+because|\s+in\b|\s+at\b|\s+for\b|\s+on\b|$)/i,
  );
  const replyName = cleanPlanTitle(fromReply?.[1] ?? "");
  if (replyName) return replyName;
  const going = message.match(
    /\b(?:go to|goto|visit)\s+((?:a |an |the |two |some )?[a-z0-9][^.,]{2,48}?)(?:\s+today|\s+this\b|\s+to\b|\s+for\b|[.,]|$)/i,
  );
  const destination = cleanPlanTitle((going?.[1] ?? "").replace(/^(?:two|some|a|an|the)\s+/i, ""));
  if (destination) return destination;
  const clause = message.split(/[.\n]/)[0]?.trim() ?? "";
  return cleanPlanTitle(clause.slice(0, 60)) || "New item";
}

export function spokenClock(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${hour24 >= 12 ? "PM" : "AM"}`;
}

/**
 * When the model refuses to add an item, place it anyway at the next open hour.
 * Calendars that skip overlaps do not count as busy.
 */
export function ensureRequestedPlanItem(input: {
  current: PlanLine[];
  incoming: ChatPlanItem[];
  today: string;
  day: string | null;
  nowMin: number;
  message: string;
  reply: string;
  skipOverlapIds: ReadonlySet<string>;
}): { items: ChatPlanItem[]; reply: string } {
  const items = placeNewItemsFromClock({
    current: input.current,
    incoming: input.incoming,
    today: input.today,
    nowMin: input.nowMin,
    message: input.message,
    skipOverlapIds: input.skipOverlapIds,
  });
  const eventIds = new Set(input.current.flatMap((line) => (line.eventId ? [line.eventId] : [])));
  const keys = new Set(input.current.map((line) => line.key));
  const hasNew = items.some((item) => item.title.trim() && !item.remove && !(item.eventId && eventIds.has(item.eventId)) && !(item.key && keys.has(item.key)));
  if (hasNew || !input.day || !requestsNewPlanItem(input.message)) return { items, reply: input.reply };
  const duration = durationFromMessage(input.message) ?? 60;
  const busy = busySpans(input.current, input.day, input.skipOverlapIds);
  const slot = nextOpenHour(input.day === input.today ? input.nowMin : 9 * 60, duration, busy);
  const end = slot + duration;
  if (end > 24 * 60 || busy.some((span) => slot < span.end && end > span.start)) return { items, reply: input.reply };
  const title = titleFromPlanRequest(input.message, input.reply);
  return {
    items: [...items, { date: input.day, start: formatClock(slot), end: formatClock(end), title, calendarId: "" }],
    reply: `Scheduled ${title} at ${spokenClock(slot)}.`,
  };
}

function busySpans(lines: PlanLine[], date: string, skipOverlapIds: ReadonlySet<string>): { start: number; end: number }[] {
  return lines.flatMap((line) => {
    if (line.date !== date || skipOverlapIds.has(line.calendarId)) return [];
    const start = parseClock(line.start);
    const end = parseClock(line.end);
    if (start == null || end == null || end <= start) return [];
    return [{ start, end }];
  });
}

function cleanPlanTitle(value: string): string {
  const text = value.trim().replace(/\s+/g, " ").replace(/^(?:a|an|the)\s+/i, "");
  if (!text || /^(?:it|that|this|no|nothing)$/i.test(text)) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Chat returns new rows and any rows it changed. Rows it does not mention stay. */
export function applyChatItems(current: PlanLine[], incoming: ChatPlanItem[], newKey: () => string): PlanLine[] {
  const byEvent = new Map(incoming.filter((item) => item.eventId && !item.remove).map((item) => [item.eventId!, item]));
  const calendarRows = current
    .filter((line) => line.eventId)
    .map((line) => {
      const next = byEvent.get(line.eventId!);
      if (!next) return line;
      const updated: PlanLine = {
        ...line,
        date: next.date,
        start: next.start,
        end: next.end,
        title: next.title.trim(),
        calendarId: next.calendarId || line.calendarId,
      };
      const changed =
        updated.title !== line.title ||
        updated.start !== line.start ||
        updated.end !== line.end ||
        updated.date !== line.date ||
        updated.calendarId !== line.calendarId;
      updated.dirty = changed ? true : line.dirty;
      return updated;
    });
  const dropped = new Set(incoming.filter((item) => item.remove && item.key).map((item) => item.key!));
  const drafts = current.filter((line) => !line.eventId && !dropped.has(line.key));
  const added: PlanLine[] = [];
  for (const item of incoming) {
    if (item.eventId || item.remove || !item.title.trim()) continue;
    const match = item.key ? drafts.findIndex((line) => line.key === item.key) : -1;
    const next: PlanLine = {
      key: match >= 0 ? drafts[match]!.key : newKey(),
      date: item.date,
      start: item.start,
      end: item.end,
      title: item.title.trim(),
      calendarId: item.calendarId || "",
      origin: "draft",
      dirty: true,
    };
    if (match >= 0) drafts[match] = next;
    else added.push(next);
  }
  return sortPlanLines([...calendarRows, ...drafts, ...added]);
}

/** Date, then start, then end. Equal times keep their existing order. */
export function sortPlanLines<T extends { date: string; start: string; end: string }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const start = (parseClock(a.start) ?? 24 * 60) - (parseClock(b.start) ?? 24 * 60);
    if (start) return start;
    return (parseClock(a.end) ?? 24 * 60) - (parseClock(b.end) ?? 24 * 60);
  });
}

export function linesToCommit(lines: PlanLine[]): { create: PlanLine[]; update: PlanLine[] } {
  const ready = lines.filter((line) => line.title.trim() && parseClock(line.start) != null && parseClock(line.end) != null && line.calendarId);
  return {
    create: ready.filter((line) => !line.eventId),
    update: ready.filter((line) => line.eventId && line.dirty),
  };
}

export function lineFitsBlock(line: { date: string; start: string }, block: AgendaTimeBlock): boolean {
  if (!blockRunsOn(block, line.date)) return false;
  const start = parseClock(line.start);
  const from = parseClock(block.start);
  const until = parseClock(block.end);
  if (start == null || from == null || until == null) return false;
  return start >= from && start < until;
}

export function parsePlanReply(raw: string): { reply: string; items: ChatPlanItem[] } | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { reply?: unknown; items?: unknown };
    const items = Array.isArray(parsed.items) ? parsed.items.flatMap(cleanChatItem) : [];
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    return { reply, items };
  } catch {
    return null;
  }
}

function cleanChatItem(raw: unknown): ChatPlanItem[] {
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const date = typeof row.date === "string" ? row.date.trim() : "";
  const start = normalizeClock(row.start);
  const end = normalizeClock(row.end);
  const eventId = typeof row.eventId === "string" && row.eventId.trim() ? row.eventId.trim() : undefined;
  const key = typeof row.key === "string" && row.key.trim() ? row.key.trim() : undefined;
  if (row.remove === true && key) {
    return [{ eventId, key, date: date || "1970-01-01", start: start || "00:00", end: end || "00:15", title: title || key, calendarId: "", remove: true }];
  }
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !start || !end) return [];
  const calendarId = typeof row.calendarId === "string" ? row.calendarId.trim() : "";
  return [{ eventId, key, date, start, end, title: title.slice(0, 180), calendarId, remove: row.remove === true }];
}

export function cleanClientLine(raw: unknown): PlanLine | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const date = typeof row.date === "string" ? row.date.trim() : "";
  const start = normalizeClock(row.start);
  const end = normalizeClock(row.end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !start || !end) return null;
  const title = typeof row.title === "string" ? row.title.trim().slice(0, 180) : "";
  const calendarId = typeof row.calendarId === "string" ? row.calendarId.trim() : "";
  const eventId = typeof row.eventId === "string" && row.eventId.trim() ? row.eventId.trim() : undefined;
  const key = typeof row.key === "string" && row.key.trim() ? row.key.trim() : eventId || `${date}-${start}-${title}`;
  return {
    key,
    eventId,
    date,
    start,
    end,
    title,
    calendarId,
    origin: eventId ? "calendar" : "draft",
    dirty: row.dirty === true || !eventId,
  };
}

function normalizeClock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export async function loadStoredPlan(scope: PlanScope, start: string, profileId?: string): Promise<StoredPlan | null> {
  const file = await readPlanFile(profileId);
  return file.plans[planKey(scope, start)] ?? null;
}

export async function saveStoredPlan(plan: StoredPlan, start: string, profileId?: string): Promise<void> {
  const file = await readPlanFile(profileId);
  file.plans[planKey(plan.scope, start)] = {
    ...plan,
    items: plan.items.slice(0, 80),
    chat: plan.chat.slice(-16),
  };
  const target = agendaPlansPath(profileId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

async function readPlanFile(profileId?: string): Promise<PlanFile> {
  try {
    const raw = JSON.parse(await readFile(agendaPlansPath(profileId), "utf8")) as Partial<PlanFile>;
    return { plans: raw.plans && typeof raw.plans === "object" ? raw.plans : {} };
  } catch {
    return { plans: {} };
  }
}
