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
import WebSocket from "ws";

export const ELEVENLABS_FLASH_PROVIDER_ID = "tts.elevenlabs.flash_v2_5";
export const DEFAULT_ALFRED_VOICE_ID = "qXcNpxDCD6dKvASibF0r";

export interface ElevenLabsFlashOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  sampleRate?: number;
  /** Inject multi-context session for tests. */
  sessionFactory?: () => Promise<MultiContextTTSSession>;
  wsUrl?: string;
}

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: false,
  speed: 1.0,
};

/**
 * ElevenLabs Flash v2.5 multi-context WebSocket TTS.
 * PCM 24 kHz; alignment events mapped to Alfred TtsDeliveryEvent.
 */
export class ElevenLabsFlashTTSProvider implements TTSProvider {
  readonly manifest: ProviderManifest = {
    id: ELEVENLABS_FLASH_PROVIDER_ID,
    displayName: "ElevenLabs Flash v2.5",
    kind: "tts",
    version: "0.2.0",
    capabilities: ["synthesize", "multi_context", "pcm_24000", "alignment", "streaming"],
  };

  constructor(private readonly options: ElevenLabsFlashOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.options.apiKey) {
      return {
        providerId: this.manifest.id,
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        failureClass: "auth",
        message: "ELEVENLABS_API_KEY missing",
      };
    }
    return {
      providerId: this.manifest.id,
      status: "healthy",
      checkedAt: new Date().toISOString(),
    };
  }

  async *synthesize(request: TtsSynthesizeRequest): AsyncIterable<TtsChunk> {
    const session = await this.openMultiContextSession({
      voiceId: request.voiceId,
      sampleRate: 24_000,
    });
    const ctx = request.contextId ?? createId("ctx");
    const seg = request.responseSegmentId ?? createId("seg");
    await session.openContext(ctx, seg);
    for await (const ev of session.synthesizeToContext(ctx, request.text, {
      flush: true,
      signal: request.signal as AbortSignal | undefined,
    })) {
      if (ev.type === "audio-buffered") {
        yield {
          chunkId: createId("tts"),
          text: request.text,
          durationMs: ev.audioEndMs - ev.audioStartMs,
          pcm: ev.pcm,
          sampleRate: ev.sampleRate ?? 24_000,
        };
      }
    }
    await session.closeContext(ctx, "complete");
    await session.close();
  }

  async openMultiContextSession(options?: {
    voiceId?: string;
    sampleRate?: number;
  }): Promise<MultiContextTTSSession> {
    if (this.options.sessionFactory) {
      return this.options.sessionFactory();
    }
    return new ElevenLabsMultiContextSession({
      apiKey: this.options.apiKey,
      voiceId: options?.voiceId ?? this.options.voiceId ?? DEFAULT_ALFRED_VOICE_ID,
      modelId: this.options.modelId ?? "eleven_flash_v2_5",
      sampleRate: options?.sampleRate ?? this.options.sampleRate ?? 24_000,
      wsUrl: this.options.wsUrl,
    });
  }
}

interface SessionCfg {
  apiKey: string;
  voiceId: string;
  modelId: string;
  sampleRate: number;
  wsUrl?: string;
}

class ElevenLabsMultiContextSession implements MultiContextTTSSession {
  private ws?: WebSocket;
  private readonly contexts = new Map<string, string>();
  private ready: Promise<void>;

