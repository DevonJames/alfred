import { loadXIngestDigest, type OipLocalMemoryProvider } from "@alfred/memory";
import type { BriefingConfig } from "./config.js";
import {
  briefingDayWindowEndIso,
  formatBriefingDateLabel,
  getBriefingDayKey,
} from "./day.js";
import { BriefingCache } from "./cache.js";
import { formatBriefingForDisplay } from "./display.js";
import { formatBriefingAsMarkdown, formatBriefingForSpeech } from "./format.js";
import { buildGreeting, type GreetingLlm } from "./greeting.js";
import { buildHeadlineOffer } from "./headline-offer.js";
import { runEnabledBriefingModules } from "./modules.js";
// Built-in rocket launches are parked so a user-added module can supply them.
// Restore by uncommenting the fetchLaunches import and the call below.
// import { fetchLaunches, formatLaunchesSpeech } from "./launches.js";
import {
  fetchCrypto,
  fetchIndex,
  fetchMetals,
  formatCryptoDisplay,
  formatIndexDisplay,
  formatMarketsSpeechFromQuotes,
  formatMetalsDisplay,
} from "./markets.js";
import { fetchNewsHeadlines, formatNewsSpeech, normalizeNewsHeadlines } from "./news.js";
import {
  formatRemindersSpeech,
  formatTaskSpeech,
  loadDueReminders,
  markRemindersSurfaced,
  type TaskReminder,
} from "./reminders.js";
import type { BriefingData, BriefingPayload } from "./types.js";
import { fetchWeather, formatWeatherSpeech } from "./weather.js";
import { formatAgendaSpeech, type BriefingAgendaSlice } from "./agenda.js";
import { formatFitnessSpeech, type FitnessDayPlan } from "./fitness.js";
import { formatMedicineSpeech, type MedicineItem } from "./medicine.js";
import { toXIngestBriefing } from "./x-ingest.js";

export interface GenerateBriefingOptions {
  config: BriefingConfig;
  memory?: OipLocalMemoryProvider | null;
  now?: Date;
  refresh?: boolean;
  llm?: GreetingLlm | null;
  markSurfaced?: boolean;
  /** When set, the brief uses this list instead of memory reminders. */
  taskReminders?: () => Promise<TaskReminder[]>;
  /** Opt-in: include rocket launches only when the user asked for them. Default false. */
  includeLaunches?: boolean;
  /** Today's events from calendars selected under Settings → Briefing → Agenda. */
  agendaEvents?: (now: Date) => Promise<BriefingAgendaSlice>;
  /** Today's FitnessAlly snapshot, already filtered to the briefing day. */
  fitnessPlan?: (now: Date) => Promise<FitnessDayPlan | null>;
  /** Untaken morning medicine. Ignored unless config.includeMedicineMorning is set. */
  medicineItems?: (now: Date) => Promise<MedicineItem[]>;
}

