/**
 * Voice session state for the Talk screen (voice guide §6, §9).
 *
 * Captions and user transcript are a *view* of what the Mac's agent publishes.
 * Nothing here decides that an utterance ended or that a turn is final — those
 * are the agent's calls, arriving as data frames.
 */
import type { RemoteAudioTrack } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
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

  reset: () => set({ ...EMPTY }),
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
 * Join, hold, and leave. The room stays connected while the mic is off in
 * hold-to-talk, because Alfred may still be answering the previous thing you
 * said — disconnecting on release would cut him off mid-sentence.
 */
export function useVoiceSession() {
  const handle = useRef<VoiceSessionHandle | null>(null);
  const startInFlight = useRef<Promise<boolean> | null>(null);
  const store = useVoice((s) => s.set);
  const applyMessage = useVoice((s) => s.applyMessage);
  const reset = useVoice((s) => s.reset);

  const stop = useCallback(async () => {
    startInFlight.current = null;
    const active = handle.current;
    handle.current = null;
    // Clear keepalive so a later background tick cannot skip teardown logic
    // that already ran, and so remints do not inherit a stale "stay up" flag.
    store({ keepAliveInBackground: false });
    reset();
    if (active) await active.disconnect().catch(() => {});
  }, [reset, store]);

  const start = useCallback(async (opts?: { mic?: boolean }) => {
    const wantMic = opts?.mic ?? true;

    // Healthy live room — optionally sync mic, then done.
    if (handle.current?.isConnected()) {
      await handle.current.setMicrophoneEnabled(wantMic).catch(() => {});
      store({ micEnabled: wantMic });
      return true;
    }

    // Zombie handle after background / drop: tear down before minting a fresh room.
    if (handle.current) {
      const stale = handle.current;
      handle.current = null;
      await stale.disconnect().catch(() => {});
      reset();
    }

    if (startInFlight.current) return startInFlight.current;

    const pending = (async () => {
      store({ phase: "connecting", error: null, agentPresent: false, agentAudioTrack: null });
      try {
        const session = await startVoiceSession(
          {
            onMessage: applyMessage,
            onAgentAudio: (present) => store({ agentPresent: present }),
            onAgentAudioTrack: (track) => store({ agentAudioTrack: track }),
            onDisconnected: () => {
              // Teardown (incl. audio session) already ran in the transport.
              if (handle.current) handle.current = null;
              reset();
            },
          },
          { microphoneEnabled: wantMic }
        );
        handle.current = session;
        store({
          phase: "live",
          micEnabled: wantMic,
          identity: session.identity,
          room: session.room,
          voiceStack: session.voiceStack,
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
        startInFlight.current = null;
      }
    })();

    startInFlight.current = pending;
    return pending;
  }, [applyMessage, reset, store]);

  const setMic = useCallback(
    async (enabled: boolean) => {
      if (!handle.current?.isConnected()) return;
      await handle.current.setMicrophoneEnabled(enabled).catch(() => {});
      store({ micEnabled: enabled });
    },
    [store]
  );

  const publishControl = useCallback(async (command: UiCommand) => {
    if (!handle.current?.isConnected()) return;
    await handle.current.publishControl(command).catch(() => {});
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

  // Hold-to-talk ends on background (privacy/battery). Continuous conversation
  // keeps the room alive so lock-screen + headphones still work (UIBackgroundModes=audio).
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next !== "background") return;
      if (useVoice.getState().keepAliveInBackground) return;
      void stop();
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, [stop]);

  // A live microphone must never outlive the screen that owns it.
  useEffect(() => {
    return () => {
      const active = handle.current;
      handle.current = null;
      reset();
      if (active) active.disconnect().catch(() => {});
    };
  }, [reset]);

  return { start, stop, setMic, setLayout, sendVoiceText, publishControl };
}
