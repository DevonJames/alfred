import { loadBriefingConfig, type BriefingConfig } from "./config.js";
import { speakClockTime, speakMonthDay, speakWeekday } from "./speech.js";

export type CurrentTimeKind = "time" | "date";

export interface CurrentTimeQuery {
  /** City or region. Omit for the briefing timezone. */
  place?: string;
  /** time speaks the clock. date speaks the weekday and calendar date. */
  kind?: CurrentTimeKind;
}

const PLACES: Record<string, string> = {
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  "las vegas": "America/Los_Angeles",
  phoenix: "America/Phoenix",
  denver: "America/Denver",
  chicago: "America/Chicago",
  dallas: "America/Chicago",
  houston: "America/Chicago",
  "new york": "America/New_York",
  nyc: "America/New_York",
  boston: "America/New_York",
  washington: "America/New_York",
  dc: "America/New_York",
  miami: "America/New_York",
  atlanta: "America/New_York",
  anchorage: "America/Anchorage",
  hawaii: "Pacific/Honolulu",
  honolulu: "Pacific/Honolulu",
  london: "Europe/London",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  utc: "UTC",
  gmt: "Etc/GMT",
  tokyo: "Asia/Tokyo",
  japan: "Asia/Tokyo",
  sydney: "Australia/Sydney",
  dubai: "Asia/Dubai",
  singapore: "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  "mexico city": "America/Mexico_City",
};

export function resolveSpokenTimezone(place: string | undefined): string | null {
  const key = place?.trim().toLowerCase().replace(/[?.!,]+$/g, "").replace(/\s+/g, " ");
  if (!key) return null;
  return PLACES[key] ?? null;
}

function speakZone(now: Date, timezone: string): string {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "long",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
  return (name ?? timezone).toLowerCase();
}

export function formatCurrentTimeSpeech(opts: {
  now: Date;
  timezone: string;
  kind: CurrentTimeKind;
  placeLabel?: string;
}): string {
  const { now, timezone, kind } = opts;
  const where = opts.placeLabel ? `In ${opts.placeLabel}, ` : "";
  const clock = speakClockTime(now, timezone);
  const weekday = speakWeekday(now, timezone);
  const zone = speakZone(now, timezone);
  if (kind === "date") {
    return `${where}it's ${weekday}, ${speakMonthDay(now, timezone)}.`.replace(/^./, (c) => c.toUpperCase());
  }
  return `${where}it's ${clock} on ${weekday}, ${zone}.`.replace(/^./, (c) => c.toUpperCase());
}

export async function lookupCurrentTime(
  query: CurrentTimeQuery = {},
  configOverrides: Partial<BriefingConfig> = {},
  now = new Date(),
): Promise<string> {
  const config = loadBriefingConfig(configOverrides);
  const kind = query.kind === "date" ? "date" : "time";
  const requested = query.place?.trim();
  if (requested) {
    const timezone = resolveSpokenTimezone(requested);
    if (!timezone) {
      const home = formatCurrentTimeSpeech({ now, timezone: config.timezone, kind, placeLabel: undefined });
      return `I don't know the timezone for ${requested}. ${home}`;
    }
    const label = requested.replace(/\b\w/g, (letter) => letter.toUpperCase());
    return formatCurrentTimeSpeech({ now, timezone, kind, placeLabel: label });
  }
  return formatCurrentTimeSpeech({ now, timezone: config.timezone, kind });
}
