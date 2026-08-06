import type {
  PipelineConfiguration,
  PipelineValidationResult,
  ProviderManifest,
  SelectorLockReason,
} from "@alfred/contracts";

export function validatePipelineConfiguration(
  config: PipelineConfiguration,
  manifests: Map<string, ProviderManifest>,
): PipelineValidationResult {
  const errors: string[] = [];
  const locks: SelectorLockReason[] = [];

  if (config.mode === "unified") {
    if (!config.unifiedPriority?.orderedProviderIds.length) {
      errors.push("unified mode requires unifiedPriority.orderedProviderIds");
    } else {
      for (const id of config.unifiedPriority.orderedProviderIds) {
        const m = manifests.get(id);
        if (!m) {
          errors.push(`Unknown unified provider: ${id}`);
        } else if (m.kind !== "unified") {
          errors.push(`Provider ${id} is kind=${m.kind}, expected unified`);
        }
      }
    }

    const activeUnified = config.unifiedPriority?.orderedProviderIds[0];
    const stackId = activeUnified ? manifests.get(activeUnified)?.unifiedStackId : undefined;

    for (const selector of ["stt", "llm", "tts"] as const) {
      locks.push({
        selector,
        locked: true,
        reasonCode: "unified_mode_active",
        message: `Selector '${selector}' is locked because pipeline mode is unified. Switch to cascaded mode before changing individual ${selector.toUpperCase()} providers.`,
        unifiedProviderId: activeUnified,
        unifiedStackId: stackId,
      });
    }

    if (config.sttPriority || config.llmPriority || config.ttsPriority) {
      // Not an error — but they are ignored while unified is active.
    }
  } else {
    if (!config.sttPriority?.orderedProviderIds.length) {
      errors.push("cascaded mode requires sttPriority");
    }
    if (!config.llmPriority?.orderedProviderIds.length) {
      errors.push("cascaded mode requires llmPriority");
    }
    if (!config.ttsPriority?.orderedProviderIds.length) {
      errors.push("cascaded mode requires ttsPriority");
    }

    const checks: Array<{ ids: string[] | undefined; kind: "stt" | "llm" | "tts" }> = [
      { ids: config.sttPriority?.orderedProviderIds, kind: "stt" },
      { ids: config.llmPriority?.orderedProviderIds, kind: "llm" },
      { ids: config.ttsPriority?.orderedProviderIds, kind: "tts" },
    ];
    for (const { ids, kind } of checks) {
      for (const id of ids ?? []) {
        const m = manifests.get(id);
        if (!m) errors.push(`Unknown ${kind} provider: ${id}`);
        else if (m.kind !== kind) {
          errors.push(`Provider ${id} is kind=${m.kind}, expected ${kind}`);
        }
      }
      locks.push({
        selector: kind,
        locked: false,
        reasonCode: "cascaded_mode_active",
        message: `Selector '${kind}' is editable in cascaded mode.`,
      });
    }
  }

  return { valid: errors.length === 0, errors, locks };
}

/**
 * Returns next unified provider for failover, or signals cascaded fallback eligibility.
 */
export function resolveUnifiedFailoverTarget(
  config: PipelineConfiguration,
  failedProviderId: string,
  manifests: Map<string, ProviderManifest>,
): { nextUnifiedId?: string; allowCascadedFallback: boolean; reason: string } {
  const ids = config.unifiedPriority?.orderedProviderIds ?? [];
  const idx = ids.indexOf(failedProviderId);
  const remaining = idx >= 0 ? ids.slice(idx + 1) : ids.filter((id) => id !== failedProviderId);
  for (const id of remaining) {
    const m = manifests.get(id);
    if (m?.kind === "unified") {
      return {
        nextUnifiedId: id,
        allowCascadedFallback: false,
        reason: "failover_to_compatible_unified_provider",
      };
    }
  }
  if (config.allowCascadedFallback) {
    return {
      allowCascadedFallback: true,
      reason: "no_compatible_unified_provider_cascaded_fallback_allowed",
    };
  }
  return {
    allowCascadedFallback: false,
    reason: "no_compatible_unified_provider_cascaded_fallback_denied",
  };
}

export function getSelectorLocks(
  config: PipelineConfiguration,
  manifests: Map<string, ProviderManifest>,
): SelectorLockReason[] {
  return validatePipelineConfiguration(config, manifests).locks;
}
