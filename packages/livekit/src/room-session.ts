import {
  AudioFrame as LkAudioFrame,
  AudioSource,
  AudioStream,
  ConnectionState,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  dispose,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import type { AudioFrame } from "@alfred/contracts";
import { parseUiCommand } from "@alfred/core";
import { createLiveKitToken } from "./tokens.js";
import { LiveKitMediaBridge } from "./media-bridge.js";
import { EnergyVad } from "./energy-vad.js";
import { int16ToUint8, uint8ToInt16 } from "./pcm.js";
import { LIVEKIT_NATIVE_RECONNECT_GRACE_MS, nextReconnectDelayMs } from "./reconnect.js";

/** How often to notice a zombie room that never fired Disconnected (e.g. after Mac wake). */
const CONNECTION_WATCHDOG_MS = 8_000;

export interface LiveKitRoomSessionOptions {
  url: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity?: string;
  /** Sample rate requested from remote AudioStream (STT path). */
  inputSampleRate?: number;
  /** Sample rate for published assistant track (match ElevenLabs pcm_24000). */
  outputSampleRate?: number;
  /** Agent join JWT lifetime. Default 24h (token only matters at connect). */
  tokenTtlSeconds?: number;
  media: LiveKitMediaBridge;
  /** When set, only subscribe to this remote participant identity. */
  targetIdentity?: string;
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
}

/**
 * Full room subscriber/publisher graph.
 *
 * - Subscribes to remote audio → PCM → LiveKitMediaBridge.pushInboundAudio
 * - Energy VAD → pushVad (barge-in evidence only)
 * - media.onPlayback → AudioSource.captureFrame → published track
 *
 * Does NOT host conversation policy. VoiceSessionController remains authoritative.
 *
 * After Mac sleep / network blips LiveKit disconnects the agent. We auto-rejoin
 * with a fresh token so iOS does not need `make alfred` after hours idle.
 */
export class LiveKitRoomSession {
  private room?: Room;
  private audioSource?: AudioSource;
  private localTrack?: LocalAudioTrack;
  private mediaUnsubs: Array<() => void> = [];
  private inboundTasks = new Set<Promise<void>>();
  /** True only after intentional stop() — blocks reconnect. */
  private closed = false;
  /** True while start()/reconnectConnect() is in flight. */
  private connecting = false;
  private handlingDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private nativeReconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  /** True while LiveKit reports CONN_RECONNECTING — defer our remint. */
  private nativeReconnecting = false;
  /** Bumped on every stopPlayback so in-flight captureFrame results are discarded. */
  private playbackEpoch = 0;
  private readonly vad = new EnergyVad();
  private readonly inputSampleRate: number;
  private readonly outputSampleRate: number;
  private readonly tokenTtlSeconds: number;
  private readonly log: Pick<Console, "log" | "warn" | "error" | "debug">;

  constructor(private readonly opts: LiveKitRoomSessionOptions) {
    this.inputSampleRate = opts.inputSampleRate ?? 16_000;
    this.outputSampleRate = opts.outputSampleRate ?? 24_000;
    this.tokenTtlSeconds = opts.tokenTtlSeconds ?? 60 * 60 * 24;
    this.log = opts.logger ?? console;
  }

  get connected(): boolean {
    return this.room !== undefined && !this.closed;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("LiveKitRoomSession was stopped");
    }
    if (this.room || this.connecting) return;
    this.startWatchdog();
    try {
      await this.connectOnce();
    } catch (err) {
      // Stay alive and keep trying — same failure mode as a later disconnect.
      this.scheduleReconnect();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearNativeReconnectTimer();
    this.clearWatchdog();
    await this.teardownRoom({ disposeNative: true });
  }

  /** Clear outbound queue on barge-in (called after media.stopPlayback). */
  clearOutboundQueue(): void {
    this.audioSource?.clearQueue();
  }

  private async connectOnce(): Promise<void> {
    if (this.closed) return;
    this.connecting = true;
    const identity = this.opts.identity ?? "alfred-agent";
    try {
      const token = await createLiveKitToken({
        apiKey: this.opts.apiKey,
        apiSecret: this.opts.apiSecret,
        roomName: this.opts.roomName,
        identity,
        ttlSeconds: this.tokenTtlSeconds,
      });

      const room = new Room();
      this.room = room;

      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          void this.onTrackSubscribed(track, publication, participant);
        },
      );
      room.on(RoomEvent.Disconnected, () => {
        this.log.warn("[livekit] disconnected from room");
        this.nativeReconnecting = false;
        this.clearNativeReconnectTimer();
        void this.onUnexpectedDisconnect();
      });
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (state === ConnectionState.CONN_RECONNECTING) {
          this.nativeReconnecting = true;
          this.log.warn("[livekit] connection state → reconnecting (LiveKit native)");
          // If native recovery stalls (common after long Mac sleep), remint ourselves.
          this.clearNativeReconnectTimer();
          this.nativeReconnectTimer = setTimeout(() => {
            this.nativeReconnectTimer = undefined;
            if (this.closed || !this.nativeReconnecting) return;
            this.log.warn("[livekit] native reconnect grace expired — forcing remint");
            this.nativeReconnecting = false;
            void this.onUnexpectedDisconnect();
          }, LIVEKIT_NATIVE_RECONNECT_GRACE_MS);
          return;
        }
        if (state === ConnectionState.CONN_CONNECTED) {
          this.nativeReconnecting = false;
          this.clearNativeReconnectTimer();
          this.reconnectAttempt = 0;
          return;
        }
        if (state === ConnectionState.CONN_DISCONNECTED) {
          this.log.warn("[livekit] connection state → disconnected");
          this.nativeReconnecting = false;
          this.clearNativeReconnectTimer();
          void this.onUnexpectedDisconnect();
        }
      });
      room.on(RoomEvent.Reconnected, () => {
        this.log.log("[livekit] native reconnected");
        this.nativeReconnecting = false;
        this.clearNativeReconnectTimer();
        this.reconnectAttempt = 0;
      });
      room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        this.log.log(`[livekit] participant connected: ${p.identity}`);
        this.vad.reset();
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        this.log.log(`[livekit] participant disconnected: ${p.identity}`);
        this.vad.reset();
      });
      room.on(
        RoomEvent.DataReceived,
        (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
          if (topic && topic !== "alfred.control") return;
          const command = parseUiCommand(payload, topic);
          if (command) this.opts.media.pushUiCommand(command);
        },
      );

      await room.connect(this.opts.url, token, {
        autoSubscribe: true,
        dynacast: true,
      });
      this.log.log(
        `[livekit] connected url=${this.opts.url} room=${this.opts.roomName} identity=${identity}`,
      );

      await this.publishAssistantTrack();
      this.wireMediaHandlers();

      // Attach to tracks already present.
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
            void this.onTrackSubscribed(pub.track, pub, participant);
          }
        }
      }

      this.reconnectAttempt = 0;
    } catch (err) {
      this.log.error("[livekit] connect failed", err);
      await this.teardownRoom({ disposeNative: false });
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  private wireMediaHandlers(): void {
    this.clearMediaUnsubs();
    // Await captureFrame so the voice path cannot outrun the LiveKit playout queue.
    this.mediaUnsubs.push(
      this.opts.media.onPlayback(async (frame) => {
        const gen = this.playbackEpoch;
        if (this.opts.media.isPlaybackStopped()) return;
        await this.publishFrame(frame);
        // A stop that lands mid-captureFrame can re-queue audio after clearQueue —
        // drop anything that made it through after the epoch advanced.
        if (gen !== this.playbackEpoch || this.opts.media.isPlaybackStopped()) {
          this.clearOutboundQueue();
        }
      }),
    );
    this.mediaUnsubs.push(
      this.opts.media.onStopPlayback(() => {
        this.playbackEpoch += 1;
        this.clearOutboundQueue();
      }),
    );
    this.mediaUnsubs.push(
      this.opts.media.onCaption((event) => {
        void this.publishCaption(event);
      }),
    );
    this.mediaUnsubs.push(
      this.opts.media.onUserTranscript((event) => {
        void this.publishUserTranscript(event);
      }),
    );
  }

  private clearMediaUnsubs(): void {
    for (const unsub of this.mediaUnsubs) unsub();
    this.mediaUnsubs = [];
  }

  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.closed || this.connecting || this.reconnectTimer || this.nativeReconnecting) return;
      const room = this.room;
      if (!room) {
        this.log.warn("[livekit] watchdog: no room — scheduling reconnect");
        this.scheduleReconnect();
        return;
      }
      const state = (room as { state?: ConnectionState }).state;
      if (state === ConnectionState.CONN_DISCONNECTED) {
        this.log.warn("[livekit] watchdog: room still disconnected — forcing rejoin");
        void this.onUnexpectedDisconnect();
      }
    }, CONNECTION_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private clearNativeReconnectTimer(): void {
    if (this.nativeReconnectTimer) {
      clearTimeout(this.nativeReconnectTimer);
      this.nativeReconnectTimer = undefined;
    }
  }

  private async onUnexpectedDisconnect(): Promise<void> {
    if (this.closed || this.connecting || this.handlingDisconnect) return;
    // Let LiveKit finish a short native reconnect before we tear the room down.
    if (this.nativeReconnecting && this.nativeReconnectTimer) return;
    this.handlingDisconnect = true;
    try {
      await this.teardownRoom({ disposeNative: false });
      this.scheduleReconnect();
    } finally {
      this.handlingDisconnect = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = nextReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.log.warn(
      `[livekit] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})...`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectConnect();
    }, delay);
  }

  private async reconnectConnect(): Promise<void> {
    if (this.closed || this.connecting || this.room) return;
    try {
      await this.connectOnce();
      this.log.log("[livekit] reconnected");
    } catch {
      this.scheduleReconnect();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async teardownRoom(opts: { disposeNative: boolean }): Promise<void> {
    this.clearMediaUnsubs();
    this.opts.media.reset();
    this.vad.reset();

    try {
      if (this.audioSource) {
        this.audioSource.clearQueue();
        await this.audioSource.close();
      }
      if (this.localTrack) {
        await this.localTrack.close();
      }
      if (this.room) {
        await this.room.disconnect().catch(() => {});
      }
    } finally {
      this.audioSource = undefined;
      this.localTrack = undefined;
      this.room = undefined;
      if (opts.disposeNative) {
        try {
          await dispose();
        } catch {
          /* native dispose best-effort */
        }
      }
    }
  }

  /** Broadcast assistant speech captions to the room (voice-client HUD). */
  private async publishCaption(event: {
    type: string;
    text?: string;
    reason?: string;
  }): Promise<void> {
    await this.publishUiData("alfred.caption", event);
  }

  /** Broadcast user STT transcript to the room (voice-client HUD). */
  private async publishUserTranscript(event: { type: string; text: string }): Promise<void> {
    await this.publishUiData("alfred.user", event);
  }

  private async publishUiData(
    channel: "alfred.caption" | "alfred.user",
    event: Record<string, unknown>,
  ): Promise<void> {
    const participant = this.room?.localParticipant;
    if (!participant || this.closed) return;
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          channel,
          ...event,
          atMs: Date.now(),
        }),
      );
      await participant.publishData(payload, {
        reliable: true,
        topic: channel,
      });
    } catch (err) {
      this.log.warn(`[livekit] publish ${channel} failed`, err);
    }
  }

  private async publishAssistantTrack(): Promise<void> {
    if (!this.room?.localParticipant) {
      throw new Error("Room not connected");
    }
    // Larger queue absorbs TTS bursts; captureFrame still back-pressures when full.
    this.audioSource = new AudioSource(this.outputSampleRate, 1, 5_000);
    this.localTrack = LocalAudioTrack.createAudioTrack("alfred-assistant", this.audioSource);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant.publishTrack(this.localTrack, options);
    this.log.log(`[livekit] published assistant audio track sampleRate=${this.outputSampleRate}`);
  }

  private async publishFrame(frame: AudioFrame): Promise<void> {
    if (!this.audioSource || this.closed) return;
    // Resample is not implemented here; callers should match outputSampleRate (24 kHz).
    // If rates differ, capture at frame rate (LiveKit will handle clock skew poorly —
    // prefer matching TTS pcm_24000 to outputSampleRate).
    const sampleRate = frame.sampleRate || this.outputSampleRate;
    const samples = uint8ToInt16(frame.data);
    if (samples.length === 0) return;
    const channels = frame.channels ?? 1;
    const samplesPerChannel = Math.floor(samples.length / channels);
    try {
      await this.audioSource.captureFrame(
        new LkAudioFrame(samples, sampleRate, channels, samplesPerChannel),
      );
    } catch (err) {
      this.log.warn("[livekit] captureFrame failed", err);
    }
  }

  private async onTrackSubscribed(
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): Promise<void> {
    if (this.closed) return;
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    if (this.opts.targetIdentity && participant.identity !== this.opts.targetIdentity) {
      return;
    }

    this.log.log(`[livekit] subscribed audio from ${participant.identity}`);
    const task = this.consumeInbound(track, participant.identity);
    this.inboundTasks.add(task);
    void task.finally(() => this.inboundTasks.delete(task));
  }

  private async consumeInbound(track: RemoteTrack, identity: string): Promise<void> {
    const stream = new AudioStream(track, this.inputSampleRate, 1);
    const reader = stream.getReader();
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        const pcm = value.data;
        const atMs = Date.now();
        const alfredFrame: AudioFrame = {
          data: int16ToUint8(pcm),
          sampleRate: value.sampleRate,
          channels: value.channels,
          samplesPerChannel: value.samplesPerChannel,
          timestampMs: atMs,
        };
        this.opts.media.pushInboundAudio(alfredFrame);

        const vad = this.vad.process(pcm, atMs);
        if (vad) {
          // Core VoiceSessionController reacts to VAD and calls stopPlayback.
          this.opts.media.pushVad(vad);
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.log.warn(`[livekit] inbound audio ended for ${identity}`, err);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      try {
        await stream.cancel();
      } catch {
        /* ignore */
      }
    }
  }
}
