import { loadXIngestDigest, type OipLocalMemoryProvider } from "@alfred/memory";
import type { BriefingConfig } from "./config.js";
import {
  briefingDayWindowEndIso,
  formatBriefingDateLabel,
  getBriefingDayKey,
} from "./day.js";
import { BriefingCache } from "./cache.js";
import { formatBriefingAsMarkdown, formatBriefingForSpeech } from "./format.js";
import { buildGreeting, type GreetingLlm } from "./greeting.js";
import { fetchLaunches, formatLaunchesSpeech } from "./launches.js";
import {
  fetchCrypto,
  fetchIndex,
  fetchMetals,
  formatCryptoDisplay,
  formatIndexDisplay,
  formatMarketsSpeechFromQuotes,
  formatMetalsDisplay,
} from "./markets.js";
import { fetchNewsHeadlines, formatNewsSpeech } from "./news.js";
import {
  formatRemindersSpeech,
  loadDueReminders,
  markRemindersSurfaced,
} from "./reminders.js";
import type { BriefingData, BriefingPayload } from "./types.js";
import { fetchWeather, formatWeatherSpeech } from "./weather.js";
import { toXIngestBriefing } from "./x-ingest.js";

export interface GenerateBriefingOptions {
  config: BriefingConfig;
  memory?: OipLocalMemoryProvider | null;
  now?: Date;
  refresh?: boolean;
  llm?: GreetingLlm | null;
  markSurfaced?: boolean;
}

export async function generateBriefing(
  opts: GenerateBriefingOptions,
): Promise<BriefingPayload> {
  const now = opts.now ?? new Date();
  const { config } = opts;
  const dayKey = getBriefingDayKey(now, config.timezone, config.dayStart);
  const cache = new BriefingCache(config.cacheDir);

  if (!opts.refresh) {
    const hit = await cache.get(dayKey);
    if (hit) return hit;
  }

  const dateLabel = formatBriefingDateLabel(dayKey, config.timezone);
  const windowEnd = briefingDayWindowEndIso(dayKey, config.timezone, config.dayStart);

  const weather = config.zip ? await fetchWeather(config.zip) : null;
  const weatherText = weather ? formatWeatherSpeech(weather) : null;

  const greeting = await buildGreeting({
    now,
    timezone: config.timezone,
    userName: config.userName,
    dateLabel,
    weatherSummary: weather
      ? `${weather.current.condition}, ${weather.current.temperature}°`
      : null,
    llmGreeting: config.llmGreeting,
    llm: opts.llm,
  });

  const [launches, crypto, headlines, reminders] = await Promise.all([
    fetchLaunches(config.launchLocationIds),
    fetchCrypto(config.cryptoId),
    fetchNewsHeadlines(config.newsSources),
    loadDueReminders(opts.memory, {
      date: dayKey,
      timezone: config.timezone,
      windowEnd,
    }),
  ]);

  const marketLines: string[] = [];
  if (crypto) marketLines.push(formatCryptoDisplay(crypto, config.cryptoId));

  let indexQuote = null;
  let metalsQuote = null;
  if (config.includeIndex) {
    indexQuote = await fetchIndex(config.indexSymbol);
    if (indexQuote) marketLines.push(formatIndexDisplay(indexQuote, config.indexSymbol));
  }
  if (config.includeMetals) {
    metalsQuote = await fetchMetals(config.metalSymbol);
    if (metalsQuote) marketLines.push(formatMetalsDisplay(metalsQuote, config.metalSymbol));
  }

  const marketsText =
    formatMarketsSpeechFromQuotes({
      crypto,
      cryptoId: config.cryptoId,
      index: indexQuote,
      indexSymbol: config.includeIndex ? config.indexSymbol : null,
      metals: metalsQuote,
      metalSymbol: config.includeMetals ? config.metalSymbol : null,
    }) || null;

  const xDigest = await loadXIngestDigest(config.profileId, dayKey, config.cacheDir);
  const xIngest = toXIngestBriefing(xDigest);

  const data: BriefingData = {
    greeting,
    date: dateLabel,
    dayKey,
    weather,
    weatherText,
    launches,
    launchesText: formatLaunchesSpeech(launches),
    markets: {
      crypto,
      cryptoId: config.cryptoId,
      index: indexQuote,
      indexSymbol: config.includeIndex ? config.indexSymbol : null,
      metals: metalsQuote,
      metalSymbol: config.includeMetals ? config.metalSymbol : null,
      lines: marketLines,
    },
    marketsText,
    news: headlines,
    newsText: formatNewsSpeech(headlines) || null,
    xIngest,
    xIngestText: xIngest?.speech ?? null,
    reminders,
    remindersText: formatRemindersSpeech(reminders) || null,
    generated: now.toISOString(),
  };

  const payload: BriefingPayload = {
    briefing: data,
    speech: formatBriefingForSpeech(data, { now, timezone: config.timezone }),
    markdown: formatBriefingAsMarkdown(data),
    generated: data.generated,
  };

  await cache.set(dayKey, payload);

  if (opts.markSurfaced && reminders.length) {
    await markRemindersSurfaced(opts.memory, reminders);
  }

  return payload;
}
