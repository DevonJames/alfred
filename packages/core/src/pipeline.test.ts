import { describe, expect, it } from "vitest";
import type { ProviderManifest } from "@alfred/contracts";
import {
  getSelectorLocks,
  resolveUnifiedFailoverTarget,
  validatePipelineConfiguration,
} from "./pipeline.js";

function manifests(): Map<string, ProviderManifest> {
  return new Map([
    ["stt.a", { id: "stt.a", displayName: "STT A", kind: "stt", version: "1", capabilities: [] }],
    ["llm.a", { id: "llm.a", displayName: "LLM A", kind: "llm", version: "1", capabilities: [] }],
    ["tts.a", { id: "tts.a", displayName: "TTS A", kind: "tts", version: "1", capabilities: [] }],
    [
      "uni.a",
      {
        id: "uni.a",
        displayName: "Uni A",
        kind: "unified",
        version: "1",
        capabilities: [],
        unifiedStackId: "stack-a",
      },
    ],
    [
      "uni.b",
      {
        id: "uni.b",
        displayName: "Uni B",
        kind: "unified",
        version: "1",
        capabilities: [],
        unifiedStackId: "stack-b",
      },
    ],
  ]);
}

describe("pipeline validation", () => {
  it("locks selectors in unified mode with machine-readable reasons", () => {
    const result = validatePipelineConfiguration(
      {
        mode: "unified",
        allowCascadedFallback: false,
        unifiedPriority: {
          modality: "unified",
          orderedProviderIds: ["uni.a"],
          settings: {
            connectionTimeoutMs: 1,
            firstTokenTimeoutMs: 1,
            totalRequestTimeoutMs: 1,
            consecutiveFailureThreshold: 1,
            cooldownMs: 1,
            retryPrimaryIntervalMs: 1,
            manualPin: false,
          },
        },
      },
      manifests(),
    );
    expect(result.valid).toBe(true);
    expect(result.locks.every((l) => l.locked && l.reasonCode === "unified_mode_active")).toBe(
      true,
    );
  });

  it("requires cascaded priorities", () => {
    const result = validatePipelineConfiguration(
      { mode: "cascaded", allowCascadedFallback: false },
      manifests(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("failsover unified only to another unified provider unless cascaded fallback allowed", () => {
    const denied = resolveUnifiedFailoverTarget(
      {
        mode: "unified",
        allowCascadedFallback: false,
        unifiedPriority: {
          modality: "unified",
          orderedProviderIds: ["uni.a"],
          settings: {
            connectionTimeoutMs: 1,
            firstTokenTimeoutMs: 1,
            totalRequestTimeoutMs: 1,
            consecutiveFailureThreshold: 1,
            cooldownMs: 1,
            retryPrimaryIntervalMs: 1,
            manualPin: false,
          },
        },
      },
      "uni.a",
      manifests(),
    );
    expect(denied.nextUnifiedId).toBeUndefined();
    expect(denied.allowCascadedFallback).toBe(false);

    const next = resolveUnifiedFailoverTarget(
      {
        mode: "unified",
        allowCascadedFallback: false,
        unifiedPriority: {
          modality: "unified",
          orderedProviderIds: ["uni.a", "uni.b"],
          settings: {
            connectionTimeoutMs: 1,
            firstTokenTimeoutMs: 1,
            totalRequestTimeoutMs: 1,
            consecutiveFailureThreshold: 1,
            cooldownMs: 1,
            retryPrimaryIntervalMs: 1,
            manualPin: false,
          },
        },
      },
      "uni.a",
      manifests(),
    );
    expect(next.nextUnifiedId).toBe("uni.b");

    const locks = getSelectorLocks(
      {
        mode: "cascaded",
        allowCascadedFallback: false,
        sttPriority: {
          modality: "stt",
          orderedProviderIds: ["stt.a"],
          settings: {
            connectionTimeoutMs: 1,
            firstTokenTimeoutMs: 1,
            totalRequestTimeoutMs: 1,
            consecutiveFailureThreshold: 1,
            cooldownMs: 1,
            retryPrimaryIntervalMs: 1,
            manualPin: false,
          },
        },
        llmPriority: {
          modality: "llm",
          orderedProviderIds: ["llm.a"],
          settings: {
            connectionTimeoutMs: 1,
            firstTokenTimeoutMs: 1,
            totalRequestTimeoutMs: 1,
            consecutiveFailureThreshold: 1,
            cooldownMs: 1,
            retryPrimaryIntervalMs: 1,
            manualPin: false,
          },
        },
        ttsPriority: {
          modality: "tts",
          orderedProviderIds: ["tts.a"],
          settings: {
            connectionTimeoutMs: 1,
            firstTokenTimeoutMs: 1,
            totalRequestTimeoutMs: 1,
            consecutiveFailureThreshold: 1,
            cooldownMs: 1,
            retryPrimaryIntervalMs: 1,
            manualPin: false,
          },
        },
      },
      manifests(),
    );
    expect(locks.every((l) => !l.locked)).toBe(true);
  });
});
