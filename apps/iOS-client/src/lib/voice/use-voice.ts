/**
 * Voice session state for the Talk screen (voice guide §6, §9).
 *
 * Captions and user transcript are a *view* of what the Mac's agent publishes.
 * Nothing here decides that an utterance ended or that a turn is final — those
 * are the agent's calls, arriving as data frames.
 */
import type { RemoteAudioTrack } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { create } from "zustand";
import { isNotBuiltYet, sessionStatus } from "../desktop-api";
import type { VoiceStack } from "../types";
import {
  VoiceUnavailableError,
  isLiveKitAvailable,
  startVoiceSession,
} from "./livekit-transport";
import type { VoiceSessionHandle } from "./livekit-transport";
import { CAPTION_TOPIC, IDLE_CAPTION, applyCaption, revealedText } from "./protocol";
import type { CaptionState, UiCommand, UiLayout, VoiceMessage } from "./protocol";

export type VoicePhase = "idle" | "connecting" | "live" | "error";

/**
 * Why speaking isn't on offer. Each maps to a different sentence for the user —
 * "your Mac isn't set up" and "this build can't do voice" are not the same
 * problem and must not share a message.
 */
export type VoiceBlocker =
  | "none"
  | "no-sdk"
  | "not-configured"
  | "no-mic"
  | "desktop-too-old"
  | "unreachable";

interface VoiceStore {
  phase: VoicePhase;
  blocker: VoiceBlocker;
  micEnabled: boolean;
  agentPresent: boolean;
  /** LiveKit remote audio track for Alfred's TTS (waveform). */
  agentAudioTrack: RemoteAudioTrack | null;
  identity: string | null;
  room: string | null;
  /** Which Mac voice worker is serving Talk; null until status/token says. */
  voiceStack: VoiceStack | null;
  caption: CaptionState;
  /** Live STT of the user, replaced until the agent marks it final. */
  userPartial: string | null;
  userFinal: string[];
  error: string | null;
  /**
   * Continuous conversation: keep LiveKit + AVAudioSession alive through lock
   * screen / pocket use (requires UIBackgroundModes audio — already in Info.plist).
   */
  keepAliveInBackground: boolean;
  /**
   * Red Stop / CallKit End. Talk focus must not auto-restart until they press
   * Start (or the next cold launch).
   */
  endedByUser: boolean;
  set: (patch: Partial<VoiceStore>) => void;
  applyMessage: (message: VoiceMessage) => void;
  reset: () => void;
}

const EMPTY = {
  phase: "idle" as VoicePhase,
  micEnabled: false,
  agentPresent: false,
  agentAudioTrack: null as RemoteAudioTrack | null,
  identity: null,
  room: null,
  voiceStack: null as VoiceStack | null,
  caption: IDLE_CAPTION,
  userPartial: null,
  userFinal: [] as string[],
  error: null,
  keepAliveInBackground: false,
};

export const useVoice = create<VoiceStore>((set) => ({
  ...EMPTY,
  blocker: "none",
  endedByUser: false,

  set: (patch) => set(patch),

  applyMessage: (message) =>
    set((current) => {
      if (message.channel === CAPTION_TOPIC) {
        return { caption: applyCaption(current.caption, message) };
      }
      if (message.type === "partial") return { userPartial: message.text };
      // A final line is committed history; the partial that produced it goes.
      return {
        userPartial: null,
        userFinal: message.text ? [...current.userFinal, message.text] : current.userFinal,
      };
    }),

  reset: () =>
    set((current) => ({
      ...EMPTY,
      endedByUser: current.endedByUser,
    })),
}));

/** The caption text actually on screen. */
export function useSpokenCaption(): string {
  return useVoice((s) => revealedText(s.caption));
}

/**
 * Ask the Mac whether voice is even possible before offering the button.
 *
 * Three things must all be true: this build has the native SDK, the desktop has
 * LiveKit credentials, and a voice worker is ready. Cascade probes `alfred-agent`
 * in the fixed room; live (`make alfred VOICE=live`) reports ready when the
 * GPT-Live stack is configured (the agent joins on Talk dispatch). Captions
 * always arrive on `alfred.caption` / `alfred.user` for either stack.
 */
export function useVoiceAvailability(enabled: boolean) {
  const [checking, setChecking] = useState(false);
  const [agentHint, setAgentHint] = useState<string | null>(null);
  const setStore = useVoice((s) => s.set);
  const blocker = useVoice((s) => s.blocker);
  const voiceStack = useVoice((s) => s.voiceStack);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // No native SDK means no amount of desktop configuration will help.
    if (!isLiveKitAvailable()) {
      setStore({ blocker: "no-sdk" });
      return;
    }

    setChecking(true);
    sessionStatus()
      .then((status) => {
        if (cancelled) return;
        setAgentHint(status.agentHint);
        // Prefer desktop-reported presence when available (empty-room zombie).
        if (typeof status.agentPresent === "boolean") {
          setStore({ agentPresent: status.agentPresent });
        }
        if (status.voiceStack) {
          setStore({ voiceStack: status.voiceStack });
        }
        // `null` means an older desktop that doesn't report the field; let the
        // user try rather than refusing on a missing boolean.
        setStore({ blocker: status.livekitConfigured === false ? "not-configured" : "none" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStore({ blocker: isNotBuiltYet(err) ? "desktop-too-old" : "unreachable" });
      })
      .finally(() => !cancelled && setChecking(false));

    return () => {
      cancelled = true;
    };
  }, [enabled, setStore]);

  return { checking, agentHint, blocker, voiceStack };
}

