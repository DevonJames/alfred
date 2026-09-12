/**
 * LiveKit voice transport (voice guide §6, §7, §11).
 *
 * The phone is a microphone and a speaker on a WebRTC room. It publishes one
 * mic track, plays whatever `alfred-agent` publishes back, and renders the two
 * data topics (`alfred.caption` / `alfred.user`). It runs no STT, holds no
 * conversation state, and never decides that a turn is over — the Mac voice
 * worker owns that (`make alfred` cascade, or `make alfred VOICE=live`).
 *
 * The desktop mint decides the stack: cascade joins the fixed room; live mints
 * a fresh room and dispatches the GPT-Live agent. Captions use the same topics
 * either way (live tees GPT-Live transcripts onto them in parallel with audio).
 *
 * The SDK is loaded optionally. LiveKit is a native module, so on a build
 * without it every entry point here reports `unavailable` instead of throwing,
 * and Talk falls back to typing.
 */
import type { RemoteAudioTrack, RemoteTrack } from "livekit-client";
import { requestMicPermission } from "../audio";
import { endSession, sessionToken } from "../desktop-api";
import type { VoiceStack } from "../types";
import type {
  LKRoom,
  LKTrack,
  LKTrackPublication,
  LiveKitClientModule,
  LiveKitNativeModule,
} from "./livekit-types";
import { loadLiveKitClient, loadLiveKitNative } from "./optional-module";
import {
  AGENT_IDENTITY,
  CAPTION_TOPIC,
  CONTROL_TOPIC,
  USER_TOPIC,
  decodeVoiceFrame,
  encodeControlCommand,
} from "./protocol";
import type { UiCommand, VoiceMessage } from "./protocol";

interface Sdk {
  client: LiveKitClientModule;
  native: LiveKitNativeModule;
}

let sdk: Sdk | null | undefined;
let globalsRegistered = false;

/**
 * LiveKit must own AVAudioSession on iOS. Using expo-audio's setAudioModeAsync
 * here fights WebRTC and often yields captions (data) with silent remote audio.
 */
async function prepareLiveKitAudio(native: LiveKitNativeModule): Promise<void> {
  const session = native.AudioSession;
  if (!session) return;

  await session
    .configureAudio?.({
      // Prefer speaker when bare, but yield to wired/BT headphones when connected.
      ios: { defaultOutput: "speaker" },
    })
    .catch(() => {});

  await session
    .setAppleAudioConfiguration?.({
      audioCategory: "playAndRecord",
      audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP", "defaultToSpeaker"],
      // videoChat enables AEC and still routes to a headset when one is attached.
      audioMode: "videoChat",
    })
    .catch(() => {});

  await session.startAudioSession().catch(() => {});
  await session.setDefaultRemoteAudioTrackVolume?.(1).catch(() => {});
  // Do not force_speaker — that fights AirPods/headphones for pocket use.
}

function ensureRemoteAudioAudible(track: RemoteTrack): void {
  const audio = track as RemoteAudioTrack & {
    setVolume?: (volume: number) => void;
    isMuted?: boolean;
    setMuted?: (muted: boolean) => void;
    mediaStreamTrack?: { enabled?: boolean };
  };
  try {
    audio.setVolume?.(1);
    if (audio.mediaStreamTrack && audio.mediaStreamTrack.enabled === false) {
      audio.mediaStreamTrack.enabled = true;
    }
  } catch {
    /* best-effort */
  }
}

/**
 * `livekit-client` carries the room logic; `@livekit/react-native` provides the
 * WebRTC natives and must register globals (DOMException, WebRTC, etc.) *before*
 * `livekit-client` is evaluated.
 */
function loadSdk(): Sdk | null {
  if (sdk !== undefined) return sdk;

  const native = loadLiveKitNative<LiveKitNativeModule>();
  if (!native) {
    sdk = null;
    return sdk;
  }

  if (!globalsRegistered) {
    try {
      native.registerGlobals?.();
      globalsRegistered = true;
    } catch {
      // Native WebRTC missing (Expo Go / preview without a Dev Client).
      sdk = null;
      return sdk;
    }
  }

  const client = loadLiveKitClient<LiveKitClientModule>();
  if (!client?.Room) {
    sdk = null;
    return sdk;
  }

  sdk = { client, native };
  return sdk;
}

export function isLiveKitAvailable(): boolean {
  return loadSdk() !== null;
}

export interface VoiceSessionHandlers {
  onMessage: (message: VoiceMessage) => void;
  /** A remote audio track arrived or went away — for the "Alfred is here" dot. */
  onAgentAudio: (present: boolean) => void;
  /** Agent TTS track for waveform analysis (null when gone). */
  onAgentAudioTrack: (track: RemoteAudioTrack | null) => void;
  onDisconnected: (reason: string | null) => void;
}

