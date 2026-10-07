import type { CalendarRow } from "./policy.js";

export type CalendarCommand =
  | { op: "list"; start: string; end: string; calendarId?: string }
  | { op: "create"; calendarId: string; title: string; start: string; end: string }
  | { op: "delete"; query: string; start: string; end: string }
  | { op: "move"; query: string; start: string; end: string; newStart: string; newEnd: string };

export interface CalendarPlan {
  commands: CalendarCommand[];
  /** Spoken when the request cannot be carried out yet. */
  clarify?: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function parts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const bag = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    weekday: String(bag.weekday ?? "").slice(0, 3).toLowerCase(),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const zoned = parts(date, timeZone);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
  return asUtc - date.getTime();
}

export function zonedDateTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

function addDays(partsOfDay: ZonedParts, days: number, timeZone: string): ZonedParts {
  const noon = zonedDateTime(timeZone, partsOfDay.year, partsOfDay.month, partsOfDay.day, 12);
  return parts(new Date(noon.getTime() + days * 86_400_000), timeZone);
}

function dayRange(day: ZonedParts, timeZone: string): { start: string; end: string } {
  const start = zonedDateTime(timeZone, day.year, day.month, day.day, 0, 0);
  const next = addDays(day, 1, timeZone);
  const end = zonedDateTime(timeZone, next.year, next.month, next.day, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

const MONTH =
  "january|february|march|april|may|june|july|august|september|sept|sep|october|november|december|jan|feb|mar|apr|jun|jul|aug|oct|nov|dec";
const MONTH_NUMBER: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const WEEKDAY_WORD =
  "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat";

function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase().replace(/\./g, "");
  return MONTH_NUMBER[key] ?? MONTH_NUMBER[key.slice(0, 3)];
}

/** "Sun, Sept 27" or "September 27" anywhere in the note. A weekday inside an event title does not count. */
function explicitDatePhrase(text: string): string | undefined {
  const re = new RegExp(
    `\\b(?:(?:${WEEKDAY_WORD})\\s*,\\s*)?(?:${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?`,
    "i",
  );
  return text.match(re)?.[0];
}

function calendarDate(text: string, now: Date, timeZone: string): { start: string; end: string } | null {
  const today = parts(now, timeZone);
  const forward = text.match(
    new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`, "i"),
  );
  const backward = forward
    ? null
    : text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, "i"));
  const month = monthNumber((forward?.[1] ?? backward?.[2] ?? "").replace(/\.$/, ""));
  const day = Number(forward?.[2] ?? backward?.[1]);
  const year = Number(forward?.[3] ?? backward?.[3]) || today.year;
  if (!month || !day || day > 31) return null;
  const resolved = parts(zonedDateTime(timeZone, year, month, day, 12, 0), timeZone);
  if (resolved.month !== month || resolved.day !== day) return null;
  return dayRange(resolved, timeZone);
}

function rangeFor(task: string, now: Date, timeZone: string): { start: string; end: string } {
  const dated = calendarDate(task, now, timeZone);
  if (dated) return dated;
  const today = parts(now, timeZone);
  const text = task.toLowerCase();
  if (/\btomorrow\b/.test(text)) return dayRange(addDays(today, 1, timeZone), timeZone);
  const weekday = WEEKDAYS.find((name) => new RegExp(`\\b${name}(?:day|nesday|rsday|urday)?\\b`).test(text));
  if (weekday && !/\btoday\b/.test(text)) {
    const current = WEEKDAYS.indexOf(today.weekday.slice(0, 3) as (typeof WEEKDAYS)[number]);
    const target = WEEKDAYS.indexOf(weekday);
    const delta = (target - current + 7) % 7;
    return dayRange(addDays(today, delta, timeZone), timeZone);
  }
  if (/\bthis week\b|\bnext 7 days\b|\bweek\b/.test(text)) {
    const start = zonedDateTime(timeZone, today.year, today.month, today.day, 0, 0);
    const last = addDays(today, 7, timeZone);
    const end = zonedDateTime(timeZone, last.year, last.month, last.day, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return dayRange(today, timeZone);
}

interface ClockHit {
  hour: number;
  minute: number;
  endHour?: number;
  endMinute?: number;
}

function normalizeSchedulingText(text: string): string {
  return text.replace(/[—–−]/g, "-").replace(/@/g, " ").replace(/\s+/g, " ").trim();
}

function parseTimeToken(raw: string): { hour: number; minute: number; meridiem: "a" | "p" | null } | null {
  const match = raw
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?(?:\s*(a\.?m\.?|p\.?m\.?)|([ap]))?$/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (minute > 59 || hour > 23) return null;
  const tag = (match[3] ?? match[4])?.toLowerCase().replace(/\./g, "");
  if (!tag) return { hour, minute, meridiem: null };
  if (hour < 1 || hour > 12) return null;
  return { hour, minute, meridiem: tag.startsWith("p") ? "p" : "a" };
}

function applyMeridiem(hour: number, meridiem: "a" | "p" | null): number | null {
  if (!meridiem) return hour > 12 && hour <= 23 ? hour : null;
  if (meridiem === "p" && hour < 12) return hour + 12;
  if (meridiem === "a" && hour === 12) return 0;
  return hour;
}

function resolvePair(
  start: { hour: number; minute: number; meridiem: "a" | "p" | null },
  end: { hour: number; minute: number; meridiem: "a" | "p" | null },
): ClockHit | null {
  let startMeridiem = start.meridiem;
  let endMeridiem = end.meridiem;
  if (!startMeridiem && endMeridiem && start.hour <= 12) {
    const crossesNoon = start.hour !== 12 && start.hour > end.hour && end.hour <= 12;
    startMeridiem = crossesNoon ? (endMeridiem === "p" ? "a" : "p") : endMeridiem;
  }
  if (!endMeridiem && startMeridiem && end.hour <= 12) endMeridiem = startMeridiem;
  const startHour = applyMeridiem(start.hour, startMeridiem);
  const endHour = applyMeridiem(end.hour, endMeridiem);
  if (startHour === null || endHour === null) return null;
  return { hour: startHour, minute: start.minute, endHour, endMinute: end.minute };
}

/** A clock time, including ranges such as 8:00–8:45 AM. Bare hours without AM/PM stay unknown. */
function findClock(task: string): ClockHit | null {
  const text = normalizeSchedulingText(task);
  const range = text.match(
    /\b(\d{1,2}(?::\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?)|[ap])?)\s*(?:-|\bto\b)\s*(\d{1,2}(?::\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?)|[ap])?)\b/i,
  );
  if (range) {
    const start = parseTimeToken(range[1] ?? "");
    const end = parseTimeToken(range[2] ?? "");
    if (start && end) {
      const resolved = resolvePair(start, end);
      if (resolved) return resolved;
    }
  }
  const spoken = text.match(/\b(?:at\s+|from\s+)?(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (spoken) {
    const parsed = parseTimeToken(`${spoken[1]} ${spoken[2]}`);
    const hour = parsed ? applyMeridiem(parsed.hour, parsed.meridiem) : null;
    if (parsed && hour !== null) return { hour, minute: parsed.minute };
  }
  const attached = text.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?)([ap])(?![a-z])/i);
  if (attached) {
    const parsed = parseTimeToken(`${attached[1]}${attached[2]}`);
    const hour = parsed ? applyMeridiem(parsed.hour, parsed.meridiem) : null;
    if (parsed && hour !== null) return { hour, minute: parsed.minute };
  }
  const h24 = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2] ?? "0");
    if (hour > 12 && hour <= 23 && minute <= 59) return { hour, minute };
  }
  return null;
}

function firstClock(texts: string[]): ClockHit | null {
  for (const text of texts) {
    const hit = findClock(text);
    if (hit) return hit;
  }
  return null;
}

function physicalLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

interface AgendaItem {
  title: string;
  time: ClockHit;
}

function lineTitle(line: string, calendars: CalendarRow[]): string | undefined {
  const parts = normalizeSchedulingText(line).split(/\s+-\s+/);
  if (parts.length >= 2) {
    const title = cleanTitle(parts.slice(1).join(" - "));
    if (title.length >= 2) return title;
  }
  return leftoverTitle(line, calendars);
}

function lineItems(text: string, calendars: CalendarRow[]): AgendaItem[] {
  const items: AgendaItem[] = [];
  const seen = new Set<string>();
  for (const line of physicalLines(text)) {
    const time = findClock(line);
    if (!time) continue;
    const title = lineTitle(line, calendars);
    if (!title) continue;
    const key = `${title.toLowerCase()}|${time.hour}|${time.minute}|${time.endHour ?? ""}|${time.endMinute ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ title, time });
  }
  return items;
}

