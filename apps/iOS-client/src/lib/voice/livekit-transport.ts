/**
 * LiveKit voice transport (voice guide §6, §7, §11).
 *
 * The phone is a microphone and a speaker on a WebRTC room. It publishes one
 * mic track, plays whatever `alfred-agent` publishes back, and renders the two
 * data topics. It runs no STT, holds no conversation state, and never decides
 * that a turn is over — `pnpm voice` on the Mac owns all of that.
 *
 * The SDK is loaded optionally. LiveKit is a native module, so on a build
 * without it every entry point here reports `unavailable` instead of throwing,
 * and Talk falls back to typing.
 */
import { configureAudioSession, releaseAudioSession, requestMicPermission } from "../audio";
import { endSession, sessionToken } from "../desktop-api";
import type {
  LKParticipant,
  LKRoom,
  LKTrack,
  LKTrackPublication,
  LiveKitClientModule,
  LiveKitNativeModule,
} from "./livekit-types";
import { loadLiveKitClient, loadLiveKitNative } from "./optional-module";
import { AGENT_IDENTITY, CAPTION_TOPIC, USER_TOPIC, decodeVoiceFrame } from "./protocol";
import type { VoiceMessage } from "./protocol";

interface Sdk {
  client: LiveKitClientModule;
  native: LiveKitNativeModule;
}

let sdk: Sdk | null | undefined;
let globalsRegistered = false;

/**
 * `livekit-client` carries the room logic; `@livekit/react-native` provides the
 * WebRTC natives and must have `registerGlobals()` called once before any room
 * is constructed.
 */
function loadSdk(): Sdk | null {
  if (sdk !== undefined) return sdk;

  const client = loadLiveKitClient<LiveKitClientModule>();
  const native = loadLiveKitNative<LiveKitNativeModule>();

  if (!client?.Room || !native) {
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
  onDisconnected: (reason: string | null) => void;
}

export interface VoiceSessionHandle {
  identity: string;
  room: string;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
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
export async function startVoiceSession(
  handlers: VoiceSessionHandlers
): Promise<VoiceSessionHandle> {
  const loaded = loadSdk();
  if (!loaded) throw new VoiceUnavailableError("no-sdk");

  if (!(await requestMicPermission())) throw new VoiceUnavailableError("no-mic");

  // playAndRecord + voiceChat, so hardware echo cancellation is in the path and
  // Alfred's own voice doesn't feed back into the mic during barge-in.
  await configureAudioSession();
  await loaded.native.AudioSession?.startAudioSession().catch(() => {});

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

  room
    .on(RoomEvent.TrackSubscribed, ((track: LKTrack) => {
      // On React Native the SDK routes subscribed audio to the output device
      // itself; there is no element to attach, so this is purely for the UI.
      if (isAudio(track.kind)) handlers.onAgentAudio(true);
    }) as (...args: never[]) => void)
    .on(RoomEvent.TrackUnsubscribed, ((track: LKTrack) => {
      if (isAudio(track.kind)) handlers.onAgentAudio(false);
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
      handlers.onDisconnected(typeof reason === "string" ? reason : null);
    }) as (...args: never[]) => void);

  await room.connect(minted.url, minted.token);
  await room.localParticipant.setMicrophoneEnabled(true);

  // The agent usually joins before the phone does, and tracks published before
  // we connected raise no TrackSubscribed event for us to catch.
  for (const participant of room.remoteParticipants.values()) {
    if (hasLiveAudio(participant, isAudio)) {
      handlers.onAgentAudio(true);
      break;
    }
  }

  return {
    identity: minted.identity || "",
    room: minted.room || "",
    setMicrophoneEnabled: async (enabled: boolean) => {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },
    disconnect: () => teardown(room, loaded, minted.sessionId),
  };
}

function hasLiveAudio(
  participant: LKParticipant,
  isAudio: (kind: string | undefined) => boolean
): boolean {
  for (const publication of participant.trackPublications.values()) {
    if (publication.track && isAudio(publicationKind(publication))) return true;
  }
  return false;
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
  await releaseAudioSession().catch(() => {});
  if (sessionId) await endSession(sessionId).catch(() => {});
}

export { AGENT_IDENTITY, CAPTION_TOPIC, USER_TOPIC };
