import {
  FAILOVER_ELIGIBLE_FAILURES,
  type FailoverSettings,
  type ProviderFailureClass,
  type ProviderHealth,
  type ProviderKind,
  type ProviderPriorityList,
} from "@alfred/contracts";
import type { Clock } from "./clock.js";
import type { EventLedger } from "./event-ledger.js";

export interface HealthProbe {
  (providerId: string): Promise<ProviderHealth>;
}

export interface StickyFailoverState {
  modality: ProviderKind;
  orderedProviderIds: string[];
  activeProviderId: string;
  primaryProviderId: string;
  consecutiveFailures: Record<string, number>;
  cooldownUntil: Record<string, number>;
  lastFailoverAt?: number;
  stickySince?: number;
  settings: FailoverSettings;
}

export class StickyFailoverController {
  private state: StickyFailoverState;

  constructor(
    private readonly sessionId: string,
    list: ProviderPriorityList,
    private readonly clock: Clock,
    private readonly events: EventLedger,
    private readonly healthProbe: HealthProbe,
  ) {
    const primary = list.orderedProviderIds[0];
    if (!primary) throw new Error("Priority list must contain at least one provider");
    this.state = {
      modality: list.modality,
      orderedProviderIds: [...list.orderedProviderIds],
      activeProviderId: list.settings.manualPin
        ? (list.settings.pinnedProviderId ?? primary)
        : primary,
      primaryProviderId: primary,
      consecutiveFailures: {},
      cooldownUntil: {},
      settings: { ...list.settings },
    };
  }

  getState(): StickyFailoverState {
    return {
      ...this.state,
      orderedProviderIds: [...this.state.orderedProviderIds],
      consecutiveFailures: { ...this.state.consecutiveFailures },
      cooldownUntil: { ...this.state.cooldownUntil },
      settings: { ...this.state.settings },
    };
  }

  getActiveProviderId(): string {
    return this.state.activeProviderId;
  }

  async selectInitial(): Promise<string> {
    if (this.state.settings.manualPin && this.state.settings.pinnedProviderId) {
      this.state.activeProviderId = this.state.settings.pinnedProviderId;
      await this.emitSelected(this.state.activeProviderId, "manual_pin");
      return this.state.activeProviderId;
    }
    for (const id of this.state.orderedProviderIds) {
      if (this.isInCooldown(id)) continue;
      const health = await this.healthProbe(id);
      if (health.status === "healthy" || health.status === "degraded") {
        this.state.activeProviderId = id;
        await this.emitSelected(id, "initial_healthy");
        return id;
      }
    }
    // Fall back to first even if unhealthy — caller will surface failure.
    this.state.activeProviderId = this.state.primaryProviderId;
    await this.emitSelected(this.state.activeProviderId, "fallback_primary");
    return this.state.activeProviderId;
  }

  async recordFailure(providerId: string, failureClass: ProviderFailureClass): Promise<string> {
    await this.events.emit({
      sessionId: this.sessionId,
      type: "provider.failed",
      providerId,
      payload: { failureClass, modality: this.state.modality },
    });

    const count = (this.state.consecutiveFailures[providerId] ?? 0) + 1;
    this.state.consecutiveFailures[providerId] = count;

    if (this.state.settings.manualPin) {
      return this.state.activeProviderId;
    }

    const eligible =
      FAILOVER_ELIGIBLE_FAILURES.has(failureClass) &&
      count >= this.state.settings.consecutiveFailureThreshold;

    if (!eligible) {
      return this.state.activeProviderId;
    }

    this.state.cooldownUntil[providerId] = this.clock.now() + this.state.settings.cooldownMs;
    const next = this.findNextEligible(providerId);
    if (!next || next === this.state.activeProviderId) {
      return this.state.activeProviderId;
    }

    const previous = this.state.activeProviderId;
    this.state.activeProviderId = next;
    this.state.lastFailoverAt = this.clock.now();
    this.state.stickySince = this.clock.now();
    this.state.consecutiveFailures[next] = 0;

    await this.events.emit({
      sessionId: this.sessionId,
      type: "provider.failover",
      providerId: next,
      payload: {
        from: previous,
        to: next,
        failureClass,
        modality: this.state.modality,
        sticky: true,
      },
    });
    await this.emitSelected(next, "sticky_failover");
    return next;
  }