/** Two or more timed lines are a whole agenda. Event titles are not searched for a calendar name. */
function agendaBatch(task: string, context: string | undefined, calendars: CalendarRow[]): AgendaItem[] {
  const fromUsers = lineItems(userLines(context).join("\n"), calendars);
  if (fromUsers.length >= 2) return fromUsers;
  const fromTask = lineItems(task, calendars);
  return fromTask.length >= 2 ? fromTask : [];
}

export function timeRangeCount(text: string): number {
  return normalizeSchedulingText(text).match(/\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:-|\bto\b)\s*\d{1,2}:\d{2}/gi)?.length ?? 0;
}

/** A flattened paste still contains several ranges, but not one event per line. */
export function agendaNeedsRewrite(text: string, calendars: CalendarRow[]): boolean {
  const ranges = timeRangeCount(text);
  if (ranges < 2) return false;
  return lineItems(text, calendars).length < ranges;
}

function mentionsNamedDay(line: string): boolean {
  return new RegExp(`\\b(?:${WEEKDAY_WORD})\\b|\\b(?:${MONTH})\\.?\\s+\\d{1,2}\\b|\\b(?:today|tomorrow)\\b`, "i").test(
    line,
  );
}

/** A day named in the note, including when it shares a paragraph with the events. */
export function agendaDateHeading(text: string): string {
  const heads = physicalLines(text).filter((line) => !findClock(line) && mentionsNamedDay(line));
  if (heads.length) return heads.join("\n");
  return explicitDatePhrase(text) ?? "";
}

