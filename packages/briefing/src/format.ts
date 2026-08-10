import type { BriefingData } from "./types.js";
import { formatLaunchesMarkdown, formatLaunchesSpeech } from "./launches.js";
import {
  formatMarketsMarkdown,
  formatMarketsSpeechFromQuotes,
} from "./markets.js";
import { formatNewsMarkdown, formatNewsSpeech } from "./news.js";
import { formatRemindersMarkdown, formatRemindersSpeech } from "./reminders.js";
import {
  closingLine,
  sanitizeForSpeech,
  speakMonthDay,
  speakWeekday,
} from "./speech.js";
import { formatWeatherMarkdown, formatWeatherSpeech } from "./weather.js";

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

  const greeting = data.greeting.replace(/[.!?]+$/g, "").trim();
  parts.push(`${greeting}, sir.`);

  // Prefer structured date; fall back to dayKey
  try {
    const dayName = speakWeekday(now, timezone);
    const monthDay = speakMonthDay(now, timezone);
    parts.push(`Today is ${dayName}, ${monthDay}.`);
  } catch {
    if (data.date) parts.push(`Today is ${data.date}.`);
  }

  if (data.weather) parts.push(formatWeatherSpeech(data.weather));
  else if (data.weatherText) parts.push(data.weatherText);

  const rem = formatRemindersSpeech(data.reminders) || data.remindersText;
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

  const news = formatNewsSpeech(data.news);
  if (news) parts.push(news);

  parts.push(closingLine(now, timezone));

  return sanitizeForSpeech(parts.join(" "));
}

export function formatBriefingAsMarkdown(data: BriefingData): string {
  const sections: string[] = [`# Daily Briefing — ${data.date}`, "", data.greeting];
  if (data.weather) sections.push("", formatWeatherMarkdown(data.weather));
  if (data.reminders.length) sections.push("", formatRemindersMarkdown(data.reminders));
  if (data.markets.lines.length) sections.push("", formatMarketsMarkdown(data.markets.lines));
  if (data.launches.length) sections.push("", formatLaunchesMarkdown(data.launches));
  if (data.news.length) sections.push("", formatNewsMarkdown(data.news));
  sections.push("", `_Generated ${data.generated}_`);
  return sections.join("\n");
}
