import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AudioFrame,
  ProviderFailureClass,
  ProviderHealth,
  ProviderManifest,
  STTProvider,
  StreamingSTTSession,
  StreamingSttSessionOptions,
  SttResult,
  SttTranscribeRequest,
  SttTurnEvent,
} from "@alfred/contracts";

export const APPLE_ONDEVICE_STT_PROVIDER_ID = "stt.apple.ondevice";

export interface AppleOnDeviceSttOptions {
  /** Absolute path to compiled alfred-apple-stt binary. */
  binaryPath?: string;
  sampleRate?: number;
  locale?: string;
  /** Force requiresOnDeviceRecognition (default true). */
  onDevice?: boolean;
  /** Inject a session factory for tests (no native binary). */
  sessionFactory?: (opts: StreamingSttSessionOptions) => Promise<StreamingSTTSession>;
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
}

/**
 * macOS Speech framework STT via a small native helper.
 * Used as Deepgram failover when DEEPGRAM_API_KEY is missing or Flux fails.
 */
export class AppleOnDeviceSTTProvider implements STTProvider {
  readonly manifest: ProviderManifest = {
    id: APPLE_ONDEVICE_STT_PROVIDER_ID,
    displayName: "Apple On-Device Speech",
    kind: "stt",
    version: "0.1.0",
    capabilities: ["streaming", "turn_events", "on_device", "apple_speech"],
  };

  constructor(private readonly options: AppleOnDeviceSttOptions = {}) {}

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (process.platform !== "darwin") {
      return {
        providerId: this.manifest.id,
        status: "unhealthy",
        checkedAt,
        failureClass: "unavailable",
        message: "Apple Speech STT is macOS-only",
      };
    }
    const bin = resolveAppleSttBinary(this.options.binaryPath);
    if (!bin) {
      return {
        providerId: this.manifest.id,
        status: "unhealthy",
        checkedAt,
        failureClass: "unavailable",
        message: "alfred-apple-stt binary missing — run pnpm --filter @alfred/provider-apple-stt build:native",
      };
    }
    return {
      providerId: this.manifest.id,
      status: "healthy",
      checkedAt,
    };
  }

  async transcribe(request: SttTranscribeRequest): Promise<SttResult> {
    const text = request.audioRef.startsWith("text:")
      ? request.audioRef.slice(5)
      : "[apple batch transcribe not used in voice path]";
    return { text, isFinal: true, utteranceKind: "speech" };
  }

  async openSession(options: StreamingSttSessionOptions = {}): Promise<StreamingSTTSession> {
    if (this.options.sessionFactory) {
      return this.options.sessionFactory(options);
    }
    if (process.platform !== "darwin") {
      throw Object.assign(new Error("Apple Speech STT requires macOS"), {
        failureClass: "unavailable" as ProviderFailureClass,
      });
    }
    const binary = resolveAppleSttBinary(this.options.binaryPath);
    if (!binary) {
      throw Object.assign(new Error("alfred-apple-stt binary not found"), {
        failureClass: "unavailable" as ProviderFailureClass,
      });
    }
    const session = new AppleSpeechSession({
      binary,
      sampleRate: options.sampleRate ?? this.options.sampleRate ?? 16_000,
      locale: this.options.locale ?? process.env.ALFRED_APPLE_STT_LOCALE ?? "en-US",
      onDevice: this.options.onDevice ?? process.env.ALFRED_APPLE_STT_ON_DEVICE !== "0",
      logger: this.options.logger,
    });
    await session.start();
    return session;
  }
}

export function resolveAppleSttBinary(explicit?: string): string | undefined {
  if (explicit !== undefined) {
    return existsSync(explicit) ? explicit : undefined;
  }
  const envPath = process.env.ALFRED_APPLE_STT_BINARY?.trim();
  if (envPath) {
    return existsSync(envPath) ? envPath : undefined;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../bin/alfred-apple-stt"),
    join(here, "../../bin/alfred-apple-stt"),
    join(process.cwd(), "packages/provider-apple-stt/bin/alfred-apple-stt"),
    join(process.cwd(), "bin/alfred-apple-stt"),
  ];
  return candidates.find((p) => existsSync(p));
}