/** The day for a multi-event note. Weekdays inside event titles are not the day of the list. */
function batchDayText(task: string): string {
  return explicitDatePhrase(task) ?? physicalLines(task).filter((line) => !findClock(line)).join("\n");
}

/** Keep a model split only when it is at least two timed lines. A named day stays on its own line. */
export function agendaRewrite(rewritten: string): string | null {
  const stripped = rewritten.replace(/```[\w-]*|```/g, "").trim();
  const all = physicalLines(stripped);
  const lines = all.filter((line) => findClock(line) && lineTitle(line, []));
  if (lines.length < 2) return null;
  const heads = all.filter((line) => !findClock(line) && mentionsNamedDay(line));
  return [...heads, ...lines].join("\n");
}

function calendarHint(task: string, context: string | undefined): string {
  const lines = physicalLines([task, ...userLines(context)].join("\n"));
  return lines.filter((line) => !findClock(line)).join("\n");
}

function durationMs(task: string): number {
  const minutes = task.match(/\bfor\s+(\d+)\s*min(?:ute)?s?\b/i);
  if (minutes) return Number(minutes[1]) * 60_000;
  const hours = task.match(/\bfor\s+(\d+(?:\.\d+)?)\s*h(?:ou)?rs?\b/i);
  if (hours) return Number(hours[1]) * 3_600_000;
  return 3_600_000;
}

