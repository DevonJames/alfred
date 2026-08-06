import {
  createId,
  type ProviderHealth,
  type ProviderManifest,
  type TTSProvider,
  type TtsChunk,
  type TtsSynthesizeRequest,
} from "@alfred/contracts";
import type { Clock } from "@alfred/core";

export class FakeTTSProvider implements TTSProvider {
  readonly manifest: ProviderManifest;
  healthy = true;

  constructor(
    id: string,
    private readonly clock?: Clock,
    displayName?: string,
  ) {
    this.manifest = {
      id,
      displayName: displayName ?? id,
      kind: "tts",
      version: "0.1.0",
      capabilities: ["synthesize"],
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: this.healthy ? "healthy" : "unhealthy",
      checkedAt: this.clock?.nowIso() ?? new Date().toISOString(),
    };
  }

  async *synthesize(request: TtsSynthesizeRequest): AsyncIterable<TtsChunk> {
    // Single chunk keeps synthesis non-blocking for the fake clock simulator.
    yield {
      chunkId: createId("tts"),
      text: request.text,
      durationMs: Math.max(10, request.text.length),
    };
  }
}