export interface VoiceSessionHandle {
  identity: string;
  room: string;
  /** Which Mac voice worker minted this room (`cascade` | `live`). */
  voiceStack: VoiceStack;
  /** False when the LiveKit room is gone or tearing down (zombie guard). */
  isConnected: () => boolean;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  publishControl: (command: UiCommand) => Promise<void>;
  disconnect: () => Promise<void>;
}

export class VoiceUnavailableError extends Error {
  constructor(public reason: "no-sdk" | "no-mic" | "not-configured") {
    super(reason);
    this.name = "VoiceUnavailableError";
  }
}

/**
 * Join the room the Mac's agent is in.
 *
 * Order matters and follows the guide exactly: audio session, then token, then
 * handlers, then connect, then mic. Registering handlers after connect would
 * drop the agent's opening caption; enabling the mic before connect has nothing
 * to publish to.
 */
export interface StartVoiceSessionOptions {
  /**
   * Whether to publish the mic immediately after connect.
   * Continuous / desktop voice: true. Hold-to-talk idle join: false.
   */
  microphoneEnabled?: boolean;
}

export async function startVoiceSession(
  handlers: VoiceSessionHandlers,
  options: StartVoiceSessionOptions = {}
): Promise<VoiceSessionHandle> {
  const loaded = loadSdk();
  if (!loaded) throw new VoiceUnavailableError("no-sdk");

  if (!(await requestMicPermission())) throw new VoiceUnavailableError("no-mic");

  // LiveKit owns the audio session (playAndRecord + speaker). Do not call
  // expo-audio setAudioModeAsync here — it can mute remote WebRTC playout.
  await prepareLiveKitAudio(loaded.native);

  const minted = await sessionToken("voice");
  if (!minted.url || !minted.token) throw new VoiceUnavailableError("not-configured");

  const { Room, RoomEvent, Track } = loaded.client;
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const isAudio = (kind: string | undefined) => kind === Track.Kind.Audio;

  const setAgentTrack = (track: RemoteTrack | LKTrack | null) => {
    if (track && isAudio(track.kind)) {
      ensureRemoteAudioAudible(track as RemoteTrack);
      handlers.onAgentAudio(true);
      handlers.onAgentAudioTrack(track as RemoteAudioTrack);
      return;
    }
    handlers.onAgentAudio(false);
    handlers.onAgentAudioTrack(null);
  };

  /** Prefer alfred-agent; fall back to any remote audio (dev identities). */
  const attachAgentAudioFromRoom = () => {
    let fallback: RemoteTrack | null = null;
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        const existing = publication.track;
        if (!existing || !isAudio(publicationKind(publication))) continue;
        const remote = existing as RemoteTrack;
        if (participant.identity === AGENT_IDENTITY) {
          setAgentTrack(remote);
          return;
        }
        fallback ??= remote;
      }
    }
    if (fallback) setAgentTrack(fallback);
  };

  let tornDown = false;
  const runTeardown = async () => {
    if (tornDown) return;
    tornDown = true;
    await teardown(room, loaded, minted.sessionId);
  };

  room
    .on(RoomEvent.TrackSubscribed, ((track: RemoteTrack) => {
      // On React Native the SDK routes subscribed audio to the output device
      // itself; we only keep the track for waveform metering.
      if (isAudio(track.kind)) setAgentTrack(track);
    }) as (...args: never[]) => void)
    .on(RoomEvent.TrackUnsubscribed, ((track: RemoteTrack) => {
      if (isAudio(track.kind)) setAgentTrack(null);
    }) as (...args: never[]) => void)
    .on(RoomEvent.TrackPublished, ((publication: LKTrackPublication & {
      setSubscribed?: (subscribed: boolean) => void;
      track?: LKTrack | null;
    }, participant: { identity?: string }) => {
      // After agent republishes post-reconnect, ensure we subscribe again.
      if (!isAudio(publicationKind(publication))) return;
      publication.setSubscribed?.(true);
      if (publication.track) {
        setAgentTrack(publication.track as RemoteTrack);
      } else if (participant.identity === AGENT_IDENTITY || !participant.identity) {
        // Subscribed event may follow; also re-scan in case track is already bound.
        attachAgentAudioFromRoom();
      }
    }) as (...args: never[]) => void)
    .on(RoomEvent.ParticipantConnected, ((participant: {
      trackPublications?: Map<string, LKTrackPublication>;
    }) => {
      for (const publication of participant.trackPublications?.values() ?? []) {
        const existing = publication.track;
        if (existing && isAudio(publicationKind(publication))) {
          setAgentTrack(existing as RemoteTrack);
          break;
        }
      }
    }) as (...args: never[]) => void)
    .on(RoomEvent.Reconnected, (() => {
      // AVAudioSession can be in a bad state after ICE restart; re-arm + reattach.
      void prepareLiveKitAudio(loaded.native).finally(() => {
        attachAgentAudioFromRoom();
      });
    }) as (...args: never[]) => void)
    .on(RoomEvent.DataReceived, ((
      payload: Uint8Array,
      _participant: unknown,
      _kind: unknown,
      topic?: string
    ) => {
      const message = decodeVoiceFrame(payload, topic ?? null);
      if (message) handlers.onMessage(message);
    }) as (...args: never[]) => void)
    .on(RoomEvent.Disconnected, ((reason?: unknown) => {
      handlers.onAgentAudioTrack(null);
      // Unexpected drops must still release AVAudioSession (guide §6).
      void runTeardown().finally(() => {
        handlers.onDisconnected(typeof reason === "string" ? reason : null);
      });
    }) as (...args: never[]) => void);

  await room.connect(minted.url, minted.token);
  // Mirror desktop voice-client: arm mic only when the UI wants continuous listen
  // (or the user is actively holding PTT). Hold-to-talk idle joins leave it off.
  const micOn = options.microphoneEnabled !== false;
  await room.localParticipant.setMicrophoneEnabled(micOn);

  // The agent usually joins before the phone does, and tracks published before
  // we connected raise no TrackSubscribed event for us to catch.
  attachAgentAudioFromRoom();

  const voiceStack: VoiceStack = minted.voiceStack === "live" ? "live" : "cascade";
  // GPT-Live dispatches into a fresh room after mint — give the worker a moment
  // to appear before the UI treats "no agent audio yet" as failure.
  if (voiceStack === "live") {
    await waitForRemoteAudio(room, RoomEvent, 12_000);
    attachAgentAudioFromRoom();
  }

  const publishControl = async (command: UiCommand) => {
    const payload = encodeControlCommand(command);
    await room.localParticipant.publishData?.(payload as Uint8Array<ArrayBuffer>, {
      reliable: true,
      topic: CONTROL_TOPIC,
    });
  };

  return {
    identity: minted.identity || "",
    room: minted.room || "",
    voiceStack,
    isConnected: () => {
      if (tornDown) return false;
      const state = room.state;
      // Older stubs may omit state — treat as connected until teardown.
      if (state == null) return true;
      return state === "connected" || state === "reconnecting" || state === "signalReconnecting";
    },
    setMicrophoneEnabled: async (enabled: boolean) => {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    publishControl,
    disconnect: () => runTeardown(),
  };
}