  constructor(private readonly cfg: SessionCfg) {
    const url =
      cfg.wsUrl ??
      `wss://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/multi-stream-input?model_id=${cfg.modelId}&output_format=pcm_${cfg.sampleRate}&inactivity_timeout=180`;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { "xi-api-key": cfg.apiKey },
      });
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
  }

  async openContext(contextId: string, responseSegmentId: string): Promise<void> {
    await this.ready;
    this.contexts.set(contextId, responseSegmentId);
    this.send({
      context_id: contextId,
      voice_settings: DEFAULT_VOICE_SETTINGS,
    });
  }

  async *synthesizeToContext(
    contextId: string,
    text: string,
    opts?: { flush?: boolean; signal?: AbortSignal },
  ): AsyncIterable<TtsDeliveryEvent> {
    await this.ready;
    const responseSegmentId = this.contexts.get(contextId) ?? "unknown";
    const events: TtsDeliveryEvent[] = [];
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      rejectDone = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
    });

    if (!this.ws) throw new Error("ws not open");

    const onMessage = (data: WebSocket.RawData) => {
      for (const ev of mapElevenLabsMessage(
        data,
        contextId,
        responseSegmentId,
        this.cfg.sampleRate,
      )) {
        // Ignore events for other multi-context ids if present.
        if (ev.contextId && ev.contextId !== contextId) continue;
        events.push(ev);
        if (ev.type === "playback-confirmed" || ev.type === "context-closed") {
          resolveDone();
        }
      }
    };
    const onError = (err: Error) => rejectDone(err);
    this.ws.on("message", onMessage);
    this.ws.on("error", onError);
    const cleanup = () => {
      this.ws?.off("message", onMessage);
      this.ws?.off("error", onError);
    };
    opts?.signal?.addEventListener(
      "abort",
      () => {
        cleanup();
        resolveDone();
      },
      { once: true },
    );

    this.send({
      context_id: contextId,
      text,
      flush: opts?.flush ?? true,
    });

    // Yield audio as it arrives; do NOT finish until isFinal (or timeout).
    // The old 200ms early-exit cut mid-sentence audio and started the next flush.
    const seen = new Set<TtsDeliveryEvent>();
    const start = Date.now();
    // Bound wait by spoken length (~12 chars/sec) with floor/ceiling.
    const maxWaitMs = Math.min(30_000, Math.max(4_000, text.length * 80));
    let lastAudioAt = start;
    let gotAudio = false;

    try {
      while (Date.now() - start < maxWaitMs) {
        if (opts?.signal?.aborted) break;

        for (const ev of events) {
          if (!seen.has(ev)) {
            seen.add(ev);
            if (ev.type === "audio-buffered") {
              gotAudio = true;
              lastAudioAt = Date.now();
            }
            yield ev;
          }
        }

        if (events.some((e) => e.type === "playback-confirmed" || e.type === "context-closed")) {
          break;
        }

        // If ElevenLabs never sends isFinal, wait for a real gap after enough audio.
        // A short gap early on caused mid-sentence skips when the next flush started.
        const minAudioMs = Math.min(8_000, Math.max(800, text.length * 35));
        const quietMs = 1_800;
        if (
          gotAudio &&
          Date.now() - start >= minAudioMs &&
          Date.now() - lastAudioAt > quietMs
        ) {
          const confirmed: TtsDeliveryEvent = {
            type: "playback-confirmed",
            responseSegmentId,
            contextId,
            playedThroughMs: text.length * 10,
            deliveredText: text,
          };
          if (!seen.has(confirmed)) {
            events.push(confirmed);
            yield confirmed;
          }
          break;
        }

        await Promise.race([done, sleep(20)]);
      }

      // Drain any trailing events.
      for (const ev of events) {
        if (!seen.has(ev)) {
          seen.add(ev);
          yield ev;
        }
      }
      if (gotAudio && !events.some((e) => e.type === "playback-confirmed")) {
        yield {
          type: "playback-confirmed",
          responseSegmentId,
          contextId,
          playedThroughMs: text.length * 10,
          deliveredText: text,
        };
      }
    } finally {
      cleanup();
    }
  }

  async closeContext(contextId: string, reason?: string): Promise<void> {
    this.send({ context_id: contextId, close_context: true });
    this.contexts.delete(contextId);
    void reason;
  }

  async close(): Promise<void> {
    try {
      this.send({ close_socket: true });
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}

export function mapElevenLabsMessage(
  data: WebSocket.RawData,
  contextId: string,
  responseSegmentId: string,
  sampleRate: number,
): TtsDeliveryEvent[] {
  // Binary PCM frame
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > 0 && !looksLikeJson(buf)) {
      return [
        {
          type: "audio-buffered",
          responseSegmentId,
          contextId,
          audioStartMs: 0,
          audioEndMs: Math.round((buf.length / 2 / sampleRate) * 1000),
          pcm: new Uint8Array(buf),
          sampleRate,
        },
      ];
    }
  }

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data.toString()) as Record<string, unknown>;
  } catch {
    return [];
  }

  const out: TtsDeliveryEvent[] = [];
  if (msg.audio) {
    const pcm = Buffer.from(String(msg.audio), "base64");
    out.push({
      type: "audio-buffered",
      responseSegmentId,
      contextId: String(msg.contextId ?? msg.context_id ?? contextId),
      audioStartMs: 0,
      audioEndMs: Math.round((pcm.length / 2 / sampleRate) * 1000),
      pcm: new Uint8Array(pcm),
      sampleRate,
    });
  }

  const alignment = msg.alignment as
    | {
        chars?: string[];
        charStartTimesMs?: number[];
        charDurationsMs?: number[];
      }
    | undefined;
  if (alignment?.chars && alignment.charStartTimesMs) {
    let word = "";
    let wordStart = 0;
    let charPos = 0;
    for (let i = 0; i < alignment.chars.length; i++) {
      const ch = alignment.chars[i] ?? "";
      if (/\s/.test(ch) && word) {
        out.push({
          type: "word-aligned",
          responseSegmentId,
          contextId,
          word,
          characterStart: wordStart,
          characterEnd: charPos,
          audioStartMs: alignment.charStartTimesMs[wordStart] ?? 0,
          audioEndMs:
            (alignment.charStartTimesMs[charPos - 1] ?? 0) +
            (alignment.charDurationsMs?.[charPos - 1] ?? 0),
        });
        word = "";
      } else if (!/\s/.test(ch)) {
        if (!word) wordStart = charPos;
        word += ch;
      }
      charPos += ch.length;
    }
    if (word) {
      out.push({
        type: "word-aligned",
        responseSegmentId,
        contextId,
        word,
        characterStart: wordStart,
        characterEnd: charPos,
        audioStartMs: alignment.charStartTimesMs[wordStart] ?? 0,
        audioEndMs:
          (alignment.charStartTimesMs[charPos - 1] ?? 0) +
          (alignment.charDurationsMs?.[charPos - 1] ?? 0),
      });
    }
  }

  if (msg.isFinal || msg.is_final) {
    out.push({
      type: "playback-confirmed",
      responseSegmentId,
      contextId,
      playedThroughMs: 0,
    });
  }

  return out;
}

function looksLikeJson(buf: Buffer): boolean {
  const c = buf[0];
  return c === 0x7b || c === 0x5b; // { or [
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