function quoted(task: string): string | undefined {
  const match = task.match(/[“"]([^”"]+)[”"]/);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function namedTitle(task: string): string | undefined {
  const match = task.match(/\b(?:called|titled|named)\s+(.+?)(?:\s+\b(?:on|at|for|tomorrow|today)\b|$)/i);
  const value = match?.[1]?.trim().replace(/[.?!]+$/, "");
  return value || undefined;
}

function cleanTitle(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s\-:,.]+/, "")
    .replace(/[\s\-:,.]+$/, "")
    .replace(/^(?:to|on|at|for|my|the|this|a|an)\b\s*/i, "")
    .replace(/\s+\b(?:to|on|at|for|my|the|calendar)\b\s*$/i, "")
    .trim();
}

function leftoverTitle(text: string, calendars: CalendarRow[]): string | undefined {
  let rest = normalizeSchedulingText(text);
  rest = rest.replace(
    /\b\d{1,2}(?::\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?)|[ap])?\s*(?:-|\bto\b)\s*\d{1,2}(?::\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?)|[ap])?\b/gi,
    " ",
  );
  rest = rest.replace(/\b(?:at\s+|from\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, " ");
  rest = rest.replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?[ap]\b/gi, " ");
  rest = rest.replace(/\b(?:please|can you|could you|i want to|i'd like to|i would like to)\b/gi, " ");
  rest = rest.replace(/\b(?:add|create|schedule|book|put)\b(?:\s+this)?/gi, " ");
  rest = rest.replace(/\b(?:to|on|in)\s+(?:my|the)\s+.+?\bcalendar\b/gi, " ");
  rest = rest.replace(/\b(?:today|tomorrow|this week)\b/gi, " ");
  rest = rest.replace(/\b(?:on\s+)?(?:sun|mon|tues|wednes|thurs|fri|satur)day\b/gi, " ");
  for (const calendar of calendars) {
    const title = calendar.title.trim();
    if (title.length < 2) continue;
    rest = rest.replace(new RegExp(`(?:^|\\W)${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\W)`, "ig"), " ");
  }
  const value = cleanTitle(rest);
  if (value.length < 2 || /^(?:it|this|that|event|calendar)$/i.test(value)) return undefined;
  return value;
}

function eventTitle(texts: string[], calendars: CalendarRow[]): string | undefined {
  for (const text of texts) {
    const named = quoted(text) ?? namedTitle(text);
    if (named) return named;
  }
  const creatable = texts.filter((text) => looksLikeCreate(text));
  for (const text of creatable) {
    const title = leftoverTitle(text, calendars);
    if (title) return title;
  }
  return undefined;
}

function containsPhrase(hay: string, needle: string): boolean {
  const trimmed = needle.trim();
  if (trimmed.length < 2) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, "i").test(hay);
}

function titleTokenHits(task: string, calendars: CalendarRow[]): CalendarRow[] {
  return calendars.filter((calendar) => {
    const tokens = calendar.title.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    return tokens.some((token) => containsPhrase(task, token));
  });
}

function calendarHits(task: string, calendars: CalendarRow[]): CalendarRow[] {
  const exact = calendars.filter((calendar) => containsPhrase(task, calendar.title));
  const hits = exact.length > 0 ? exact : titleTokenHits(task, calendars);
  const sources = new Set(hits.map((calendar) => calendar.sourceTitle.toLowerCase()));
  if (sources.size < 2) return hits;
  const narrowed = hits.filter((calendar) => containsPhrase(task, calendar.sourceTitle));
  return narrowed.length > 0 ? narrowed : hits;
}

function chooseCalendar(task: string, calendars: CalendarRow[], writableOnly: boolean): CalendarRow | string {
  const pool = writableOnly ? calendars.filter((calendar) => calendar.access === "write") : calendars;
  const hits = calendarHits(task, pool);
  const uniqueTitles = new Set(hits.map((calendar) => `${calendar.sourceTitle}\0${calendar.title}`));
  if (uniqueTitles.size === 1) return hits[0]!;
  if (hits.length > 1) {
    const names = [...uniqueTitles].map((key) => {
      const [source, title] = key.split("\0");
      return `${title} (${source})`;
    });
    return `Which calendar: ${names.join(", ")}?`;
  }
  if (pool.length === 1 && pool[0]) return pool[0];
  return "Which calendar should I use? Name the account and the calendar.";
}

