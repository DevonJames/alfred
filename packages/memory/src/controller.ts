import type {
  MemoryProvider,
  MemoryQuery,
  MemoryRetrievalResult,
  MemoryTurnCommit,
} from "@alfred/contracts";
import type { MemoryControllerPort } from "@alfred/core";
import type { MemorySettingsRepository } from "@alfred/persistence";

/**
 * Exactly one active long-term memory provider per profile.
 * Recent conversation context remains in the conversation core — not here.
 */
export class MemoryController implements MemoryControllerPort {
  private readonly providers = new Map<string, MemoryProvider>();
  private activeProviderId?: string;

  constructor(
    private readonly profileId: string,
    private readonly settings: MemorySettingsRepository,
  ) {}

  register(provider: MemoryProvider): void {
    this.providers.set(provider.manifest.id, provider);
  }

  listProviders(): MemoryProvider[] {
    return [...this.providers.values()];
  }

  getActiveProviderId(): string | undefined {
    return this.activeProviderId;
  }

  async initialize(preferredId?: string): Promise<void> {
    const stored = await this.settings.getActiveProviderId(this.profileId);
    const id = preferredId ?? stored ?? [...this.providers.keys()][0];
    if (!id) throw new Error("No memory providers registered");
    await this.setActiveProviderId(id);
  }

  async setActiveProviderId(providerId: string): Promise<void> {
    if (!this.providers.has(providerId)) {
      throw new Error(`Unknown memory provider: ${providerId}`);
    }
    this.activeProviderId = providerId;
    await this.settings.setActiveProviderId(this.profileId, providerId);
  }

  private active(): MemoryProvider {
    if (!this.activeProviderId) throw new Error("No active memory provider");
    const p = this.providers.get(this.activeProviderId);
    if (!p) throw new Error(`Active memory provider missing: ${this.activeProviderId}`);
    return p;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult> {
    return this.active().retrieve({ ...query, profileId: this.profileId });
  }

  async commitTurn(commit: MemoryTurnCommit): Promise<void> {
    await this.active().commitTurn(commit);
  }
}
