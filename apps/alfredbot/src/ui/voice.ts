import {
  DEFAULT_EXPRESSION_TIMEOUT_MS,
  EXPRESSION_TOPIC,
  parseExpressionPayload,
  type ExpressionEvent,
} from "@alfred/contracts";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { api } from "./api.js";
import { startCameraFrameSink } from "./camera-sink.js";
import type { AlfredFace } from "./face.js";
import { LiveWaveform } from "./waveform.js";

export type CaptionMsg =
  | { type: "start"; text: string }
  | { type: "reveal"; text: string }
  | { type: "end"; reason?: string };

export type UserMsg = { type: "partial" | "final"; text: string };

function shouldMeterAudio(identity: string): boolean {
  if (identity.startsWith("alfred-ios")) return false;
  if (identity.startsWith("alfred-bot")) return false;
  return true;
}

function parseCaption(data: Uint8Array): CaptionMsg | undefined {
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as {
      channel?: string;
      type?: string;
      text?: string;
      reason?: string;
    };
    if (raw.channel && raw.channel !== "alfred.caption") return undefined;
    if (raw.type === "start" && typeof raw.text === "string") return { type: "start", text: raw.text };
    if (raw.type === "reveal" && typeof raw.text === "string") return { type: "reveal", text: raw.text };
    if (raw.type === "end") return { type: "end", reason: raw.reason };
  } catch {
    return undefined;
  }
  return undefined;
}