function looksLikeList(task: string): boolean {
  return /\b(what(?:'s| is) on|schedule|agenda|events|calendar|busy|free)\b/i.test(task);
}

function looksLikeCreate(task: string): boolean {
  if (/\b(add|create|book)\b/i.test(task)) return true;
  if (/\b(my|the|this|today'?s)\s+schedule\b/i.test(task)) return false;
  return /\bschedule\b/i.test(task);
}

function userLines(context?: string): string[] {
  if (!context) return [];
  return [...context.matchAll(/(?:^|\n)user:\s*([\s\S]*?)(?=\n(?:system|user|assistant|tool):|$)/gi)]
    .map((match) => match[1]?.replace(/\s+/g, " ").trim() ?? "")
    .filter(Boolean);
}

/** Newest user wording first, then the delegated task, so a follow-up time still counts. */
function schedulingTexts(task: string, context?: string): string[] {
  const users = userLines(context).reverse();
  return [...users, task].filter((text) => text.trim().length > 0);
}

function textWithDay(texts: string[]): string {
  const cue =
    /\b(today|tomorrow|this week|next 7 days|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
  return texts.find((text) => cue.test(text)) ?? texts.at(-1) ?? "";
}

function spanOnDay(
  time: ClockHit,
  dayParts: ZonedParts,
  timeZone: string,
  durationText: string,
): { start: Date; end: Date } {
  const start = zonedDateTime(timeZone, dayParts.year, dayParts.month, dayParts.day, time.hour, time.minute);
  const endClock =
    time.endHour !== undefined
      ? zonedDateTime(timeZone, dayParts.year, dayParts.month, dayParts.day, time.endHour, time.endMinute ?? 0)
      : new Date(start.getTime() + durationMs(durationText));
  const end = endClock.getTime() <= start.getTime() ? new Date(endClock.getTime() + 86_400_000) : endClock;
  return { start, end };
}

function extractQuery(task: string, verb: RegExp): string | undefined {
  const fromQuotes = quoted(task);
  if (fromQuotes) return fromQuotes;
  const match = task.match(verb);
  const value = match?.[1]?.trim().replace(/[.?!]+$/, "");
  return value || undefined;
}

export function interpretCalendarTask(input: {
  task: string;
  now: Date;
  timeZone: string;
  calendars: CalendarRow[];
  /** Prior transcript, used when a follow-up supplies the time or the title. */
  context?: string;
}): CalendarPlan {
  const task = input.task.trim();
  const texts = schedulingTexts(task, input.context);
  const combined = texts.join("\n");
  const open = input.calendars.filter(
    (calendar) => calendar.access === "read" || calendar.access === "write",
  );
  if (open.length === 0) {
    return {
      commands: [],
      clarify:
        "No calendars are set to Read or Write. Choose access on the Context & Action Gateway page.",
    };
  }

  const window = rangeFor(task, input.now, input.timeZone);
  const searchEnd = new Date(input.now.getTime() + 14 * 86_400_000).toISOString();

  if (/\b(delete|cancel|remove)\b/i.test(task)) {
    const query = extractQuery(task, /\b(?:delete|cancel|remove)\s+(?:the\s+)?(.+?)(?:\s+\b(?:on|at|from|tomorrow|today)\b|$)/i);
    if (!query) return { commands: [], clarify: "Which event should I delete?" };
    return { commands: [{ op: "delete", query, start: input.now.toISOString(), end: searchEnd }] };
  }

  const users = userLines(input.context);
  const batch = agendaBatch(task, input.context, open);
  if (batch.length >= 2) {
    const hint = calendarHint(task, input.context);
    const chosen = chooseCalendar(hint, open, true);
    if (typeof chosen === "string") return { commands: [], clarify: chosen };
    const day = rangeFor(batchDayText(task), input.now, input.timeZone);
    const dayParts = parts(new Date(day.start), input.timeZone);
    return {
      commands: batch.map((item) => {
        const span = spanOnDay(item.time, dayParts, input.timeZone, task);
        return {
          op: "create" as const,
          calendarId: chosen.id,
          title: item.title,
          start: span.start.toISOString(),
          end: span.end.toISOString(),
        };
      }),
    };
  }

  const moving =
    /\b(move|reschedule)\b/i.test(task) ||
    (findClock(task) !== null && users.some((line) => /\b(move|reschedule)\b/i.test(line)));
  if (moving) {
    const query = extractQuery(combined, /\b(?:move|reschedule)\s+(?:the\s+)?(.+?)\s+\bto\b/i);
    const time = firstClock(texts);
    if (!query) return { commands: [], clarify: "Which event should I move?" };
    if (!time) return { commands: [], clarify: "What time should I move it to? Include AM or PM." };
    const day = rangeFor(textWithDay(texts), input.now, input.timeZone);
    const dayParts = parts(new Date(day.start), input.timeZone);
    const newStart = zonedDateTime(
      input.timeZone,
      dayParts.year,
      dayParts.month,
      dayParts.day,
      time.hour,
      time.minute,
    );
    const endClock =
      time.endHour !== undefined
        ? zonedDateTime(
            input.timeZone,
            dayParts.year,
            dayParts.month,
            dayParts.day,
            time.endHour,
            time.endMinute ?? 0,
          )
        : null;
    const newEnd = endClock ?? new Date(newStart.getTime() + durationMs(combined));
    const end = newEnd.getTime() <= newStart.getTime() ? new Date(newEnd.getTime() + 86_400_000) : newEnd;
    return {
      commands: [
        {
          op: "move",
          query,
          start: input.now.toISOString(),
          end: searchEnd,
          newStart: newStart.toISOString(),
          newEnd: end.toISOString(),
        },
      ],
    };
  }

  const creating =
    looksLikeCreate(task) || (findClock(task) !== null && users.some((line) => looksLikeCreate(line)));
  if (creating) {
    const title = eventTitle(texts, open);
    const time = firstClock(texts);
    if (!title) return { commands: [], clarify: "What should I call the event?" };
    if (!time) return { commands: [], clarify: "What time should I add it? Include AM or PM." };
    const chosen = chooseCalendar(combined, open, true);
    if (typeof chosen === "string") return { commands: [], clarify: chosen };
    const day = rangeFor(textWithDay(texts), input.now, input.timeZone);
    const dayParts = parts(new Date(day.start), input.timeZone);
    const start = zonedDateTime(
      input.timeZone,
      dayParts.year,
      dayParts.month,
      dayParts.day,
      time.hour,
      time.minute,
    );
    const endClock =
      time.endHour !== undefined
        ? zonedDateTime(
            input.timeZone,
            dayParts.year,
            dayParts.month,
            dayParts.day,
            time.endHour,
            time.endMinute ?? 0,
          )
        : new Date(start.getTime() + durationMs(combined));
    const end = endClock.getTime() <= start.getTime() ? new Date(endClock.getTime() + 86_400_000) : endClock;
    return {
      commands: [
        {
          op: "create",
          calendarId: chosen.id,
          title,
          start: start.toISOString(),
          end: end.toISOString(),
        },
      ],
    };
  }

  if (looksLikeList(task) || task.length > 0) {
    const hits = calendarHits(task, open);
    const calendarId = hits.length === 1 ? hits[0]?.id : undefined;
    if (hits.length > 1 && new Set(hits.map((hit) => hit.title.toLowerCase())).size === 1) {
      const names = hits.map((hit) => `${hit.title} (${hit.sourceTitle})`).join(", ");
      return { commands: [], clarify: `Which calendar: ${names}?` };
    }
    return { commands: [{ op: "list", ...window, calendarId }] };
  }

  return {
    commands: [],
    clarify: "I can read or change the calendars you opened in Context & Action Gateway.",
  };
}
