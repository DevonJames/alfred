/**
 * Audio session + capture (PRD §10.1, §10.2).
 *
 * The phone is a microphone and a speaker. It records what you say and plays
 * back what the Mac says — it does not transcribe, reason, or decide. All of
 * that stays in the desktop's Conversation Core (§9.1).
 */
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import type { LiveKitNativeModule } from "./voice/livekit-types";
import { loadLiveKitNative } from "./voice/optional-module";

/**
 * Play-and-record with ducking, so Alfred's reply can start while the user is
 * still holding the mic and a barge-in doesn't cut the session dead.
 */
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: "duckOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
}

/** Release the recording route so playback isn't stuck on the earpiece path. */
export async function releaseAudioSession(): Promise<void> {
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
}

/**
 * Notes recording must own AVAudioSession. Talk/LiveKit and a leftover
 * expo-av recorder both leave the session in a state where prepare fails
 * with "recorder not prepared".
 */
export async function prepareNoteRecordingSession(): Promise<void> {
  const native = loadLiveKitNative<LiveKitNativeModule>();
  await native?.AudioSession?.stopAudioSession?.().catch(() => undefined);
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    // Mix so switching apps does not deactivate our session and mute the mic.
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** Playback must leave the record category or iOS routes to the earpiece / stays silent. */
export async function prepareNotePlaybackSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
}

export async function requestMicPermission(): Promise<boolean> {
  const { granted } = await requestRecordingPermissionsAsync();
  return granted;
}

/** m4a/AAC — small enough to send over a relay hop, good enough for STT. */
export const RECORDING_OPTIONS = RecordingPresets.HIGH_QUALITY;

export function recordingFile(uri: string): { uri: string; name: string; mimeType: string } {
  const extension = uri.split(".").pop()?.toLowerCase() ?? "m4a";
  const mimeType = extension === "wav" ? "audio/wav" : extension === "mp3" ? "audio/mpeg" : "audio/m4a";
  return { uri, name: `speech.${extension}`, mimeType };
}
