import {
  AudioFrame as LkAudioFrame,
  AudioSource,
  AudioStream,
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
import { createLiveKitToken } from "./tokens.js";
import { LiveKitMediaBridge } from "./media-bridge.js";
import { EnergyVad } from "./energy-vad.js";
import { int16ToUint8, uint8ToInt16 } from "./pcm.js";

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
 */
export class LiveKitRoomSession {
  private room?: Room;
  private audioSource?: AudioSource;
  private localTrack?: LocalAudioTrack;
  private unsubPlayback?: () => void;
  private inboundTasks = new Set<Promise<void>>();
  private closed = false;
  private readonly vad = new EnergyVad();
  private readonly inputSampleRate: number;
  private readonly outputSampleRate: number;
  private readonly log: Pick<Console, "log" | "warn" | "error" | "debug">;

  constructor(private readonly opts: LiveKitRoomSessionOptions) {
    this.inputSampleRate = opts.inputSampleRate ?? 16_000;
    this.outputSampleRate = opts.outputSampleRate ?? 24_000;
    this.log = opts.logger ?? console;
  }

  get connected(): boolean {
    return this.room !== undefined && !this.closed;
  }

  async start(): Promise<void> {
    if (this.room) return;

    const identity = this.opts.identity ?? "alfred-agent";
    const token = await createLiveKitToken({
      apiKey: this.opts.apiKey,
      apiSecret: this.opts.apiSecret,
      roomName: this.opts.roomName,
      identity,
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
    });
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      this.log.log(`[livekit] participant connected: ${p.identity}`);
    });

    await room.connect(this.opts.url, token, {
      autoSubscribe: true,
      dynacast: true,
    });
    this.log.log(
      `[livekit] connected url=${this.opts.url} room=${this.opts.roomName} identity=${identity}`,
    );

    await this.publishAssistantTrack();

    // Await captureFrame so the voice path cannot outrun the LiveKit playout queue.
    this.unsubPlayback = this.opts.media.onPlayback(async (frame) => {
      await this.publishFrame(frame);
    });
    this.opts.media.onStopPlayback(() => {
      this.clearOutboundQueue();
    });

    // Attach to tracks already present.
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.track && pub.kind === TrackKind.KIND_AUDIO) {
          void this.onTrackSubscribed(pub.track, pub, participant);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.unsubPlayback?.();
    this.unsubPlayback = undefined;
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
        await this.room.disconnect();
      }
    } finally {
      this.audioSource = undefined;
      this.localTrack = undefined;
      this.room = undefined;
      try {
        await dispose();
      } catch {
        /* native dispose best-effort */
      }
    }
  }

  /** Clear outbound queue on barge-in (called after media.stopPlayback). */
  clearOutboundQueue(): void {
    this.audioSource?.clearQueue();
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
