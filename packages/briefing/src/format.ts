import { formatAgendaMarkdown, formatAgendaSpeech } from "./agenda.js";
import type { BriefingData } from "./types.js";
import { formatLaunchesMarkdown, formatLaunchesSpeech } from "./launches.js";
import {
  formatMarketsMarkdown,
  formatMarketsSpeechFromQuotes,
} from "./markets.js";
import { formatNewsMarkdown, formatNewsSpeech } from "./news.js";
import { formatRemindersMarkdown, formatRemindersSpeech, formatTaskMarkdown, formatTaskSpeech } from "./reminders.js";
import {
  closingLine,
  sanitizeForSpeech,
  speakMonthDay,
  speakWallClock,
  speakWeekday,
} from "./speech.js";
import { formatWeatherMarkdown, formatWeatherSpeech } from "./weather.js";
import { formatXIngestMarkdown } from "./x-ingest.js";

/**
 * Spoken narration for TTS. Built separately from markdown/display text
 * (alfred-home pattern: formatBriefingForSpeech vs formatBriefingForDisplay).
 */
export function formatBriefingForSpeech(
  data: BriefingData,
  opts?: { now?: Date; timezone?: string },
): string {
  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "America/Los_Angeles";
  const parts: string[] = [];

  // Greeting must be a short salutation only (e.g. "Good evening") — not a mini-briefing.
  const greeting = data.greeting
    .replace(/[.!?]+$/g, "")
    .replace(/,?\s*sir$/i, "")
    .trim();
  parts.push(`${greeting}, sir.`);

  try {
    const dayName = speakWeekday(now, timezone);
    const monthDay = speakMonthDay(now, timezone);
    const wall = speakWallClock(now, timezone);
    parts.push(`It is ${dayName}, ${monthDay} at ${wall}.`);
  } catch {
    if (data.date) parts.push(`It is ${data.date}.`);
  }

  if (data.weather) parts.push(formatWeatherSpeech(data.weather));
  else if (data.weatherText) parts.push(data.weatherText);

  const agenda = data.agendaText ?? (data.agenda ? formatAgendaSpeech(data.agenda, timezone) : null);
  if (agenda) parts.push(agenda);

  // Personal follow-ups right after the agenda, before markets / news.
  const rem = data.taskReminders?.length
    ? formatTaskSpeech(data.taskReminders)
    : formatRemindersSpeech(data.reminders) || data.remindersText;
  if (rem) parts.push(rem);

  const markets = formatMarketsSpeechFromQuotes({
    crypto: data.markets.crypto,
    cryptoId: data.markets.cryptoId,
    index: data.markets.index,
    indexSymbol:
      data.markets.indexSymbol === "sp500" || data.markets.indexSymbol === "dow"
        ? data.markets.indexSymbol
        : null,
    metals: data.markets.metals,
    metalSymbol:
      data.markets.metalSymbol === "gold" || data.markets.metalSymbol === "silver"
        ? data.markets.metalSymbol
        : null,
  });
  if (markets) parts.push(markets);

  const launches = formatLaunchesSpeech(data.launches);
  if (launches) parts.push(launches);

  const news = formatNewsSpeech(data.news, { inviteFollowUp: true });
  if (news) parts.push(news);

  const xIngest = data.xIngestText || data.xIngest?.speech;
  if (xIngest) parts.push(xIngest);

  parts.push(closingLine(now, timezone));

  return sanitizeForSpeech(parts.join(" "));
}

export function formatBriefingAsMarkdown(
  data: BriefingData,
  opts?: { timezone?: string },
): string {
  const timezone = opts?.timezone ?? "America/Los_Angeles";
  const sections: string[] = [`# Daily Briefing — ${data.date}`, "", data.greeting];
  if (data.weather) sections.push("", formatWeatherMarkdown(data.weather));
  if (data.agenda) sections.push("", formatAgendaMarkdown(data.agenda, timezone));
  if (data.taskReminders?.length) sections.push("", formatTaskMarkdown(data.taskReminders));
  else if (data.reminders.length) sections.push("", formatRemindersMarkdown(data.reminders));
  if (data.markets.lines.length) sections.push("", formatMarketsMarkdown(data.markets.lines));
  if (data.launches.length) sections.push("", formatLaunchesMarkdown(data.launches));
  if (data.news.length) sections.push("", formatNewsMarkdown(data.news));
  if (data.xIngest?.items.length) sections.push("", formatXIngestMarkdown({ items: data.xIngest.items }));
  sections.push("", `_Generated ${data.generated}_`);
  return sections.join("\n");
}
