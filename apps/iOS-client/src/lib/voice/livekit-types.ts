/**
 * Structural types for the LiveKit surface this app uses.
 *
 * Runtime loading stays optional (see optional-module.ts) so Expo Go /
 * preview can boot without a Dev Client. Type-only imports from the
 * installed packages keep call sites aligned with the real API.
 */
import type { LocalParticipant, Participant, Room, Track, TrackPublication } from "livekit-client";
import type { AudioSession, registerGlobals } from "@livekit/react-native";

export type LKTrack = Pick<Track, "kind" | "sid">;
export type LKTrackPublication = {
  kind: TrackPublication["kind"];
  track: LKTrack | null;
};
export type LKParticipant = {
  identity: Participant["identity"];
  trackPublications: Map<string, LKTrackPublication>;
};
export type LKLocalParticipant = {
  identity: LocalParticipant["identity"];
  setMicrophoneEnabled: LocalParticipant["setMicrophoneEnabled"];
  publishData?: LocalParticipant["publishData"];
};
export type LKRoom = {
  localParticipant: LKLocalParticipant;
  remoteParticipants: Map<string, LKParticipant>;
  on: (event: string, handler: (...args: never[]) => void) => LKRoom;
  connect: Room["connect"];
  disconnect: Room["disconnect"];
};

export interface LKRoomOptions {
  adaptiveStream?: boolean;
  dynacast?: boolean;
  audioCaptureDefaults?: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
    channelCount?: number;
  };
}

/** `livekit-client` — the pure-JS half. */
export interface LiveKitClientModule {
  Room: new (options?: LKRoomOptions) => LKRoom;
  RoomEvent: Record<string, string>;
  Track: { Kind: { Audio: string; Video: string } };
}

/** `@livekit/react-native` — the native half. */
export interface LiveKitNativeModule {
  registerGlobals?: typeof registerGlobals;
  AudioSession?: {
    startAudioSession: typeof AudioSession.startAudioSession;
    stopAudioSession: typeof AudioSession.stopAudioSession;
    configureAudio?: typeof AudioSession.configureAudio;
  };
}