  async recordSuccess(providerId: string): Promise<void> {
    this.state.consecutiveFailures[providerId] = 0;
  }

  /**
   * Attempt to restore primary when retry-primary interval elapsed and health probe succeeds.
   * Does not retry primary on every request — only when interval allows.
   */
  async maybeRestorePrimary(): Promise<boolean> {
    if (this.state.settings.manualPin) return false;
    if (this.state.activeProviderId === this.state.primaryProviderId) return false;
    const stickySince = this.state.stickySince ?? this.state.lastFailoverAt ?? 0;
    if (this.clock.now() - stickySince < this.state.settings.retryPrimaryIntervalMs) {
      return false;
    }
    // Timer-driven restore still respects cooldown.
    return this.checkPrimary({ bypassCooldown: false });
  }

  /**
   * User-explicit or timer-driven primary check.
   * Explicit user checks bypass cooldown (PRD: return when user requests it).
   */
  async checkPrimary(opts?: { bypassCooldown?: boolean }): Promise<boolean> {
    const primary = this.state.primaryProviderId;
    const bypass = opts?.bypassCooldown ?? true;
    if (!bypass && this.isInCooldown(primary)) return false;
    const health = await this.healthProbe(primary);
    await this.events.emit({
      sessionId: this.sessionId,
      type: "provider.health_probed",
      providerId: primary,
      payload: { status: health.status, modality: this.state.modality },
    });
    if (health.status !== "healthy" && health.status !== "degraded") {
      return false;
    }
    const previous = this.state.activeProviderId;
    this.state.activeProviderId = primary;
    this.state.stickySince = undefined;
    this.state.consecutiveFailures[primary] = 0;
    delete this.state.cooldownUntil[primary];
    await this.events.emit({
      sessionId: this.sessionId,
      type: "provider.primary_restored",
      providerId: primary,
      payload: { from: previous, to: primary, modality: this.state.modality },
    });
    await this.emitSelected(primary, "primary_restored");
    return true;
  }

  updateConfiguration(list: ProviderPriorityList): void {
    const primary = list.orderedProviderIds[0];
    if (!primary) throw new Error("Priority list must contain at least one provider");
    this.state.orderedProviderIds = [...list.orderedProviderIds];
    this.state.primaryProviderId = primary;
    this.state.settings = { ...list.settings };
    if (list.settings.manualPin && list.settings.pinnedProviderId) {
      this.state.activeProviderId = list.settings.pinnedProviderId;
    } else if (!list.orderedProviderIds.includes(this.state.activeProviderId)) {
      this.state.activeProviderId = primary;
      this.state.stickySince = undefined;
    }
  }

  private isInCooldown(providerId: string): boolean {
    const until = this.state.cooldownUntil[providerId] ?? 0;
    return this.clock.now() < until;
  }

  private findNextEligible(failedId: string): string | undefined {
    const ids = this.state.orderedProviderIds;
    const start = ids.indexOf(failedId);
    const ordered = start >= 0 ? [...ids.slice(start + 1), ...ids.slice(0, start)] : [...ids];
    for (const id of ordered) {
      if (id === failedId) continue;
      if (this.isInCooldown(id)) continue;
      return id;
    }
    return undefined;
  }

  private async emitSelected(providerId: string, reason: string): Promise<void> {
    await this.events.emit({
      sessionId: this.sessionId,
      type: "provider.selected",
      providerId,
      payload: { reason, modality: this.state.modality },
    });
  }
}
