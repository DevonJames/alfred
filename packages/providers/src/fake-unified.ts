import type {
  LlmStreamChunk,
  ProviderHealth,
  ProviderManifest,
  UnifiedRealtimeProvider,
  UnifiedSessionRequest,
} from "@alfred/contracts";
import type { Clock } from "@alfred/core";

export class FakeUnifiedProvider implements UnifiedRealtimeProvider {
  readonly manifest: ProviderManifest;
  healthy = true;

  constructor(
    id: string,
    stackId: string,
    private readonly clock?: Clock,
    displayName?: string,
  ) {
    this.manifest = {
      id,
      displayName: displayName ?? id,
      kind: "unified",
      version: "0.1.0",
      capabilities: ["realtime", "stt", "llm", "tts"],
      unifiedStackId: stackId,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: this.healthy ? "healthy" : "unhealthy",
      checkedAt: this.clock?.nowIso() ?? new Date().toISOString(),
    };
  }

  async *respond(
    userText: string,
    _request?: UnifiedSessionRequest,
  ): AsyncIterable<LlmStreamChunk> {
    const reply = `Unified(${this.manifest.id}): ${userText}`;
    for (const word of reply.split(/(\s+)/)) {
      if (!word) continue;
      yield { type: "token", text: word };
    }
    yield { type: "done" };
  }
}