interface SessionCfg {
  binary: string;
  sampleRate: number;
  locale: string;
  onDevice: boolean;
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
}

class AppleSpeechSession implements StreamingSTTSession {
  private child?: ChildProcessWithoutNullStreams;
  private readonly queue: Array<SttTurnEvent | null> = [];
  private waiters: Array<(v: SttTurnEvent | null) => void> = [];
  private ready!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private markReady?: () => void;
  private markFailed?: (err: Error) => void;
  private stdoutBuf = "";
  private closed = false;
  private readonly log: Pick<Console, "log" | "warn" | "error" | "debug">;

  constructor(private readonly cfg: SessionCfg) {
    this.log = cfg.logger ?? console;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    this.child = spawn(this.cfg.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ALFRED_APPLE_STT_SAMPLE_RATE: String(this.cfg.sampleRate),
        ALFRED_APPLE_STT_LOCALE: this.cfg.locale,
        ALFRED_APPLE_STT_ON_DEVICE: this.cfg.onDevice ? "1" : "0",
      },
    });

    let settled = false;
    const failTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.rejectReady(new Error("Apple STT helper did not become ready in time"));
    }, 15_000);

    const markReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      this.resolveReady();
    };
    const markFailed = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      this.rejectReady(err);
    };
    this.markReady = markReady;
    this.markFailed = markFailed;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) this.log.warn(`[apple-stt] ${line}`);
    });
    this.child.on("error", (err) => {
      this.push({
        type: "error",
        error: err.message,
        failureClass: "connection",
        metadata: {},
      });
      markFailed(err);
      this.push(null);
    });
    this.child.on("close", (code) => {
      if (!this.closed) {
        this.log.warn(`[apple-stt] helper exited code=${code ?? "?"}`);
        markFailed(new Error(`Apple STT helper exited code=${code ?? "?"}`));
      }
      this.push(null);
    });

    await this.ready;
    this.log.log(
      `[apple-stt] session open on-device=${this.cfg.onDevice} locale=${this.cfg.locale} rate=${this.cfg.sampleRate}`,
    );
  }

  async pushAudio(frame: AudioFrame): Promise<void> {
    if (this.closed || !this.child?.stdin.writable) return;
    await this.ready.catch(() => undefined);
    const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    try {
      this.child.stdin.write(buf);
    } catch (err) {
      this.log.warn(
        `[apple-stt] pushAudio failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async *events(): AsyncIterable<SttTurnEvent> {
    await this.ready.catch(() => undefined);
    while (true) {
      const item = await this.dequeue();
      if (item === null) return;
      yield item;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.child?.stdin.end();
      this.child?.kill("SIGTERM");
    } finally {
      this.push(null);
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(msg.type ?? "");
    if (type === "ready") {
      this.markReady?.();
      return;
    }
    const text = typeof msg.text === "string" ? msg.text : undefined;
    const error = typeof msg.error === "string" ? msg.error : undefined;
    const failureClass =
      typeof msg.failureClass === "string"
        ? (msg.failureClass as ProviderFailureClass)
        : undefined;

    if (type === "error") {
      this.push({
        type: "error",
        error: error ?? "apple stt error",
        failureClass: failureClass ?? "upstream_5xx",
        metadata: {},
      });
      this.markFailed?.(new Error(error ?? "apple stt error"));
      return;
    }

    if (
      type === "start_of_turn" ||
      type === "partial_transcript" ||
      type === "eager_end_of_turn" ||
      type === "end_of_turn"
    ) {
      if (type !== "partial_transcript" || process.env.ALFRED_LOG_STT === "1") {
        this.log.log(`[apple-stt] ${type}${text ? `: ${text.slice(0, 120)}` : ""}`);
      }
      this.push({
        type,
        text,
        metadata: {},
      });
    }
  }

  private push(item: SttTurnEvent | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.queue.push(item);
  }

  private dequeue(): Promise<SttTurnEvent | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
