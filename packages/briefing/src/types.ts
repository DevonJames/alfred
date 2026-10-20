import type { DueReminder } from "@alfred/memory";
import type { BriefingDisplay } from "./display.js";
import type { TaskReminder } from "./reminders.js";
import type { LaunchInfo } from "./launches.js";
import type { MarketQuote } from "./markets.js";
import type { NewsHeadline } from "./news.js";
import type { BriefingAgendaEvent } from "./agenda.js";
import type { FitnessDayPlan } from "./fitness.js";
import type { MedicineItem } from "./medicine.js";
import type { BriefingModuleResult } from "./modules.js";
import type { WeatherData } from "./weather.js";

export interface XIngestBriefingItem {
  url: string;
  canonicalUrl: string;
  noteName?: string;
  headline: string;
  author?: string;
  kind?: string;
  status: "ingested" | "failed";
  error?: string;
  summary?: string;
}

export interface XIngestBriefing {
  items: XIngestBriefingItem[];
  speech: string | null;
}

export interface BriefingData {
  greeting: string;
  date: string;
  dayKey: string;
  weather: WeatherData | null;
  weatherText: string | null;
  launches: LaunchInfo[];
  launchesText: string | null;
  markets: {
    crypto: MarketQuote | null;
    cryptoId: string;
    index: MarketQuote | null;
    indexSymbol: string | null;
    metals: MarketQuote | null;
    metalSymbol: string | null;
    lines: string[];
  };
  marketsText: string | null;
  /** Full headlines (title/url/source) so article follow-ups work after the briefing. */
  news: NewsHeadline[];
  newsText: string | null;
  /**
   * Spoken ask at the end of the brief (headlines are not read until the user accepts).
   * Example: "Want the latest headlines?"
   */
  headlineOffer?: string | null;
  xIngest: XIngestBriefing | null;
  xIngestText: string | null;
  /** Today's events from calendars chosen in Briefing settings. Omitted when Agenda is not configured. */
  agenda?: BriefingAgendaEvent[];
  agendaText?: string | null;
  /** Today's FitnessAlly meals and workouts. Omitted when the snapshot is missing or stale. */
  fitness?: FitnessDayPlan | null;
  fitnessText?: string | null;
  /** Untaken morning medicine, when that briefing section is on. */
  medicine?: MedicineItem[] | null;
  medicineText?: string | null;
  reminders: DueReminder[];
  /** Apple Reminders due today or still open from an earlier day. Replaces memory reminders when set. */
  taskReminders?: TaskReminder[];
  remindersText: string | null;
  /** User-added sections loaded from data/briefing/<profile>/modules. */
  modules?: BriefingModuleResult[];
  generated: string;
}

export interface BriefingPayload {
  briefing: BriefingData;
  speech: string;
  markdown: string;
  /** Structured screen layout for the voice HUD (not spoken text). */
  display: BriefingDisplay;
  generated: string;
}
