import type {
  AudioFrame,
  ProviderHealth,
  ProviderManifest,
  STTProvider,
  StreamingSTTSession,
  StreamingSttSessionOptions,
  SttResult,
  SttTranscribeRequest,
  SttTurnEvent,
} from "@alfred/contracts";

type QueueItem = SttTurnEvent | null;

/** Scriptable streaming STT for voice-path unit tests. */
export class FakeStreamingSTTSession implements StreamingSTTSession {
  private readonly queue: QueueItem[] = [];
  private waiters: Array<(item: QueueItem) => void> = [];
  private closed = false;
  frames = 0;

  pushEvent(event: SttTurnEvent): void {
    this.enqueue(event);
  }

  end(): void {
    this.enqueue(null);
  }

  async pushAudio(_frame: AudioFrame): Promise<void> {
    this.frames += 1;
  }

  async *events(): AsyncIterable<SttTurnEvent> {
    while (!this.closed) {
      const item = await this.dequeue();
      if (item === null) return;
      yield item;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.end();
  }

  private enqueue(item: QueueItem): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.queue.push(item);
  }

  private dequeue(): Promise<QueueItem> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class FakeStreamingSTTProvider implements STTProvider {
  readonly manifest: ProviderManifest;
  readonly lastSession = { current: undefined as FakeStreamingSTTSession | undefined };

  constructor(id = "stt.fake.streaming") {
    this.manifest = {
      id,
      displayName: "Fake Streaming STT",
      kind: "stt",
      version: "0.2.0",
      capabilities: ["transcribe", "streaming", "turn_events"],
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: "healthy",
      checkedAt: new Date().toISOString(),
    };
  }

  async transcribe(request: SttTranscribeRequest): Promise<SttResult> {
    const text = request.audioRef.startsWith("text:")
      ? request.audioRef.slice(5)
      : request.audioRef;
    return { text, isFinal: true, utteranceKind: "speech" };
  }

  async openSession(_options?: StreamingSttSessionOptions): Promise<StreamingSTTSession> {
    const session = new FakeStreamingSTTSession();
    this.lastSession.current = session;
    return session;
  }
}