export async function generateBriefing(
  opts: GenerateBriefingOptions,
): Promise<BriefingPayload> {
  const now = opts.now ?? new Date();
  const { config } = opts;
  const includeLaunches = opts.includeLaunches === true;
  const dayKey = getBriefingDayKey(now, config.timezone, config.dayStart);
  const cache = new BriefingCache(config.cacheDir);

  if (!opts.refresh) {
    const hit = await cache.get(dayKey, includeLaunches);
    if (hit) {
      hit.briefing.news = normalizeNewsHeadlines(hit.briefing.news);
      if (!config.includeIngestedNotes) {
        hit.briefing.xIngest = null;
        hit.briefing.xIngestText = null;
      }
      const agenda = await readAgenda(opts.agendaEvents, now);
      applyAgenda(hit.briefing, agenda, config.timezone);
      const fitness = await readFitness(opts.fitnessPlan, now);
      applyFitness(hit.briefing, fitness);
      const medicine = config.includeMedicineMorning
        ? await readMedicine(opts.medicineItems, now)
        : null;
      applyMedicine(hit.briefing, medicine);
      hit.briefing.modules = await runEnabledBriefingModules({
        llm: opts.llm,
        profileId: config.profileId,
      });
      if (hit.briefing.news.length) {
        hit.briefing.headlineOffer = await buildHeadlineOffer({
          llm: opts.llm,
          count: hit.briefing.news.length,
        });
      } else {
        hit.briefing.headlineOffer = null;
      }
      hit.speech = formatBriefingForSpeech(hit.briefing, { now, timezone: config.timezone });
      hit.markdown = formatBriefingAsMarkdown(hit.briefing, { timezone: config.timezone });
      hit.display = formatBriefingForDisplay(hit.briefing, { now, timezone: config.timezone });
      return hit;
    }
  }

  const dateLabel = formatBriefingDateLabel(dayKey, config.timezone);
  const windowEnd = briefingDayWindowEndIso(dayKey, config.timezone, config.dayStart);

  const weatherLocation = config.zip || (config.latitude != null && config.longitude != null ? "home" : null);
  const weather = weatherLocation
    ? await fetchWeather(
        weatherLocation,
        false,
        config.latitude != null && config.longitude != null
          ? {
              lat: config.latitude,
              lon: config.longitude,
              timezone: config.timezone,
              name: config.zip ?? "Home",
            }
          : null,
      )
    : null;
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

  const [crypto, headlines, memoryReminders, taskReminders] = await Promise.all([
    // includeLaunches ? fetchLaunches(config.launchLocationIds) : Promise.resolve([]),
    config.includeCrypto ? fetchCrypto(config.cryptoId) : Promise.resolve(null),
    fetchNewsHeadlines(config.newsSources),
    opts.taskReminders
      ? Promise.resolve([])
      : loadDueReminders(opts.memory, {
          date: dayKey,
          timezone: config.timezone,
          windowEnd,
        }),
    opts.taskReminders ? opts.taskReminders().catch(() => []) : Promise.resolve(undefined),
  ]);

  const marketLines: string[] = [];
  if (crypto && config.includeCrypto) {
    marketLines.push(formatCryptoDisplay(crypto, config.cryptoId));
  }

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
      crypto: config.includeCrypto ? crypto : null,
      cryptoId: config.cryptoId,
      index: indexQuote,
      indexSymbol: config.includeIndex ? config.indexSymbol : null,
      metals: metalsQuote,
      metalSymbol: config.includeMetals ? config.metalSymbol : null,
    }) || null;

  const xIngest = config.includeIngestedNotes
    ? toXIngestBriefing(await loadXIngestDigest(config.profileId, dayKey, config.cacheDir))
    : null;
  const agenda = await readAgenda(opts.agendaEvents, now);
  const fitness = await readFitness(opts.fitnessPlan, now);
  const medicine = config.includeMedicineMorning
    ? await readMedicine(opts.medicineItems, now)
    : null;

  const data: BriefingData = {
    greeting,
    date: dateLabel,
    dayKey,
    weather,
    weatherText,
    launches: [],
    launchesText: null,
    markets: {
      crypto: config.includeCrypto ? crypto : null,
      cryptoId: config.cryptoId,
      index: indexQuote,
      indexSymbol: config.includeIndex ? config.indexSymbol : null,
      metals: metalsQuote,
      metalSymbol: config.includeMetals ? config.metalSymbol : null,
      lines: marketLines,
    },
    marketsText,
    news: headlines,
    newsText: formatNewsSpeech(headlines, { inviteFollowUp: true }) || null,
    headlineOffer: headlines.length
      ? await buildHeadlineOffer({ llm: opts.llm, count: headlines.length })
      : null,
    xIngest,
    xIngestText: xIngest?.speech ?? null,
    reminders: memoryReminders,
    taskReminders,
    remindersText:
      (taskReminders ? formatTaskSpeech(taskReminders) : formatRemindersSpeech(memoryReminders)) ||
      null,
    generated: now.toISOString(),
  };
  applyAgenda(data, agenda, config.timezone);
  applyFitness(data, fitness);
  applyMedicine(data, medicine);
  data.modules = await runEnabledBriefingModules({
    llm: opts.llm,
    profileId: config.profileId,
  });

  const payload: BriefingPayload = {
    briefing: data,
    speech: formatBriefingForSpeech(data, { now, timezone: config.timezone }),
    markdown: formatBriefingAsMarkdown(data, { timezone: config.timezone }),
    display: formatBriefingForDisplay(data, { now, timezone: config.timezone }),
    generated: data.generated,
  };

  await cache.set(dayKey, payload, includeLaunches);

  if (opts.markSurfaced && !opts.taskReminders && memoryReminders.length) {
    await markRemindersSurfaced(opts.memory, memoryReminders);
  }

  return payload;
}

async function readAgenda(
  load: GenerateBriefingOptions["agendaEvents"],
  now: Date,
): Promise<BriefingAgendaSlice | null> {
  if (!load) return null;
  try {
    return await load(now);
  } catch (err) {
    console.warn("[briefing] agenda", err instanceof Error ? err.message : err);
    return { enabled: false, events: [] };
  }
}

function applyAgenda(
  data: BriefingData,
  agenda: BriefingAgendaSlice | null,
  timezone: string,
): void {
  if (!agenda) return;
  if (!agenda.enabled) {
    delete data.agenda;
    data.agendaText = null;
    return;
  }
  data.agenda = agenda.events;
  data.agendaText = formatAgendaSpeech(agenda.events, timezone) ?? "Nothing on your agenda today.";
}

async function readFitness(
  load: GenerateBriefingOptions["fitnessPlan"],
  now: Date,
): Promise<FitnessDayPlan | null> {
  if (!load) return null;
  try {
    return await load(now);
  } catch (err) {
    console.warn("[briefing] fitness", err instanceof Error ? err.message : err);
    return null;
  }
}

function applyFitness(data: BriefingData, plan: FitnessDayPlan | null): void {
  if (!plan) {
    delete data.fitness;
    data.fitnessText = null;
    return;
  }
  data.fitness = plan;
  data.fitnessText = formatFitnessSpeech(plan);
}

async function readMedicine(
  load: GenerateBriefingOptions["medicineItems"],
  now: Date,
): Promise<MedicineItem[] | null> {
  if (!load) return null;
  try {
    return await load(now);
  } catch (err) {
    console.warn("[briefing] medicine", err instanceof Error ? err.message : err);
    return null;
  }
}

function applyMedicine(data: BriefingData, items: MedicineItem[] | null): void {
  if (!items?.length) {
    delete data.medicine;
    data.medicineText = null;
    return;
  }
  data.medicine = items;
  data.medicineText = formatMedicineSpeech(items);
}