/** True when any remote participant already has an audio track we can attach. */
function roomHasRemoteAudio(room: LKRoom): boolean {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track && publicationKind(publication) === "audio") return true;
      // Kind string from LiveKit Track.Kind may be "audio" via publication.kind.
      if (publicationKind(publication) === "audio" || publication.kind === "audio") return true;
    }
  }
  return false;
}

/**
 * Live stack: agent joins after RoomAgentDispatch. Cascade: agent is usually
 * already in the room. Either way, resolve as soon as remote audio appears
 * (or when the timeout elapses — caller still has a connected room).
 */
function waitForRemoteAudio(
  room: LKRoom,
  RoomEvent: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  if (roomHasRemoteAudio(room)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, onMaybeReady);
      room.off(RoomEvent.TrackSubscribed, onMaybeReady);
      resolve(ok);
    };
    const onMaybeReady = () => {
      if (roomHasRemoteAudio(room)) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    room.on(RoomEvent.ParticipantConnected, onMaybeReady as (...args: never[]) => void);
    room.on(RoomEvent.TrackSubscribed, onMaybeReady as (...args: never[]) => void);
  });
}

function publicationKind(publication: LKTrackPublication): string | undefined {
  return publication.kind ?? publication.track?.kind;
}

/**
 * Leaving is best-effort by design: the mic and the room must be released even
 * if the Mac never acknowledges, or a dropped network would leave the phone
 * holding a live microphone.
 */
async function teardown(room: LKRoom, loaded: Sdk, sessionId: string): Promise<void> {
  await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
  await room.disconnect().catch(() => {});
  await loaded.native.AudioSession?.stopAudioSession().catch(() => {});
  if (sessionId) await endSession(sessionId).catch(() => {});
}

export { AGENT_IDENTITY, CAPTION_TOPIC, USER_TOPIC, CONTROL_TOPIC };
