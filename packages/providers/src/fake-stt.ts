import type {
  ProviderHealth,
  ProviderManifest,
  STTProvider,
  SttResult,
  SttTranscribeRequest,
} from "@alfred/contracts";
import type { Clock } from "@alfred/core";

export class FakeSTTProvider implements STTProvider {
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
      kind: "stt",
      version: "0.1.0",
      capabilities: ["transcribe"],
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: this.healthy ? "healthy" : "unhealthy",
      checkedAt: this.clock?.nowIso() ?? new Date().toISOString(),
    };
  }

  async transcribe(request: SttTranscribeRequest): Promise<SttResult> {
    const text = request.audioRef.startsWith("text:")
      ? request.audioRef.slice("text:".length)
      : request.audioRef;
    return { text, isFinal: true, utteranceKind: "speech", confidence: 0.99 };
  }
}
