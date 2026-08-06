import {
  type AudioFrame,
  type ProviderHealth,
  type ProviderManifest,
  type STTProvider,
  type StreamingSTTSession,
  type StreamingSttSessionOptions,
  type SttResult,
  type SttTranscribeRequest,
  type SttTurnEvent,
} from "@alfred/contracts";
import WebSocket from "ws";

export const DEEPGRAM_FLUX_PROVIDER_ID = "stt.deepgram.flux";

export interface DeepgramFluxOptions {
  apiKey: string;
  model?: string;
  eagerEotThreshold?: number;
  /** Override WebSocket URL for tests. */
  listenUrl?: string;
  /** Inject a session factory for unit tests (no network). */
  sessionFactory?: (opts: StreamingSttSessionOptions) => Promise<StreamingSTTSession>;
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
}

/**
 * Deepgram Flux STT adapter.
 * Maps Flux TurnInfo events to Alfred SttTurnEvent. Vendor WS objects stay here.
 */
export class DeepgramFluxSTTProvider implements STTProvider {
  readonly manifest: ProviderManifest = {
    id: DEEPGRAM_FLUX_PROVIDER_ID,
    displayName: "Deepgram Flux",
    kind: "stt",
    version: "0.2.0",
    capabilities: ["streaming", "turn_events", "eager_eot", "flux-general-en"],
  };

  constructor(private readonly options: DeepgramFluxOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.options.apiKey) {
      return {
        providerId: this.manifest.id,
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        failureClass: "auth",
        message: "DEEPGRAM_API_KEY missing",
      };
    }
    return {
      providerId: this.manifest.id,
      status: "healthy",
      checkedAt: new Date().toISOString(),
    };
  }

  async transcribe(request: SttTranscribeRequest): Promise<SttResult> {
    const text = request.audioRef.startsWith("text:")
      ? request.audioRef.slice(5)
      : "[deepgram batch transcribe not used in M2 voice path]";
    return { text, isFinal: true, utteranceKind: "speech" };
  }

  async openSession(options: StreamingSttSessionOptions = {}): Promise<StreamingSTTSession> {
    if (this.options.sessionFactory) {
      return this.options.sessionFactory(options);
    }
    const session = new DeepgramFluxSession({
      apiKey: this.options.apiKey,
      model: this.options.model ?? "flux-general-en",
      eagerEotThreshold: options.eagerEotThreshold ?? this.options.eagerEotThreshold ?? 0.4,
      sampleRate: options.sampleRate ?? 16_000,
      listenUrl: this.options.listenUrl,
      logger: this.options.logger,
    });
    await session.connect();
    return session;
  }
}

interface FluxSessionConfig {
  apiKey: string;
  model: string;
  eagerEotThreshold: number;
  sampleRate: number;
  listenUrl?: string;
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
}

class DeepgramFluxSession implements StreamingSTTSession {
  private ws?: WebSocket;
  private readonly queue: Array<SttTurnEvent | null> = [];
  private waiters: Array<(v: SttTurnEvent | null) => void> = [];
  private opened?: Promise<void>;
  private audioBytes = 0;
  private readonly log: Pick<Console, "log" | "warn" | "error" | "debug">;

  constructor(private readonly cfg: FluxSessionConfig) {
    this.log = cfg.logger ?? console;
  }

