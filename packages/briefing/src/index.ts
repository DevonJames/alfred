export { formatAgendaMarkdown, formatAgendaSpeech, type BriefingAgendaEvent, type BriefingAgendaSlice } from "./agenda.js";
export {
  fitnessPlanIsCurrent,
  formatFitnessMarkdown,
  formatFitnessSpeech,
  speakFitnessPlan,
  type FitnessDayPlan,
  type FitnessMeal,
  type FitnessWorkout,
} from "./fitness.js";
export {
  applyMedicineLog,
  attachDraftImages,
  formatMedicineMarkdown,
  formatMedicineSpeech,
  isMedicineLogMode,
  isMedicinePeriod,
  medicineDisplayLines,
  mergeMedicineItems,
  mergeSummary,
  parseMedicineDrafts,
  untakenMorningItems,
  type MedicineDays,
  type MedicineDraft,
  type MedicineItem,
  type MedicineItemPatch,
  type MedicineLogMode,
  type MedicineLogRequest,
  type MedicinePeriod,
  type MedicineScheduleViewItem,
} from "./medicine.js";
export {
  MedicineStoreError,
  deleteMedicineItem,
  loadUntakenMorningMedicine,
  medicineScheduleView,
  readMedicineImage,
  readMedicineSchedule,
  saveMedicineImage,
  saveMedicineSchedule,
  storeMedicineLog,
  updateMedicineItem,
} from "./medicine-store.js";
export {
  clearFitnessDayPlan,
  clearFitnessFocus,
  FitnessStoreError,
  formatFitnessFocusPrompt,
  loadCurrentFitnessDayPlan,
  readFitnessDayPlan,
  readFitnessFocus,
  readNewestFitnessFocus,
  saveFitnessDayPlan,
  saveFitnessFocus,
} from "./fitness-store.js";
export { loadBriefingConfig, type BriefingConfig, type LaunchesMode } from "./config.js";
export {
  BriefingController,
  BRIEFING_DECLINE_ACK,
  BRIEFING_OFFER_CLOSER,
  BRIEFING_OFFER_SYSTEM_HINT,
  createBriefingController,
  type BriefingTurnDecision,
} from "./controller.js";
export { formatRemindersMarkdown, formatRemindersSpeech, formatTaskSpeech, loadDueReminders, type TaskReminder } from "./reminders.js";
export {
  CRYPTO_OPTIONS,
  LAUNCH_SITE_OPTIONS,
  defaultBriefingPrefs,
  loadBriefingPrefs,
  prefsPath,
  resolveBriefingConfig,
  resolveIncludeLaunches,
  saveBriefingPrefs,
  type BriefingPrefs,
} from "./prefs.js";
export {
  NEWS_SOURCE_OPTIONS,
  RSS_URLS,
  fetchNewsHeadlines,
  normalizeNewsHeadlines,
  type NewsHeadline,
} from "./news.js";
export {
  lookupLiveNewsHeadlines,
  summarizeNewsArticle,
  type LiveNewsLookupResult,
  type SummarizeNewsArticleOpts,
} from "./news-lookup.js";
export {
  parseDuckDuckGoHtml,
  researchNewsWithOpenAiWebSearch,
  searchNewsWeb,
  unwrapDuckDuckGoUrl,
  type NewsSearchHit,
} from "./news-search.js";
export {
  lookupLiveCryptoPrice,
  lookupLiveMetalsPrice,
} from "./markets-lookup.js";
export {
  fetchCrypto,
  fetchMetals,
  formatCryptoSpeech,
  formatMetalsSpeech,
} from "./markets.js";
export {
  briefingDayWindowEndIso,
  formatBriefingDateLabel,
  getBriefingDayKey,
  localDateTimeParts,
  timeOfDayGreeting,
} from "./day.js";
export { BriefingCache } from "./cache.js";
export { generateBriefing } from "./generate.js";
export {
  formatBriefingForDisplay,
  formatNewsForDisplay,
  isBriefingDisplay,
  type BriefingDisplay,
  type BriefingDisplayLine,
  type BriefingDisplaySection,
} from "./display.js";
export {
  buildHeadlineOffer,
  HEADLINE_OFFER_FALLBACK,
  postProcessHeadlineOffer,
} from "./headline-offer.js";
export {
  applyModuleSettings,
  assertPublicHttpsUrl,
  briefingModulesDir,
  createBriefingModuleFromAsk,
  listBriefingModules,
  looksLikeAddBriefingModule,
  parseBriefingModule,
  rocketLaunchesModule,
  runEnabledBriefingModules,
  saveBriefingModule,
  setBriefingModuleEnabled,
  type BriefingModule,
  type BriefingModuleResult,
  type BriefingModuleSetting,
} from "./modules.js";
export { formatBriefingAsMarkdown, formatBriefingForSpeech } from "./format.js";
export { detectBriefingIntent, wantsLaunches, type BriefingIntentKind } from "./intent.js";
export { BriefingStateStore, isSoftOfferEligible, type BriefingOfferState } from "./state.js";
export type {
  BriefingData,
  BriefingPayload,
  XIngestBriefing,
  XIngestBriefingItem,
} from "./types.js";
export { formatXIngestMarkdown, formatXIngestSpeech, toXIngestBriefing } from "./x-ingest.js";
export { postProcessGreeting, type GreetingLlm } from "./greeting.js";
export { seedDueReminder } from "./seed.js";
export {
  lookupCurrentTime,
  type CurrentTimeKind,
  type CurrentTimeQuery,
} from "./clock-lookup.js";
export {
  lookupLiveWeatherForecast,
  type LiveWeatherLookupOpts,
} from "./live-weather.js";
export { geocodePlace } from "./weather.js";
export {
  lookupEarthquakes,
  type EarthquakeQuery,
} from "./earthquakes.js";
export {
  lookupWeatherAlerts,
  type WeatherAlertQuery,
} from "./weather-alerts.js";
export { lookupSpaceWeather } from "./space-weather.js";
export {
  lookupNaturalEvents,
  type NaturalEventKind,
  type NaturalEventQuery,
} from "./natural-events.js";
export {
  lookupExchangeRate,
  type ExchangeRateQuery,
} from "./exchange-rate.js";
export {
  lookupHackerNews,
  type HackerNewsQuery,
} from "./hacker-news.js";
export {
  speakSituationalRequest,
  type SituationalRequest,
} from "./situational.js";
export {
  fetchWeather,
  formatWeatherMarkdown,
  formatWeatherSpeech,
  type WeatherData,
} from "./weather.js";
export {
  closingLine,
  sanitizeForSpeech,
  speakClockTime,
  speakUsdAmount,
} from "./speech.js";
