import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  LLMProvider,
  MemoryQuery,
  MemoryRetrievalResult,
  MemoryTurnCommit,
  STTProvider,
  TTSProvider,
  UnifiedRealtimeProvider,
} from "@alfred/contracts";

export type { MediaPort } from "./media-port.js";
export { NullMediaPort } from "./media-port.js";

export interface MemoryControllerPort {
  retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult>;
  commitTurn(commit: MemoryTurnCommit): Promise<void>;
  getActiveProviderId(): string | undefined;
  setActiveProviderId(providerId: string): Promise<void>;
}

export interface AgentRouterPort {
  delegate(request: AgentDelegationRequest): Promise<AgentDelegationResult>;
}

export type ReminderStatusAction =
  | "completed"
  | "dismissed"
  | "snoozed"
  | "pending"
  | "surfaced";

export interface DueReminderSummary {
  recordId: string;
  summary: string;
  remindAt: string | null;
  status: string | null;
}

/** Conversational update of OIP due reminders (briefing list). */
export interface ReminderPort {
  listDue(opts?: { now?: Date }): Promise<DueReminderSummary[]>;
  setStatus(
    recordId: string,
    status: ReminderStatusAction,
    snoozedUntil?: string,
  ): Promise<void>;
  invalidateBriefingDay(now?: Date): Promise<void>;
}

/** Structured long-term memory writes from conversation (Entity / Assertion). */
export interface StructuredMemoryPort {
  remember(write: {
    entities?: Array<{
      name: string;
      entityClass?: string;
      summary?: string;
      email?: string;
      telephone?: string;
      birthDate?: string;
    }>;
    assertions?: Array<{
      subjectName: string;
      predicate: string;
      objectName: string;
      text?: string;
    }>;
    notes?: string[];
  }): Promise<{
    entitiesUpserted: number;
    assertionsCreated: number;
    notesCreated: number;
  }>;
}

/** Live weather forecast for conversational asks (Open-Meteo). */
export interface WeatherForecastPort {
  getForecast(opts?: { location?: string; days?: number }): Promise<string>;
}

/** Conversational crypto / metals quotes (same feeds as the daily briefing). */
export interface MarketsPort {
  getCryptoPrice(opts?: { cryptoId?: string }): Promise<string>;
  getMetalsPrice(opts?: { metalSymbol?: "gold" | "silver" }): Promise<string>;
}

/** Conversational news headlines + article follow-ups (same RSS as briefing). */
export interface NewsHeadlineRef {
  title: string;
  url?: string;
  source: string;
}

export interface NewsPort {
  getHeadlines(): Promise<{ speech: string; headlines: NewsHeadlineRef[] }>;
  summarizeArticle(opts: {
    index?: number;
    match?: string;
    url?: string;
    title?: string;
    recent?: NewsHeadlineRef[];
  }): Promise<string>;
  /** Seed the last rundown (e.g. after playing the daily briefing). */
  rememberHeadlines?(headlines: NewsHeadlineRef[]): void;
}

/** Spoken local time and date (briefing timezone, or a named city). */
export interface CurrentTimePort {
  getCurrentTime(opts?: { place?: string; kind?: "time" | "date" }): Promise<string>;
}

/** USGS earthquakes, NWS alerts, space weather, EONET, FX, and Hacker News. */
export interface SituationalPort {
  earthquakes(query?: {
    scope?: "significant" | "notable";
    recent?: boolean;
    place?: string;
  }): Promise<string>;
  weatherAlerts(query?: { location?: string }): Promise<string>;
  spaceWeather(): Promise<string>;
  naturalEvents(query?: { kind?: "wildfires" | "volcanoes" | "both" }): Promise<string>;
  exchangeRate(query: {
    amount?: number;
    from: string;
    to: string;
    change?: boolean;
  }): Promise<string>;
  hackerNews(query?: { topic?: "general" | "ai" }): Promise<string>;
}

/** Local Elgato Key Light control for conversational asks. */
export interface StudioLightCommand {
  action: "on" | "off" | "brighter" | "dimmer" | "warmer" | "cooler" | "set" | "status";
  target?: string;
  brightness?: number;
  temperature?: string | number;
}

export interface StudioLightsPort {
  control(command: StudioLightCommand): Promise<string>;
  inventorySpeech?(): Promise<string>;
}

export interface ProviderRegistryPort {
  getLlm(id: string): LLMProvider;
  getStt(id: string): STTProvider;
  getTts(id: string): TTSProvider;
  getUnified(id: string): UnifiedRealtimeProvider;
  listManifests(): Map<string, import("@alfred/contracts").ProviderManifest>;
}
