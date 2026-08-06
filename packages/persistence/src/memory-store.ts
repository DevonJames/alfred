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
import type {
  AgentRoutingRepository,
  EventRepository,
  MemorySettingsRepository,
  PersistenceBundle,
  PriorityListRepository,
  ProviderConfigRepository,
  ResponseLedgerRepository,
  SessionRecord,
  SessionRepository,
  TurnRepository,
  UserConfigurationRepository,
  UserProfileRepository,
} from "./repositories.js";

export class InMemoryUserProfileRepository implements UserProfileRepository {
  private readonly store = new Map<string, UserProfile>();
  async get(id: string): Promise<UserProfile | undefined> {
    return this.store.get(id);
  }
  async upsert(profile: UserProfile): Promise<void> {
    this.store.set(profile.id, profile);
  }
}

export class InMemoryProviderConfigRepository implements ProviderConfigRepository {
  private readonly store = new Map<string, ProviderConfig[]>();
  async list(profileId: string): Promise<ProviderConfig[]> {
    return [...(this.store.get(profileId) ?? [])];
  }
  async save(profileId: string, configs: ProviderConfig[]): Promise<void> {
    this.store.set(profileId, [...configs]);
  }
}

export class InMemoryPriorityListRepository implements PriorityListRepository {
  private readonly store = new Map<string, ProviderPriorityList[]>();
  async list(profileId: string): Promise<ProviderPriorityList[]> {
    return [...(this.store.get(profileId) ?? [])];
  }
  async save(profileId: string, lists: ProviderPriorityList[]): Promise<void> {
    this.store.set(profileId, [...lists]);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly store = new Map<string, SessionRecord>();
  async create(session: SessionRecord): Promise<void> {
    this.store.set(session.id, session);
  }
  async get(id: string): Promise<SessionRecord | undefined> {
    return this.store.get(id);
  }
  async end(id: string, endedAt: string): Promise<void> {
    const existing = this.store.get(id);
    if (existing) this.store.set(id, { ...existing, endedAt });
  }
}

export class InMemoryTurnRepository implements TurnRepository {
  private readonly store = new Map<string, ConversationTurn[]>();
  async append(turn: ConversationTurn): Promise<void> {
    const list = this.store.get(turn.sessionId) ?? [];
    list.push(turn);
    this.store.set(turn.sessionId, list);
  }
  async listBySession(sessionId: string): Promise<ConversationTurn[]> {
    return [...(this.store.get(sessionId) ?? [])];
  }
}

export class InMemoryResponseLedgerRepository implements ResponseLedgerRepository {
  private readonly byResponse = new Map<string, ResponseLedgerEntry[]>();
  private readonly bySession = new Map<string, ResponseLedgerEntry[]>();
  async append(entry: ResponseLedgerEntry): Promise<void> {
    const r = this.byResponse.get(entry.responseId) ?? [];
    r.push(entry);
    this.byResponse.set(entry.responseId, r);
    const s = this.bySession.get(entry.sessionId) ?? [];
    s.push(entry);
    this.bySession.set(entry.sessionId, s);
  }
  async listByResponse(responseId: string): Promise<ResponseLedgerEntry[]> {
    return [...(this.byResponse.get(responseId) ?? [])];
  }
  async listBySession(sessionId: string): Promise<ResponseLedgerEntry[]> {
    return [...(this.bySession.get(sessionId) ?? [])];
  }
}

export class InMemoryEventRepository implements EventRepository {
  private readonly store = new Map<string, ConversationEvent[]>();
  async append(event: ConversationEvent): Promise<void> {
    const list = this.store.get(event.sessionId) ?? [];
    list.push(event);
    this.store.set(event.sessionId, list);
  }
  async listBySession(sessionId: string): Promise<ConversationEvent[]> {
    return [...(this.store.get(sessionId) ?? [])];
  }
}

export class InMemoryMemorySettingsRepository implements MemorySettingsRepository {
  private readonly store = new Map<string, string>();
  async getActiveProviderId(profileId: string): Promise<string | undefined> {
    return this.store.get(profileId);
  }
  async setActiveProviderId(profileId: string, providerId: string): Promise<void> {
    this.store.set(profileId, providerId);
  }
}

export class InMemoryAgentRoutingRepository implements AgentRoutingRepository {
  private readonly store = new Map<string, AgentRoutingRule[]>();
  async list(profileId: string): Promise<AgentRoutingRule[]> {
    return [...(this.store.get(profileId) ?? [])];
  }
  async save(profileId: string, rules: AgentRoutingRule[]): Promise<void> {
    this.store.set(profileId, [...rules]);
  }
}

export class InMemoryUserConfigurationRepository implements UserConfigurationRepository {
  private readonly store = new Map<string, UserConfiguration>();
  async get(profileId: string): Promise<UserConfiguration | undefined> {
    return this.store.get(profileId);
  }
  async save(config: UserConfiguration): Promise<void> {
    this.store.set(config.profile.id, config);
  }
}

export function createInMemoryPersistence(): PersistenceBundle {
  return {
    profiles: new InMemoryUserProfileRepository(),
    providerConfigs: new InMemoryProviderConfigRepository(),
    priorityLists: new InMemoryPriorityListRepository(),
    sessions: new InMemorySessionRepository(),
    turns: new InMemoryTurnRepository(),
    responseLedgers: new InMemoryResponseLedgerRepository(),
    events: new InMemoryEventRepository(),
    memorySettings: new InMemoryMemorySettingsRepository(),
    agentRouting: new InMemoryAgentRoutingRepository(),
    userConfigurations: new InMemoryUserConfigurationRepository(),
  };
}
