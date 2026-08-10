import type { BriefingData } from "./types.js";
import { formatLaunchesMarkdown, formatLaunchesSpeech } from "./launches.js";
import { formatMarketsMarkdown } from "./markets.js";
import { formatNewsMarkdown, formatNewsSpeech } from "./news.js";
import { formatRemindersMarkdown, formatRemindersSpeech } from "./reminders.js";
import { formatWeatherMarkdown, formatWeatherSpeech } from "./weather.js";

export function formatBriefingForSpeech(data: BriefingData): string {
  const parts: string[] = [];
  if (data.greeting) parts.push(`${data.greeting}.`);
  if (data.weather) parts.push(formatWeatherSpeech(data.weather));
  else if (data.weatherText) parts.push(data.weatherText);

  const rem = data.remindersText ?? formatRemindersSpeech(data.reminders);
  if (rem) parts.push(rem);

  if (data.marketsText) parts.push(data.marketsText);
  if (data.launches.length) parts.push(formatLaunchesSpeech(data.launches));
  else if (data.launchesText) parts.push(data.launchesText);

  const news = data.newsText ?? formatNewsSpeech(data.news);
  if (news) parts.push(news);

  return parts
    .join(" ")
    .replace(/\[icon:[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
