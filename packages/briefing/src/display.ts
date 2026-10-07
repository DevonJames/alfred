import type { BriefingData } from "./types.js";
import type { LaunchInfo } from "./launches.js";
import type { NewsHeadline } from "./news.js";
import type { WeatherData } from "./weather.js";

/** One row in a briefing HUD section (plain text, or a clickable headline). */
export interface BriefingDisplayLine {
  text: string;
  /** 1-based index into the briefing news rundown — enables dig-in clicks. */
  newsIndex?: number;
  newsTitle?: string;
  newsUrl?: string;
}

/** One titled block in the voice HUD (data, not spoken narration). */
export interface BriefingDisplaySection {
  id: string;
  title?: string;
  lines: BriefingDisplayLine[];
}

/** Screen layout for Daily Brief — replaces the spoken paragraph in the voice UI. */
export interface BriefingDisplay {
  when: string;
  sections: BriefingDisplaySection[];
}

export function formatBriefingForDisplay(
  data: BriefingData,
  opts?: { now?: Date; timezone?: string },
): BriefingDisplay {
  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "America/Los_Angeles";
  const sections: BriefingDisplaySection[] = [];

  const weather = data.weather ? weatherLines(data.weather) : [];
  if (weather.length) sections.push({ id: "weather", lines: asLines(weather) });

  const agenda = agendaLines(data, timezone);
  if (agenda.length) sections.push({ id: "agenda", title: "Agenda", lines: asLines(agenda) });

  const due = dueLines(data);
  if (due.today.length) sections.push({ id: "due", title: "Due Today", lines: asLines(due.today) });
  if (due.open.length) sections.push({ id: "open", title: "Still Open", lines: asLines(due.open) });

  if (data.markets.lines.length) {
    sections.push({ id: "markets", lines: asLines(data.markets.lines) });
  }

  const launches = launchLines(data.launches);
  if (launches.length) sections.push({ id: "launches", title: "Launches", lines: asLines(launches) });

  const headlines = headlineLines(data.news);
  if (headlines.length) sections.push({ id: "headlines", title: "Headlines", lines: headlines });

  const notes = noteLines(data);
  if (notes.length) sections.push({ id: "notes", title: "Saved", lines: asLines(notes) });

  return {
    when: formatWhenLabel(now, timezone) || data.date,
    sections,
  };
}

/** Type guard for HUD payloads from the desktop. */
export function isBriefingDisplay(value: unknown): value is BriefingDisplay {
  if (!value || typeof value !== "object") return false;
  const v = value as BriefingDisplay;
  return typeof v.when === "string" && Array.isArray(v.sections);
}

function formatWhenLabel(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const weekday = get("weekday");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const dayPeriod = get("dayPeriod").toLowerCase().replace(/\./g, "");
    return `${weekday} ${month}/${day} @ ${hour}:${minute}${dayPeriod}`;
  } catch {
    return "";
  }
}

function weatherLines(weather: WeatherData): string[] {
  const lines: string[] = [];
  const hum = weather.current.humidity ?? 0;
  const humid = hum > 80 ? " - very humid" : hum > 60 ? " - a bit humid" : "";
  const wind = weather.current.windSpeed ?? 0;
  const windNote = wind > 20 ? " - quite windy" : wind > 10 ? " - some wind" : "";
  const extras = humid || windNote;

  for (const [i, day] of weather.daily.slice(0, 3).entries()) {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : "Next Day";
    const condition =
      day.condition.replace(/sky$/i, "").trim().toLowerCase() || day.condition.toLowerCase();
    if (i === 0) {
      const temp = Math.round(weather.current.temperature);
      const feels =
        weather.current.feelsLike != null && Math.round(weather.current.feelsLike) !== temp
          ? ` (feels like ${Math.round(weather.current.feelsLike)})`
          : "";
      lines.push(`${label}: ${temp} degrees & ${condition}${feels}${extras}`);
    } else {
      const high = Math.round(day.tempMax);
      const low = Math.round(day.tempMin);
      const precip = day.precipProbability >= 40 ? ` · ${day.precipProbability}% precip` : "";
      lines.push(`${label}: ${condition}, ${low}–${high}°${precip}`);
    }
  }
  return lines;
}

function agendaLines(data: BriefingData, timezone: string): string[] {
  if (!data.agenda?.length) return [];
  return data.agenda.map((event) => {
    const when = event.allDay
      ? "All day"
      : compactClockSpan(event.start, event.end, timezone);
    return `${when} ${event.title}`.trim();
  });
}

function compactClockSpan(startIso: string, endIso: string, timezone: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
    const hour = parts.find((p) => p.type === "hour")?.value ?? "";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "")
      .toLowerCase()
      .replace(/\./g, "");
    if (minute === "00") return `${hour}${period}`;
    return `${hour}:${minute}${period}`;
  };
  const start = fmt(startIso);
  const end = fmt(endIso);
  return start === end ? start : `${start}-${end}`;
}

function dueLines(data: BriefingData): { today: string[]; open: string[] } {
  if (data.taskReminders?.length) {
    const today: string[] = [];
    const open: string[] = [];
    for (const task of data.taskReminders) {
      const title = cleanTitle(task.title);
      if (task.overdue) open.push(title);
      else today.push(title);
    }
    return { today, open };
  }
  if (data.reminders.length) {
    return {
      today: data.reminders.slice(0, 12).map((r) =>
        cleanTitle(r.revision.text?.trim() || r.recordName || r.revision.name || "Reminder"),
      ),
      open: [],
    };
  }
  if (data.remindersText) {
    const stripped = data.remindersText
      .replace(/^You asked me to remind you:\s*/i, "")
      .replace(/^You have \d+ reminders:\s*/i, "")
      .replace(/^Today:\s*/i, "")
      .replace(/\.\s*$/, "");
    const parts = stripped.split(/;\s*/).map(cleanTitle).filter(Boolean);
    return { today: parts, open: [] };
  }
  return { today: [], open: [] };
}

function launchLines(launches: LaunchInfo[]): string[] {
  return launches.slice(0, 3).map((l) => {
    const when = l.net
      ? new Date(l.net).toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "TBA";
    const who = l.provider && l.provider !== "Unknown" ? `${l.provider} · ` : "";
    return `${who}${l.mission || l.name} — ${when}`;
  });
}

function asLines(texts: string[]): BriefingDisplayLine[] {
  return texts.map((text) => ({ text }));
}

function headlineLines(news: NewsHeadline[]): BriefingDisplayLine[] {
  return news.slice(0, 8).map((h, i) => {
    const n =
      ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"][i] ??
      `${i + 1}.`;
    return {
      text: `${n}: ${h.title}`,
      newsIndex: i + 1,
      newsTitle: h.title,
      newsUrl: h.url,
    };
  });
}

function noteLines(data: BriefingData): string[] {
  const items = data.xIngest?.items;
  if (!items?.length) {
    if (data.xIngestText) return [data.xIngestText];
    return [];
  }
  const ok = items.filter((i) => i.status === "ingested");
  const failed = items.filter((i) => i.status === "failed");
  const lines: string[] = [];
  for (const item of ok.slice(0, 4)) {
    lines.push(item.headline);
  }
  if (ok.length > 4) lines.push(`+${ok.length - 4} more saved`);
  if (failed.length) lines.push(`${failed.length} saved links could not be ingested`);
  return lines;
}

function cleanTitle(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim();
}
