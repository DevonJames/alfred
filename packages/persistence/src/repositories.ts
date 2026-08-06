import type {
  AgentRoutingRule,
  ConversationEvent,
  ConversationTurn,
  ProviderConfig,
  ProviderPriorityList,
  ResponseLedgerEntry,
  UserConfiguration,
  UserProfile,
} from "@alfred/contracts";

export interface UserProfileRepository {
  get(id: string): Promise<UserProfile | undefined>;
  upsert(profile: UserProfile): Promise<void>;
}

export interface ProviderConfigRepository {
  list(profileId: string): Promise<ProviderConfig[]>;
  save(profileId: string, configs: ProviderConfig[]): Promise<void>;
}

export interface PriorityListRepository {
  list(profileId: string): Promise<ProviderPriorityList[]>;
  save(profileId: string, lists: ProviderPriorityList[]): Promise<void>;
}

export interface SessionRecord {
  id: string;
  profileId: string;
  createdAt: string;
  endedAt?: string;
  pipelineMode: "cascaded" | "unified";
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  end(id: string, endedAt: string): Promise<void>;
}

export interface TurnRepository {
  append(turn: ConversationTurn): Promise<void>;
  listBySession(sessionId: string): Promise<ConversationTurn[]>;
}

export interface ResponseLedgerRepository {
  append(entry: ResponseLedgerEntry): Promise<void>;
  listByResponse(responseId: string): Promise<ResponseLedgerEntry[]>;
  listBySession(sessionId: string): Promise<ResponseLedgerEntry[]>;
}

export interface EventRepository {
  append(event: ConversationEvent): Promise<void>;
  listBySession(sessionId: string): Promise<ConversationEvent[]>;
}

export interface MemorySettingsRepository {
  getActiveProviderId(profileId: string): Promise<string | undefined>;
  setActiveProviderId(profileId: string, providerId: string): Promise<void>;
}

export interface AgentRoutingRepository {
  list(profileId: string): Promise<AgentRoutingRule[]>;
  save(profileId: string, rules: AgentRoutingRule[]): Promise<void>;
}

export interface UserConfigurationRepository {
  get(profileId: string): Promise<UserConfiguration | undefined>;
  save(config: UserConfiguration): Promise<void>;
}

/** Bundle of repositories used by the conversation core. */
export interface PersistenceBundle {
  profiles: UserProfileRepository;
  providerConfigs: ProviderConfigRepository;
  priorityLists: PriorityListRepository;
  sessions: SessionRepository;
  turns: TurnRepository;
  responseLedgers: ResponseLedgerRepository;
  events: EventRepository;
  memorySettings: MemorySettingsRepository;
  agentRouting: AgentRoutingRepository;
  userConfigurations: UserConfigurationRepository;
}
