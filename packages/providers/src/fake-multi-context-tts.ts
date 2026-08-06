import {
  createId,
  type MultiContextTTSSession,
  type ProviderHealth,
  type ProviderManifest,
  type TTSProvider,
  type TtsChunk,
  type TtsDeliveryEvent,
  type TtsSynthesizeRequest,
} from "@alfred/contracts";

export class FakeMultiContextTTSSession implements MultiContextTTSSession {
  readonly contexts = new Map<string, string>();
  closedContexts: string[] = [];

  async openContext(contextId: string, responseSegmentId: string): Promise<void> {
    this.contexts.set(contextId, responseSegmentId);
  }

  async *synthesizeToContext(
    contextId: string,
    text: string,
    opts?: { flush?: boolean; signal?: AbortSignal },
  ): AsyncIterable<TtsDeliveryEvent> {
    const responseSegmentId = this.contexts.get(contextId) ?? "unknown";
    if (opts?.signal?.aborted) return;
    const pcm = new TextEncoder().encode(text);
    yield {
      type: "audio-buffered",
      responseSegmentId,
      contextId,
      audioStartMs: 0,
      audioEndMs: Math.max(10, text.length * 10),
      pcm,
      sampleRate: 24_000,
    };
    let cursor = 0;
    for (const word of text.split(/(\s+)/)) {
      if (opts?.signal?.aborted) return;
      if (!word.trim()) {
        cursor += word.length;
        continue;
      }
      yield {
        type: "word-aligned",
        responseSegmentId,
        contextId,
        word,
        characterStart: cursor,
        characterEnd: cursor + word.length,
        audioStartMs: cursor * 10,
        audioEndMs: (cursor + word.length) * 10,
      };
      cursor += word.length;
    }
    if (opts?.signal?.aborted) return;
    yield {
      type: "playback-confirmed",
      responseSegmentId,
      contextId,
      playedThroughMs: text.length * 10,
      deliveredText: text,
    };
  }

  async closeContext(contextId: string, reason?: string): Promise<void> {
    this.closedContexts.push(contextId);
    const responseSegmentId = this.contexts.get(contextId);
    this.contexts.delete(contextId);
    void reason;
    void responseSegmentId;
  }

  async close(): Promise<void> {
    this.contexts.clear();
  }
}

export class FakeMultiContextTTSProvider implements TTSProvider {
  readonly manifest: ProviderManifest;
  readonly lastSession = { current: undefined as FakeMultiContextTTSSession | undefined };

  constructor(id = "tts.fake.multicontext") {
    this.manifest = {
      id,
      displayName: "Fake Multi-Context TTS",
      kind: "tts",
      version: "0.2.0",
      capabilities: ["synthesize", "multi_context", "alignment", "pcm"],
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: "healthy",
      checkedAt: new Date().toISOString(),
    };
  }

  async *synthesize(request: TtsSynthesizeRequest): AsyncIterable<TtsChunk> {
    yield {
      chunkId: createId("tts"),
      text: request.text,
      durationMs: 50,
      pcm: new TextEncoder().encode(request.text),
      sampleRate: 24_000,
    };
  }

  async openMultiContextSession(): Promise<MultiContextTTSSession> {
    const session = new FakeMultiContextTTSSession();
    this.lastSession.current = session;
    return session;
  }
}