function parseUser(data: Uint8Array): UserMsg | undefined {
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as {
      channel?: string;
      type?: string;
      text?: string;
    };
    if (raw.channel && raw.channel !== "alfred.user") return undefined;
    if ((raw.type === "partial" || raw.type === "final") && typeof raw.text === "string") {
      return { type: raw.type, text: raw.text };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TalkSession {
  private room?: Room;
  private expressionTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private stopFrameSink?: () => void;
  private waveTrackSid?: string;

  constructor(
    private readonly face: AlfredFace,
    private readonly waveform: LiveWaveform,
    private readonly remoteAudio: HTMLElement,
    private readonly localVideo: HTMLVideoElement,
    private readonly hooks: {
      localAudio?: boolean;
      onStatus: (text: string) => void;
      onCaption: (msg: CaptionMsg) => void;
      onUser: (msg: UserMsg) => void;
      onExpression: (event: ExpressionEvent) => void;
      onCameraError: (message: string) => void;
    },
  ) {}

  private get localAudio(): boolean {
    return this.hooks.localAudio === true;
  }

  get linked(): boolean {
    return Boolean(this.room);
  }

  get busy(): boolean {
    return this.connecting;
  }

  async connect(): Promise<void> {
    if (this.connecting || this.room) return;
    this.connecting = true;
    this.hooks.onStatus("Minting token…");
    let pending: Room | undefined;
    try {
      const minted = await withTimeout(api.talkToken(), 8_000, "Token mint timed out");
      if (!minted.url || !minted.token) throw new Error(minted.error ?? "Token mint failed");

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        disconnectOnPageLeave: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      const phoneHere = () =>
        Array.from(room.remoteParticipants.values()).some((p) => p.identity.startsWith("alfred-ios"));
      const refreshPhoneStatus = () => {
        if (this.localAudio) return;
        this.hooks.onStatus(phoneHere() ? "Audio on iPhone" : "Waiting for iPhone");
      };

      room
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach();
            el.autoplay = true;
            el.muted = false;
            el.volume = this.localAudio ? 1 : 0;
            el.setAttribute("playsinline", "true");
            this.remoteAudio.appendChild(el);
            void el.play().catch(() => undefined);
            if (this.localAudio) this.hooks.onStatus(`Linked · ${participant.identity}`);
            if (shouldMeterAudio(participant.identity) && track.mediaStreamTrack) {
              this.waveTrackSid = track.sid;
              void this.waveform.attach(track.mediaStreamTrack).catch(() => undefined);
            }
            if (!this.localAudio) refreshPhoneStatus();
          }
        })
        .on(RoomEvent.ParticipantConnected, () => refreshPhoneStatus())
        .on(RoomEvent.ParticipantDisconnected, () => refreshPhoneStatus())
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
          if (track.kind === Track.Kind.Audio && track.sid === this.waveTrackSid) {
            this.waveTrackSid = undefined;
            this.waveform.setSpeaking(false);
            this.waveform.detach();
            this.face.setMood("listening");
          }
        })
        .on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
          if (!topic || topic === "alfred.caption") {
            const msg = parseCaption(payload);
            if (msg) {
              this.hooks.onCaption(msg);
              if (msg.type === "start" || msg.type === "reveal") {
                this.face.setMood("speaking");
                this.waveform.setSpeaking(true);
              }
              if (msg.type === "end") {
                this.face.setMood("listening");
                this.waveform.setSpeaking(false);
              }
            }
          }
          if (!topic || topic === "alfred.user") {
            const msg = parseUser(payload);
            if (msg) {
              this.hooks.onUser(msg);
              if (msg.type === "partial") this.face.setMood("listening");
            }
          }
          if (topic === EXPRESSION_TOPIC) {
            const event = parseExpressionPayload(payload);
            if (event) this.applyExpression(event);
          }
        })
        .on(RoomEvent.Disconnected, () => {
          if (this.room === room) {
            this.room = undefined;
            this.teardown("Offline");
          }
        });

      this.hooks.onStatus("Connecting…");
      pending = room;
      await withTimeout(room.connect(minted.url, minted.token), 10_000, "LiveKit connect timed out");
      this.room = room;
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.audioTrackPublications.values()) {
          const existing = pub.track;
          if (!existing?.mediaStreamTrack || !shouldMeterAudio(participant.identity)) continue;
          this.waveTrackSid = existing.sid;
          void this.waveform.attach(existing.mediaStreamTrack).catch(() => undefined);
        }
      }
      if (this.localAudio) {
        await room.localParticipant.setMicrophoneEnabled(true);
      }
      void this.publishCamera(room);
      this.face.setMood("listening");
      if (this.localAudio) {
        this.hooks.onStatus(
          minted.voiceStack === "live" ? "Online · GPT-Live" : `Online · ${minted.room}`,
        );
      } else {
        refreshPhoneStatus();
      }
    } catch (err) {
      this.room = undefined;
      void pending?.disconnect(true);
      this.hooks.onStatus(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  private async publishCamera(room: Room): Promise<void> {
    try {
      await withTimeout(room.localParticipant.setCameraEnabled(true), 4_000, "Camera timed out");
      const cam = Array.from(room.localParticipant.videoTrackPublications.values())[0]?.track;
      if (!cam) return;
      cam.attach(this.localVideo);
      this.localVideo.muted = true;
      this.localVideo.playsInline = true;
      const show = () => this.localVideo.classList.add("live");
      this.localVideo.addEventListener("playing", show, { once: true });
      void this.localVideo.play().then(show).catch(() => undefined);
      this.stopFrameSink?.();
      this.stopFrameSink = startCameraFrameSink(this.localVideo);
    } catch (err) {
      this.hooks.onCameraError(err instanceof Error ? err.message : "Camera unavailable");
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.localAudio) return;
    await this.room?.localParticipant.setMicrophoneEnabled(!muted);
    this.face.setMood(muted ? "muted" : this.room ? "listening" : "idle");
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = undefined;
    if (room) await room.disconnect(true);
    this.teardown("Offline");
  }

  private applyExpression(event: ExpressionEvent): void {
    this.face.applyExpression(event);
    this.waveform.setExpression(event.type === "clear" ? "calm" : event.face);
    this.hooks.onExpression(event);
    if (this.expressionTimer) clearTimeout(this.expressionTimer);
    if (event.type === "clear" || event.face === "calm") return;
    this.expressionTimer = setTimeout(() => {
      this.applyExpression({
        ...event,
        type: "clear",
        face: "calm",
        body: "none",
      });
    }, event.timeoutMs || DEFAULT_EXPRESSION_TIMEOUT_MS);
  }

  private teardown(status: string): void {
    if (this.expressionTimer) clearTimeout(this.expressionTimer);
    this.stopFrameSink?.();
    this.stopFrameSink = undefined;
    this.waveTrackSid = undefined;
    this.waveform.setExpression("calm");
    this.waveform.setSpeaking(false);
    this.waveform.detach();
    this.remoteAudio.replaceChildren();
    this.localVideo.classList.remove("live");
    this.localVideo.removeAttribute("srcObject");
    this.face.setMood("idle");
    this.hooks.onStatus(status);
  }
}
