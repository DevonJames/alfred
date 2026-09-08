/**
 * CallKit keep-alive for continuous conversation (LiveKit RN guidance).
 *
 * Lazy-loads `@livekit/react-native-callkeep` only when the native module is
 * present. A static import crashes Expo Go / stale Dev Clients with
 * `NativeEventEmitter requires a non-null argument`.
 *
 * Must register `didReceiveStartCallAction` before `startCall` — otherwise
 * CallKit's native event queue can crash with a nil payload on iOS.
 */
import { NativeModules, Platform } from "react-native";

const CALL_UUID = "a1f7ed00-a1f7-4000-8000-00alfred0001";

type CallKeepModule = typeof import("@livekit/react-native-callkeep");
type RNCallKeepApi = CallKeepModule["default"];

let setupDone = false;
let callActive = false;
let unavailable = false;
let lastMuted: boolean | null = null;
let endHandler: (() => void) | null = null;
let muteHandler: ((muted: boolean) => void) | null = null;

export function setCallServiceHandlers(handlers: {
  onEnd?: () => void;
  onMute?: (muted: boolean) => void;
}): void {
  endHandler = handlers.onEnd ?? null;
  muteHandler = handlers.onMute ?? null;
}

function loadCallKeep(): {
  RNCallKeep: RNCallKeepApi;
  AudioSessionCategoryOption: CallKeepModule["AudioSessionCategoryOption"];
  AudioSessionMode: CallKeepModule["AudioSessionMode"];
  CONSTANTS: CallKeepModule["CONSTANTS"];
} | null {
  if (unavailable || Platform.OS !== "ios") return null;
  if (!NativeModules.RNCallKeep) {
    unavailable = true;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@livekit/react-native-callkeep") as CallKeepModule & {
      default?: RNCallKeepApi;
    };
    const RNCallKeep = (mod.default ?? mod) as RNCallKeepApi;
    if (!RNCallKeep?.setup && !(RNCallKeep as { setSettings?: unknown }).setSettings) {
      unavailable = true;
      return null;
    }
    return {
      RNCallKeep,
      AudioSessionCategoryOption: mod.AudioSessionCategoryOption,
      AudioSessionMode: mod.AudioSessionMode,
      CONSTANTS: mod.CONSTANTS,
    };
  } catch {
    unavailable = true;
    return null;
  }
}

export function setupCallService(): void {
  if (Platform.OS !== "ios" || setupDone || unavailable) return;

  const loaded = loadCallKeep();
  if (!loaded) return;

  const { RNCallKeep, AudioSessionCategoryOption, AudioSessionMode } = loaded;

  try {
    const options = {
      ios: {
        appName: "Alfred",
        supportsVideo: false,
        includesCallsInRecents: false,
        audioSession: {
          categoryOptions:
            AudioSessionCategoryOption.allowBluetooth +
            AudioSessionCategoryOption.allowBluetoothA2DP +
            AudioSessionCategoryOption.allowAirPlay +
            AudioSessionCategoryOption.defaultToSpeaker,
          mode: AudioSessionMode.videoChat,
          // LiveKit owns AVAudioSession; let CallKit skip reconfiguring it.
          autoConfigure: false,
        },
      },
      android: {
        alertTitle: "Phone account",
        alertDescription: "Alfred needs a phone account for background voice.",
        cancelButton: "Cancel",
        okButton: "OK",
        additionalPermissions: [] as string[],
        foregroundService: {
          channelId: "net.alfrd.alfred.voice",
          channelName: "Alfred voice",
          notificationTitle: "Alfred is listening",
        },
      },
    };

    // LiveKit example uses setSettings; setup() also works but is async.
    if (typeof RNCallKeep.setSettings === "function") {
      RNCallKeep.setSettings(options);
    } else {
      void RNCallKeep.setup(options);
    }

    // Required before startCall on iOS — marks the JS bridge ready for the
    // CXStartCallAction event. Omitting this is a known native crash.
    RNCallKeep.addEventListener("didReceiveStartCallAction", () => {});
    RNCallKeep.addEventListener("didChangeAudioRoute", () => {});
    RNCallKeep.addEventListener("answerCall", () => {});
    RNCallKeep.addEventListener("didActivateAudioSession", () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { RTCAudioSession } = require("@livekit/react-native-webrtc") as {
          RTCAudioSession: {
            audioSessionDidActivate: () => void;
            audioSessionDidDeactivate: () => void;
          };
        };
        RTCAudioSession.audioSessionDidActivate();
      } catch {
        /* ignore */
      }
    });
    RNCallKeep.addEventListener("didDeactivateAudioSession", () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { RTCAudioSession } = require("@livekit/react-native-webrtc") as {
          RTCAudioSession: {
            audioSessionDidActivate: () => void;
            audioSessionDidDeactivate: () => void;
          };
        };
        RTCAudioSession.audioSessionDidDeactivate();
      } catch {
        /* ignore */
      }
    });
    RNCallKeep.addEventListener("endCall", () => {
      callActive = false;
      endHandler?.();
    });
    RNCallKeep.addEventListener("didPerformSetMutedCallAction", ({ muted }) => {
      if (lastMuted === muted) return;
      lastMuted = muted;
      muteHandler?.(muted);
    });

    setupDone = true;
  } catch {
    unavailable = true;
    setupDone = false;
  }
}

/** Begin a CallKit “call” so iOS keeps WebRTC alive while locked. */
export async function startCallService(): Promise<void> {
  if (Platform.OS !== "ios" || unavailable) return;
  setupCallService();
  const loaded = loadCallKeep();
  if (!loaded || callActive || unavailable) return;

  try {
    const { RNCallKeep } = loaded;
    // Match LiveKit sample: numeric handle type. "generic" has crashed some iOS builds.
    RNCallKeep.startCall(CALL_UUID, "alfred", "Alfred", "number", false);
    RNCallKeep.reportConnectingOutgoingCallWithUUID(CALL_UUID);
    setTimeout(() => {
      try {
        RNCallKeep.reportConnectedOutgoingCallWithUUID(CALL_UUID);
      } catch {
        /* ignore */
      }
    }, 100);
    callActive = true;
  } catch {
    callActive = false;
    unavailable = true;
  }
}

export async function stopCallService(): Promise<void> {
  if (Platform.OS !== "ios" || !callActive) return;
  const loaded = loadCallKeep();
  if (!loaded) {
    callActive = false;
    return;
  }
  try {
    const { RNCallKeep, CONSTANTS } = loaded;
    RNCallKeep.endCall(CALL_UUID);
    RNCallKeep.reportEndCallWithUUID(CALL_UUID, CONSTANTS.END_CALL_REASONS.REMOTE_ENDED);
  } catch {
    /* ignore */
  }
  callActive = false;
  lastMuted = null;
}

export function setCallServiceMuted(muted: boolean): void {
  if (Platform.OS !== "ios" || !callActive || unavailable) return;
  const loaded = loadCallKeep();
  if (!loaded) return;
  try {
    if (lastMuted === muted) return;
    lastMuted = muted;
    loaded.RNCallKeep.setMutedCall(CALL_UUID, muted);
  } catch {
    /* ignore */
  }
}

export function isCallServiceActive(): boolean {
  return callActive;
}

/** Permanently skip CallKit for this process (e.g. after a recovered failure). */
export function disableCallService(): void {
  unavailable = true;
  callActive = false;
}
