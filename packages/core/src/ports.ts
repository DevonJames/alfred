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

export interface ProviderRegistryPort {
  getLlm(id: string): LLMProvider;
  getStt(id: string): STTProvider;
  getTts(id: string): TTSProvider;
  getUnified(id: string): UnifiedRealtimeProvider;
  listManifests(): Map<string, import("@alfred/contracts").ProviderManifest>;
}
