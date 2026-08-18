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

export interface ProviderRegistryPort {
  getLlm(id: string): LLMProvider;
  getStt(id: string): STTProvider;
  getTts(id: string): TTSProvider;
  getUnified(id: string): UnifiedRealtimeProvider;
  listManifests(): Map<string, import("@alfred/contracts").ProviderManifest>;
}