/**
 * Session handle lives at module scope so Talk can unmount (other tabs) without
 * tearing down a live conversation. Only explicit stop / hold-background end it.
 */
let sessionHandle: VoiceSessionHandle | null = null;
let startInFlight: Promise<boolean> | null = null;
let appStateBound = false;

export type StopVoiceOptions = {
  /** Red Stop / CallKit End — Talk focus must not auto-restart. */
  endedByUser?: boolean;
};

async function stopSharedSession(opts: StopVoiceOptions = {}): Promise<void> {
  startInFlight = null;
  const active = sessionHandle;
  sessionHandle = null;
  if (opts.endedByUser) useVoice.getState().set({ endedByUser: true });
  useVoice.getState().set({ keepAliveInBackground: false });
  useVoice.getState().reset();
  if (active) await active.disconnect().catch(() => {});
}

function bindVoiceAppState(): () => void {
  if (appStateBound) return () => {};
  appStateBound = true;
  const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
    if (next !== "background") return;
    if (useVoice.getState().keepAliveInBackground) return;
    void stopSharedSession();
  });
  return () => {
    sub.remove();
    appStateBound = false;
  };
}

/** Mount once in the tab shell so background policy outlives the Talk screen. */
export function VoiceSessionHost() {
  useEffect(() => bindVoiceAppState(), []);
  return null;
}

/**
 * Join, hold, and leave. The room stays connected while the mic is off in
 * hold-to-talk, because Alfred may still be answering the previous thing you
 * said — disconnecting on release would cut him off mid-sentence.
 */
export function useVoiceSession() {
  const store = useVoice((s) => s.set);
  const applyMessage = useVoice((s) => s.applyMessage);
  const reset = useVoice((s) => s.reset);

  const stop = useCallback(async (opts?: StopVoiceOptions) => {
    await stopSharedSession(opts);
  }, []);

  const start = useCallback(async (opts?: { mic?: boolean }) => {
    const wantMic = opts?.mic ?? true;

    // Healthy live room — optionally sync mic, then done.
    if (sessionHandle?.isConnected()) {
      await sessionHandle.setMicrophoneEnabled(wantMic).catch(() => {});
      store({ micEnabled: wantMic, endedByUser: false });
      return true;
    }

    // Zombie handle after background / drop: tear down before minting a fresh room.
    if (sessionHandle) {
      const stale = sessionHandle;
      sessionHandle = null;
      await stale.disconnect().catch(() => {});
      reset();
    }

    if (startInFlight) return startInFlight;

    const pending = (async () => {
      store({
        phase: "connecting",
        error: null,
        agentPresent: false,
        agentAudioTrack: null,
        endedByUser: false,
      });
      try {
        const session = await startVoiceSession(
          {
            onMessage: applyMessage,
            onAgentAudio: (present) => store({ agentPresent: present }),
            onAgentAudioTrack: (track) => store({ agentAudioTrack: track }),
            onDisconnected: () => {
              // Teardown (incl. audio session) already ran in the transport.
              sessionHandle = null;
              reset();
            },
          },
          { microphoneEnabled: wantMic }
        );
        sessionHandle = session;
        store({
          phase: "live",
          micEnabled: wantMic,
          identity: session.identity,
          room: session.room,
          voiceStack: session.voiceStack,
          endedByUser: false,
        });
        return true;
      } catch (err) {
        const blocker: VoiceBlocker =
          err instanceof VoiceUnavailableError ? err.reason : "unreachable";
        store({
          phase: "error",
          blocker,
          error:
            blocker === "no-mic"
              ? "Alfred needs the microphone to hear you."
              : "Couldn't join the voice room on your Mac.",
        });
        return false;
      } finally {
        startInFlight = null;
      }
    })();

    startInFlight = pending;
    return pending;
  }, [applyMessage, reset, store]);

  const setMic = useCallback(
    async (enabled: boolean) => {
      if (!sessionHandle?.isConnected()) return;
      await sessionHandle.setMicrophoneEnabled(enabled).catch(() => {});
      store({ micEnabled: enabled });
    },
    [store]
  );

  const publishControl = useCallback(async (command: UiCommand) => {
    if (!sessionHandle?.isConnected()) return;
    await sessionHandle.publishControl(command).catch(() => {});
  }, []);

  /**
   * Tell the agent which UI layout is active (voice auto-commits; chat does not).
   * Mic policy matches desktop voice-client: chat mutes; voice leaves mic alone
   * unless `mic` is passed (continuous arms, hold stays off until PTT).
   */
  const setLayout = useCallback(
    async (layout: UiLayout, opts?: { mic?: boolean }) => {
      await publishControl({ type: "layout", layout });
      if (layout === "chat") {
        await setMic(false);
        return;
      }
      if (opts?.mic !== undefined) await setMic(opts.mic);
    },
    [publishControl, setMic]
  );

  /** Typed turn over LiveKit (silent on the agent — speak: false). */
  const sendVoiceText = useCallback(
    async (text: string) => {
      await publishControl({ type: "text", text });
    },
    [publishControl]
  );

  return { start, stop, setMic, setLayout, sendVoiceText, publishControl };
}
