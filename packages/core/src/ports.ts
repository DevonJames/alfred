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
