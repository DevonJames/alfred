/**
 * Briefing day rolls at a local wall-clock time (default 04:30), not midnight.
 * Times before dayStart belong to the previous briefing day key.
 */

export function parseHm(dayStart: string): { hour: number; minute: number } {
  const [h, m] = dayStart.split(":").map(Number);
  return { hour: h ?? 4, minute: m ?? 30 };
}

/** Local calendar parts in an IANA timezone. */
export function localDateTimeParts(
  now: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addCalendarDays(year: number, month: number, day: number, delta: number): string {
  // noon UTC avoids DST edge when shifting civil dates
  const dt = new Date(Date.UTC(year, month - 1, day + delta, 12, 0, 0));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Returns YYYY-MM-DD briefing day key for `now` in `timezone`.
 * Before `dayStart` (HH:MM local), the key is the previous civil date.
 */
export function getBriefingDayKey(
  now: Date,
  timezone: string,
  dayStart = "04:30",
): string {
  const local = localDateTimeParts(now, timezone);
  const { hour, minute } = parseHm(dayStart);
  const mins = local.hour * 60 + local.minute;
  const startMins = hour * 60 + minute;
  if (mins < startMins) {
    return addCalendarDays(local.year, local.month, local.day, -1);
  }
  return ymd(local.year, local.month, local.day);
}

/** Long locale date string for the briefing day key. */
export function formatBriefingDateLabel(dayKey: string, timezone: string): string {
  const noonLocalGuess = new Date(`${dayKey}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(noonLocalGuess);
}

/** End of briefing day as comparable ISO (for reminder windowEnd). */
export function briefingDayWindowEndIso(
  dayKey: string,
  timezone: string,
  dayStart = "04:30",
): string {
  // Window ends at next day's dayStart local.
  const [y, m, d] = dayKey.split("-").map(Number);
  const nextKey = addCalendarDays(y!, m!, d!, 1);
  const { hour, minute } = parseHm(dayStart);
  // Convert nextKey @ dayStart local → UTC via offset sample
  const probe = new Date(`${nextKey}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(probe);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = localAsUtc - probe.getTime();
  const targetUtc = Date.UTC(Number(nextKey.slice(0, 4)), Number(nextKey.slice(5, 7)) - 1, Number(nextKey.slice(8, 10)), hour, minute, 0) - offsetMs;
  // End of window is one ms before next dayStart
  return new Date(targetUtc - 1).toISOString();
}

export function timeOfDayGreeting(now: Date, timezone: string): string {
  const { hour } = localDateTimeParts(now, timezone);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