  async connect(): Promise<void> {
    const params = new URLSearchParams({
      model: this.cfg.model,
      encoding: "linear16",
      sample_rate: String(this.cfg.sampleRate),
      eager_eot_threshold: String(this.cfg.eagerEotThreshold),
      eot_threshold: "0.7",
    });
    const base = this.cfg.listenUrl ?? `wss://api.deepgram.com/v2/listen?${params.toString()}`;

    this.opened = new Promise((resolve, reject) => {
      const ws = new WebSocket(base, {
        headers: { Authorization: `Token ${this.cfg.apiKey}` },
      });
      this.ws = ws;
      ws.on("open", () => {
        this.log.log(`[deepgram] Flux WebSocket open model=${this.cfg.model}`);
        resolve();
      });
      ws.on("error", (err) => {
        this.log.error(`[deepgram] WebSocket error: ${err.message}`);
        this.push({
          type: "error",
          error: err.message,
          failureClass: "connection",
          metadata: {},
        });
        reject(err);
      });
      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", (code, reason) => {
        this.log.warn(
          `[deepgram] WebSocket closed code=${code} reason=${reason.toString()} audioBytes=${this.audioBytes}`,
        );
        this.push(null);
      });
    });
    await this.opened;
  }

  async pushAudio(frame: AudioFrame): Promise<void> {
    if (!this.opened) return;
    await this.opened.catch(() => undefined);
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Copy bytes — frame.data may be a view into a larger SharedArrayBuffer/ArrayBuffer.
      const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      this.ws.send(buf);
      this.audioBytes += buf.byteLength;
    }
  }

  async *events(): AsyncIterable<SttTurnEvent> {
    if (this.opened) await this.opened.catch(() => undefined);
    while (true) {
      const item = await this.dequeue();
      if (item === null) return;
      yield item;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
        this.ws.close();
      }
    } finally {
      this.push(null);
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (process.env.ALFRED_LOG_STT === "1") {
      this.log.debug(
        `[deepgram] message type=${String(msg.type)} event=${String(msg.event ?? "")}`,
      );
    }
    const mapped = mapFluxMessage(msg);
    for (const ev of mapped) {
      if (ev.type !== "partial_transcript" || process.env.ALFRED_LOG_STT === "1") {
        this.log.log(
          `[deepgram] ${ev.type}${ev.text ? `: ${ev.text.slice(0, 120)}` : ""}${ev.error ? ` error=${ev.error}` : ""}`,
        );
      }
      this.push(ev);
    }
  }

  private push(item: SttTurnEvent | null): void {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.queue.push(item);
  }

  private dequeue(): Promise<SttTurnEvent | null> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * Flux v2 messages use `{ type: "TurnInfo", event: "EndOfTurn", transcript }`
 * (not top-level type=EndOfTurn). See Deepgram Flux docs.
 */
export function mapFluxMessage(msg: Record<string, unknown>): SttTurnEvent[] {
  const envelopeType = String(msg.type ?? "");
  const eventName = String(msg.event ?? "");
  const transcript =
    (msg.transcript as string | undefined) ??
    (msg.text as string | undefined) ??
    extractChannelAlt(msg);

  // Fatal / configure errors
  if (
    envelopeType === "Error" ||
    envelopeType === "FatalError" ||
    envelopeType === "ListenV2FatalError"
  ) {
    return [
      {
        type: "error",
        error: String(msg.message ?? msg.error ?? "deepgram error"),
        failureClass: "upstream_5xx",
        metadata: { rawType: envelopeType },
      },
    ];
  }

  // Connected / ConfigureSuccess — ignore
  if (
    envelopeType === "Connected" ||
    envelopeType === "ConfigureSuccess" ||
    envelopeType === "ListenV2Connected"
  ) {
    return [];
  }

  // Primary Flux path
  if (envelopeType === "TurnInfo") {
    return mapTurnInfoEvent(eventName, transcript, msg);
  }

  // Legacy / fallback shapes (tests and older APIs)
  return mapTurnInfoEvent(envelopeType || eventName, transcript, msg);
}

function mapTurnInfoEvent(
  eventName: string,
  transcript: string | undefined,
  msg: Record<string, unknown>,
): SttTurnEvent[] {
  switch (eventName) {
    case "StartOfTurn":
    case "start_of_turn":
      return [{ type: "start_of_turn", text: transcript, metadata: { rawEvent: eventName } }];
    case "Update":
    case "update":
    case "partial":
    case "Partial":
      if (transcript) {
        return [
          { type: "partial_transcript", text: transcript, metadata: { rawEvent: eventName } },
        ];
      }
      return [];
    case "EagerEndOfTurn":
    case "eager_end_of_turn":
      return [
        {
          type: "eager_end_of_turn",
          text: transcript,
          eagerEotConfidence: typeof msg.confidence === "number" ? msg.confidence : undefined,
          metadata: { rawEvent: eventName },
        },
      ];
    case "TurnResumed":
    case "turn_resumed":
      return [{ type: "turn_resumed", text: transcript, metadata: { rawEvent: eventName } }];
    case "EndOfTurn":
    case "end_of_turn":
      return [{ type: "end_of_turn", text: transcript, metadata: { rawEvent: eventName } }];
    case "Results":
    case "Transcript":
      if (transcript) {
        return [
          {
            type: msg.is_final || msg.speech_final ? "end_of_turn" : "partial_transcript",
            text: transcript,
            metadata: { rawEvent: eventName },
          },
        ];
      }
      return [];
    default:
      // Unknown TurnInfo event with transcript — treat as partial.
      if (transcript) {
        return [
          { type: "partial_transcript", text: transcript, metadata: { rawEvent: eventName } },
        ];
      }
      return [];
  }
}

function extractChannelAlt(msg: Record<string, unknown>): string | undefined {
  const channel = msg.channel as { alternatives?: Array<{ transcript?: string }> } | undefined;
  return channel?.alternatives?.[0]?.transcript;
}
