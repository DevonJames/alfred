/**
 * Talk — text-only and voice-only layouts (mobile adaptation of desktop uplink).
 *
 * Voice: waveform of Alfred's speech (~1/3 height, shrinkable to ~10%) with a
 * scrollable response below. Text: transcript thread + composer. LiveKit
 * `alfred.control` keeps the Mac agent in sync with layout (voice vs chat).
 */
import { useMutation } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { Keyboard, Radio, Send } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AppState, Image, Pressable, ScrollView, Text, TextInput, View, type ImageSourcePropType } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentWaveform } from "@/components/AgentWaveform";
import { AlfredMarkdown } from "@/components/AlfredMarkdown";
import { Backdrop, BRASS, ConnectionPill, Display, Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useConnection } from "@/lib/connection";
import { rediscover } from "@/lib/discovery";
import { sendTurn } from "@/lib/desktop-api";
import { stripMarkdown } from "@/lib/markdown";
import { useConversationSession, useSession } from "@/lib/session";
import type { ConversationTurn } from "@/lib/types";
import {
  setCallServiceHandlers,
  setCallServiceMuted,
  startCallService,
  stopCallService,
} from "@/lib/voice/call-service";
import {
  useSpokenCaption,
  useVoice,
  useVoiceAvailability,
  useVoiceSession,
} from "@/lib/voice/use-voice";
import type { VoiceBlocker } from "@/lib/voice/use-voice";
import type { UiLayout } from "@/lib/voice/protocol";

/** Shared height for the voice control strip (mode, Shhh, mute, start/stop). */
const CONTROL_SIZE = 56;

const ICONS = {
  hold: require("../../../assets/voice-controls/hold.png") as ImageSourcePropType,
  continuous: require("../../../assets/voice-controls/continuous.png") as ImageSourcePropType,
  shhh: require("../../../assets/voice-controls/shhh.png") as ImageSourcePropType,
  micMute: require("../../../assets/voice-controls/mic-mute.png") as ImageSourcePropType,
  micStart: require("../../../assets/voice-controls/mic-start-white.png") as ImageSourcePropType,
  stop: require("../../../assets/voice-controls/stop-white.png") as ImageSourcePropType,
};

function VoiceIcon({
  source,
  size = 30,
  opacity = 1,
}: {
  source: ImageSourcePropType;
  size?: number;
  opacity?: number;
}) {
  return (
    <Image
      source={source}
      style={{ width: size, height: size, opacity }}
      resizeMode="contain"
    />
  );
}

/** Within voice layout: press-and-hold vs continuous conversation. */
type VoiceMicMode = "hold" | "continuous";

const BLOCKER_MESSAGE: Record<Exclude<VoiceBlocker, "none">, string> = {
  "no-sdk":
    "This build of Alfred doesn't include the live audio engine, so speaking out loud isn't available here. Typing reaches him exactly the same way.",
  "not-configured":
    "Your Mac isn't set up for live audio yet. Once it is, the microphone will appear here on its own.",
  "no-mic": "Microphone access is off, so I've switched to typing. Everything works the same way.",
  "desktop-too-old":
    "The Alfred app on your Mac is an older build without live audio. Typing works now; update the Mac to speak.",
  unreachable: "I couldn't reach your Mac to set up the microphone. Typing still works.",
};

export default function Talk() {
  const insets = useSafeAreaInsets();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);

  const [focused, setFocused] = useState(false);
  const [layout, setUiLayout] = useState<UiLayout>("voice");
  const [micMode, setMicMode] = useState<VoiceMicMode>("hold");
  /** Continuous session started via the orb (mute can leave this true with mic off). */
  const [continuousActive, setContinuousActive] = useState(false);
  /** Continuous-only: mute mic without ending the conversation. */
  const [micMuted, setMicMuted] = useState(false);
  const [waveCollapsed, setWaveCollapsed] = useState(false);
  const [draft, setDraft] = useState("");

  const turns = useSession((s) => s.turns);
  const partial = useSession((s) => s.partial);
  const state = useSession((s) => s.state);
  const sessionError = useSession((s) => s.error);
  const sessionUnavailable = useSession((s) => s.unavailable);
  useConversationSession(focused);

  const { agentHint } = useVoiceAvailability(focused);
  const blocker = useVoice((s) => s.blocker);
  const phase = useVoice((s) => s.phase);
  const micEnabled = useVoice((s) => s.micEnabled);
  const agentPresent = useVoice((s) => s.agentPresent);
  const agentAudioTrack = useVoice((s) => s.agentAudioTrack);
  const voiceError = useVoice((s) => s.error);
  const userPartial = useVoice((s) => s.userPartial);
  const userFinal = useVoice((s) => s.userFinal);
  const captionSpeaking = useVoice((s) => s.caption.speaking);
  const caption = useSpokenCaption();
  const fullCaption = useVoice((s) => s.caption.text);
  const setVoice = useVoice((s) => s.set);
  const { start, stop, setMic, setLayout, sendVoiceText, publishControl } = useVoiceSession();

  const scroller = useRef<ScrollView>(null);
  const voiceScroller = useRef<ScrollView>(null);

  const voiceBlocked = blocker !== "none";
  const inVoiceLayout = layout === "voice" && !voiceBlocked;

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );

  useEffect(() => {
    if (!focused) stop().catch(() => {});
  }, [focused, stop]);

  useEffect(() => {
    if (voiceBlocked) setUiLayout("chat");
  }, [voiceBlocked]);

  useEffect(() => {
    const timer = setTimeout(() => {
      scroller.current?.scrollToEnd({ animated: true });
      voiceScroller.current?.scrollToEnd({ animated: true });
    }, 60);
    return () => clearTimeout(timer);
  }, [turns.length, partial, caption, userPartial, userFinal.length, fullCaption]);

  const sendText = useMutation({
    mutationFn: async (text: string) => {
      if (phase === "live") {
        await sendVoiceText(text);
        return;
      }
      await sendTurn(text, { source: "text" });
    },
    onMutate: () => setDraft(""),
  });

  const switchLayout = useCallback(
    async (next: UiLayout) => {
      if (next === layout) return;
      Haptics.selectionAsync();
      setUiLayout(next);
      if (next === "chat") {
        setContinuousActive(false);
        if (phase === "live") await setLayout("chat");
        else await stop().catch(() => {});
        return;
      }
      // voice — continuous arms the mic (desktop); hold joins quiet until PTT
      if (voiceBlocked) return;
      const armMic = micMode === "continuous";
      const joined = await start({ mic: armMic && !micMuted });
      if (!joined) {
        setUiLayout("chat");
        return;
      }
      setContinuousActive(armMic);
      await publishControl({ type: "mute", muted: micMuted });
      await setLayout("voice", { mic: armMic && !micMuted });
    },
    [layout, micMode, micMuted, phase, publishControl, setLayout, start, stop, voiceBlocked]
  );

  /** Arm the mic: PTT press, or continuous Start (desktop-style open listen). */
  const openMic = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const wantMic = micMode === "continuous" ? !micMuted : true;
    const joined = await start({ mic: wantMic });
    if (!joined) {
      setUiLayout("chat");
      return;
    }
    if (micMode === "continuous") setContinuousActive(true);
    await publishControl({ type: "mute", muted: micMuted });
    await setLayout("voice", { mic: wantMic });
  }, [micMode, micMuted, publishControl, setLayout, start]);

  /** Release PTT, or continuous Stop — ends continuous listen; room stays for playback. */
  const closeMic = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (micMode === "continuous") setContinuousActive(false);
    await setMic(false);
  }, [micMode, setMic]);

  const toggleMute = useCallback(async () => {
    Haptics.selectionAsync();
    const nextMuted = !micMuted;
    setMicMuted(nextMuted);
    await publishControl({ type: "mute", muted: nextMuted });
    if (continuousActive) await setMic(!nextMuted);
  }, [continuousActive, micMuted, publishControl, setMic]);

  const stopSpeaking = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await publishControl({ type: "stop" });
  }, [publishControl]);

  const setMicModeAndApply = useCallback(
    (next: VoiceMicMode) => {
      if (next === micMode) return;
      Haptics.selectionAsync();
      setMicMode(next);
      if (next === "hold") {
        setContinuousActive(false);
        setMicMuted(false);
        void publishControl({ type: "mute", muted: false });
        if (phase === "live" && layout === "voice") void setMic(false);
        return;
      }
      // Continuous: arm like desktop when already in a live voice session.
      if (phase === "live" && layout === "voice") {
        setContinuousActive(true);
        void setMic(!micMuted);
      }
    },
    [layout, micMode, micMuted, phase, publishControl, setMic]
  );

  useEffect(() => {
    if (phase !== "live") {
      setContinuousActive(false);
    }
  }, [phase]);

  // Pocket / lock-screen: keep the LiveKit room up only while Continuous is active.
  useEffect(() => {
    const keep = micMode === "continuous" && continuousActive;
    setVoice({ keepAliveInBackground: keep });
  }, [continuousActive, micMode, setVoice]);

  // CallKit keep-alive is only needed once iOS would suspend WebRTC (lock / pocket).
  // Starting it in the foreground has crashed continuous mode on device builds, so
  // arm CallKit only when leaving the foreground while a continuous session is live.
  useEffect(() => {
    const continuousLive = micMode === "continuous" && continuousActive && phase === "live";
    if (!continuousLive) {
      void stopCallService();
      return;
    }

    const syncCallKit = (state: string) => {
      if (state === "background") void startCallService();
      else void stopCallService();
    };

    syncCallKit(AppState.currentState);
    const sub = AppState.addEventListener("change", syncCallKit);
    return () => {
      sub.remove();
      void stopCallService();
    };
  }, [continuousActive, micMode, phase]);

  useEffect(() => {
    setCallServiceHandlers({
      onEnd: () => {
        setContinuousActive(false);
        void setMic(false);
      },
      onMute: (muted) => {
        setMicMuted((prev) => (prev === muted ? prev : muted));
        void publishControl({ type: "mute", muted });
        if (continuousActive) void setMic(!muted);
      },
    });
    return () => setCallServiceHandlers({});
  }, [continuousActive, publishControl, setMic]);

  useEffect(() => {
    setCallServiceMuted(micMuted);
  }, [micMuted]);

  // Drop CallKit when leaving the Talk screen entirely.
  useEffect(() => {
    return () => {
      void stopCallService();
    };
  }, []);

  const connecting = phase === "connecting";
  const busy = connecting || state === "thinking";
  const notice = voiceError ?? (voiceBlocked ? BLOCKER_MESSAGE[blocker] : null);

  return (
    <Backdrop>
      <View
        testID="talk-screen"
        style={{
          flex: 1,
          paddingHorizontal: 16,
          paddingTop: insets.top + 6,
          paddingBottom: 4,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <ConnectionPill
            mode={mode}
            busy={discovering}
            onPress={() => rediscover().catch(() => {})}
          />
          <LayoutToggle
            layout={inVoiceLayout ? "voice" : "chat"}
            disabled={sessionUnavailable}
            voiceDisabled={voiceBlocked}
            onVoice={() => void switchLayout("voice")}
            onChat={() => void switchLayout("chat")}
          />
        </View>

        {inVoiceLayout ? (
          <VoiceStage
            waveCollapsed={waveCollapsed}
            onToggleWave={() => setWaveCollapsed((v) => !v)}
            track={agentAudioTrack}
            speaking={captionSpeaking}
            userPartial={userPartial}
            userFinal={userFinal}
            caption={caption}
            fullCaption={fullCaption}
            connecting={connecting}
            scrollerRef={voiceScroller}
            micMode={micMode}
            onSelectMicMode={setMicModeAndApply}
            micEnabled={micEnabled}
            continuousActive={continuousActive}
            micMuted={micMuted}
            busy={connecting}
            sessionUnavailable={sessionUnavailable}
            onStart={() => void openMic()}
            onStop={() => void closeMic()}
            onToggleMute={() => void toggleMute()}
            onStopSpeaking={() => void stopSpeaking()}
          />
        ) : (
          <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={8}>
            <ChatStage
              turns={turns}
              partial={partial}
              caption={caption}
              userPartial={userPartial}
              busy={busy}
              connecting={connecting}
              scrollerRef={scroller}
              draft={draft}
              setDraft={setDraft}
              sendPending={sendText.isPending}
              sessionUnavailable={sessionUnavailable}
              onSend={() => draft.trim() && sendText.mutate(draft.trim())}
            />
          </KeyboardAvoidingView>
        )}

        {sessionError ? (
          <Notice tone={sessionUnavailable ? "info" : "error"} testID="session-error">
            {sessionError}
          </Notice>
        ) : null}
        {notice ? (
          <Notice tone={voiceError ? "error" : "info"} testID="voice-notice">
            {notice}
          </Notice>
        ) : null}
        {agentHint && phase === "live" && !agentPresent ? (
          <Notice tone="info" testID="agent-hint">
            {agentHint}
          </Notice>
        ) : null}
      </View>
    </Backdrop>
  );
}

function LayoutToggle({
  layout,
  disabled,
  voiceDisabled,
  onVoice,
  onChat,
}: {
  layout: UiLayout;
  disabled: boolean;
  voiceDisabled: boolean;
  onVoice: () => void;
  onChat: () => void;
}) {
  return (
    <View
      testID="layout-toggle"
      className="flex-row overflow-hidden rounded-full border border-line bg-ink-700"
    >
      <Pressable
        testID="layout-voice"
        disabled={disabled || voiceDisabled}
        onPress={onVoice}
        className={cn(
          "flex-row items-center space-x-1.5 px-3 py-1.5",
          layout === "voice" ? "bg-ink-500" : "active:opacity-70",
          (disabled || voiceDisabled) && "opacity-40"
        )}
      >
        <Radio color={layout === "voice" ? BRASS : "#8D939E"} size={13} />
        <Text className={cn("text-xs", layout === "voice" ? "text-bone" : "text-muted")}>
          Voice
        </Text>
      </Pressable>
      <Pressable
        testID="layout-chat"
        disabled={disabled}
        onPress={onChat}
        className={cn(
          "flex-row items-center space-x-1.5 px-3 py-1.5",
          layout === "chat" ? "bg-ink-500" : "active:opacity-70",
          disabled && "opacity-40"
        )}
      >
        <Keyboard color={layout === "chat" ? BRASS : "#8D939E"} size={13} />
        <Text className={cn("text-xs", layout === "chat" ? "text-bone" : "text-muted")}>
          Text
        </Text>
      </Pressable>
    </View>
  );
}

function VoiceStage({
  waveCollapsed,
  onToggleWave,
  track,
  speaking,
  userPartial,
  userFinal,
  caption,
  fullCaption,
  connecting,
  scrollerRef,
  micMode,
  onSelectMicMode,
  micEnabled,
  continuousActive,
  micMuted,
  busy,
  sessionUnavailable,
  onStart,
  onStop,
  onToggleMute,
  onStopSpeaking,
}: {
  waveCollapsed: boolean;
  onToggleWave: () => void;
  track: ReturnType<typeof useVoice.getState>["agentAudioTrack"];
  speaking: boolean;
  userPartial: string | null;
  userFinal: string[];
  caption: string;
  fullCaption: string;
  connecting: boolean;
  scrollerRef: RefObject<ScrollView | null>;
  micMode: VoiceMicMode;
  onSelectMicMode: (mode: VoiceMicMode) => void;
  micEnabled: boolean;
  continuousActive: boolean;
  micMuted: boolean;
  busy: boolean;
  sessionUnavailable: boolean;
  onStart: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  onStopSpeaking: () => void;
}) {
  const ghost = fullCaption.length > caption.length ? fullCaption.slice(caption.length) : "";
  const hasTranscript = Boolean(caption || ghost || userFinal.length || userPartial);
  const latestUser = userPartial ?? (userFinal.length ? userFinal[userFinal.length - 1] : null);
  const orbListening = micMode === "continuous" ? continuousActive : micEnabled;

  return (
    <View style={{ flex: 1 }} testID="voice-stage">
      <AgentWaveform
        track={track}
        collapsed={waveCollapsed}
        onToggleCollapsed={onToggleWave}
      />

      <View
        style={{
          marginTop: 8,
          flex: 1,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: "#2E343D",
          backgroundColor: "#111317",
          overflow: "hidden",
        }}
      >
        <ScrollView
          ref={scrollerRef}
          testID="voice-response-scroll"
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: hasTranscript ? "flex-end" : "flex-start",
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 80,
          }}
          showsVerticalScrollIndicator
        >
          {!hasTranscript ? (
            <Text
              style={{
                fontFamily: "InstrumentSerif_400Regular",
                fontSize: 26,
                lineHeight: 34,
                color: "#F4F1EA",
              }}
            >
              I'm listening, whenever you are.
            </Text>
          ) : null}

          {latestUser ? (
            <Text
              testID="voice-user-partial"
              style={{
                marginBottom: 12,
                textAlign: "right",
                fontSize: 16,
                lineHeight: 24,
                color: "#D8A54A",
              }}
            >
              {latestUser}
            </Text>
          ) : null}

          {caption || ghost ? (
            <View testID="voice-caption">
              {caption ? <AlfredMarkdown>{caption}</AlfredMarkdown> : null}
              {ghost ? (
                <Text
                  style={{
                    fontFamily: "InstrumentSerif_400Regular",
                    fontSize: 20,
                    lineHeight: 30,
                    color: "#8D939E",
                  }}
                >
                  {stripMarkdown(ghost)}
                </Text>
              ) : null}
              {speaking ? <Text style={{ color: BRASS }}>▍</Text> : null}
            </View>
          ) : null}

          {connecting ? (
            <Text style={{ marginTop: 12, fontSize: 15, fontStyle: "italic", color: "#8D939E" }}>
              Opening the line…
            </Text>
          ) : null}
        </ScrollView>

        {sessionUnavailable ? null : (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: 12,
              right: 12,
              bottom: 10,
              height: CONTROL_SIZE,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <MicModeToggle mode={micMode} onSelect={onSelectMicMode} />

            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <ControlChip
                testID="stop-speaking"
                active={speaking}
                onPress={onStopSpeaking}
                accessibilityLabel="Shhh — stop Alfred speaking"
                icon={<VoiceIcon source={ICONS.shhh} size={40} opacity={speaking ? 1 : 0.9} />}
              />
              {micMode === "continuous" && continuousActive ? (
                <ControlChip
                  testID="mute-mic"
                  active={micMuted}
                  onPress={onToggleMute}
                  accessibilityLabel={micMuted ? "Unmute microphone" : "Mute microphone"}
                  icon={<VoiceIcon source={ICONS.micMute} size={40} opacity={micMuted ? 1 : 0.9} />}
                />
              ) : null}
            </View>

            <MicOrb
              listening={orbListening}
              busy={busy}
              continuous={micMode === "continuous"}
              onStart={onStart}
              onStop={onStop}
            />
          </View>
        )}
      </View>
    </View>
  );
}

function ChatStage({
  turns,
  partial,
  caption,
  userPartial,
  busy,
  connecting,
  scrollerRef,
  draft,
  setDraft,
  sendPending,
  sessionUnavailable,
  onSend,
}: {
  turns: ConversationTurn[];
  partial: string | null;
  caption: string;
  userPartial: string | null;
  busy: boolean;
  connecting: boolean;
  scrollerRef: RefObject<ScrollView | null>;
  draft: string;
  setDraft: (v: string) => void;
  sendPending: boolean;
  sessionUnavailable: boolean;
  onSend: () => void;
}) {
  return (
    <View className="mt-4 flex-1" testID="chat-stage">
      <ScrollView
        ref={scrollerRef}
        testID="captions-scroll"
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {turns.length === 0 && !partial && !caption && !userPartial ? (
          <Animated.View entering={FadeIn.delay(200)} className="mt-16">
            <Display className="text-5xl">
              I'm listening,{"\n"}whenever you are.
            </Display>
            <Text className="mt-4 text-base leading-[22px] text-faint">
              Tell me something to remember, or ask what I already know.
            </Text>
          </Animated.View>
        ) : null}

        {turns.map((turn) => (
          <Caption key={turn.id} turn={turn} />
        ))}

        {partial ? (
          <Animated.View entering={FadeIn} className="mt-4 self-end" testID="partial-caption">
            <Text className="text-right text-lg leading-6 text-muted">{partial}</Text>
          </Animated.View>
        ) : null}

        {userPartial ? (
          <Animated.View entering={FadeIn} className="mt-4 self-end" testID="voice-user-partial">
            <Text className="text-right text-lg leading-6 text-muted">{userPartial}</Text>
          </Animated.View>
        ) : null}

        {caption ? (
          <Animated.View entering={FadeIn} className="mt-5" testID="voice-caption">
            <AlfredMarkdown large>{caption}</AlfredMarkdown>
          </Animated.View>
        ) : null}

        {busy ? (
          <Animated.View entering={FadeIn} className="mt-4" testID="thinking-indicator">
            <Text className="text-sm italic text-faint">
              {connecting ? "Opening the line…" : "Alfred is thinking…"}
            </Text>
          </Animated.View>
        ) : null}
      </ScrollView>

      {sessionUnavailable ? null : (
        <View className="mt-3 flex-row items-end space-x-2" testID="text-input-row">
          <TextInput
            testID="talk-text-input"
            value={draft}
            onChangeText={setDraft}
            placeholder="Say something to Alfred"
            placeholderTextColor="#5F656F"
            multiline
            className="max-h-32 min-h-[52px] flex-1 rounded-2xl border border-line bg-ink-700 px-4 py-3.5 text-base text-bone"
            onSubmitEditing={onSend}
          />
          <Pressable
            testID="send-text"
            disabled={!draft.trim() || sendPending}
            onPress={onSend}
            className={cn(
              "h-[52px] w-[52px] items-center justify-center rounded-2xl active:opacity-70",
              draft.trim() ? "bg-brass" : "bg-ink-600"
            )}
          >
            <Send color={draft.trim() ? "#0A0B0D" : "#5F656F"} size={19} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Caption({ turn }: { turn: ConversationTurn }) {
  const isUser = turn.role === "user";
  const superseded = turn.ledger === "superseded";
  const cancelled = turn.ledger === "cancelled";

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      testID={`caption-${turn.role}-${turn.ledger}`}
      className={cn("mt-5", isUser ? "items-end" : "items-start")}
    >
      {isUser ? (
        <Text
          className={cn(
            "text-right text-lg leading-6 text-bone",
            (superseded || cancelled) && "text-faint line-through"
          )}
        >
          {turn.text}
        </Text>
      ) : (
        <View className={cn((superseded || cancelled) && "opacity-50")}>
          <AlfredMarkdown large incomplete={false}>
            {turn.text}
          </AlfredMarkdown>
        </View>
      )}
      {superseded ? (
        <Text className="mt-1 text-xs text-warn">Replaced by a later answer</Text>
      ) : null}
      {turn.addendumOf ? (
        <Text className="mt-1 text-xs text-brass">Following up on the previous answer</Text>
      ) : null}
      {turn.memoryIdsUsed.length > 0 ? (
        <Text className="mt-1 text-xs text-faint">
          From {turn.memoryIdsUsed.length} thing{turn.memoryIdsUsed.length === 1 ? "" : "s"} I
          remember
        </Text>
      ) : null}
    </Animated.View>
  );
}

function ControlChip({
  testID,
  active,
  onPress,
  icon,
  accessibilityLabel,
}: {
  testID: string;
  active?: boolean;
  onPress: () => void;
  icon: ReactNode;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      style={{
        height: CONTROL_SIZE,
        width: CONTROL_SIZE,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 14,
        borderWidth: 1,
        borderColor: active ? "#E2574C" : "#2A2E36",
        backgroundColor: active ? "rgba(226,87,76,0.14)" : "#14161A",
      }}
    >
      {icon}
    </Pressable>
  );
}

function MicModeToggle({
  mode,
  onSelect,
}: {
  mode: VoiceMicMode;
  onSelect: (mode: VoiceMicMode) => void;
}) {
  return (
    <View
      testID="toggle-mic-mode"
      style={{
        height: CONTROL_SIZE,
        borderWidth: 1,
        borderColor: "#2A2E36",
        borderRadius: 14,
        backgroundColor: "#14161A",
        padding: 4,
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
      }}
    >
      {(["hold", "continuous"] as const).map((option) => {
        const active = mode === option;
        return (
          <Pressable
            key={option}
            testID={`mic-mode-${option}`}
            onPress={() => onSelect(option)}
            accessibilityLabel={option === "hold" ? "Hold to talk" : "Continuous conversation"}
            hitSlop={4}
            style={{
              height: CONTROL_SIZE - 8,
              width: CONTROL_SIZE - 8,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: active ? "#1F232B" : "transparent",
            }}
          >
            <VoiceIcon
              source={option === "hold" ? ICONS.hold : ICONS.continuous}
              size={30}
              opacity={active ? 1 : 0.55}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function MicOrb({
  listening,
  busy,
  continuous,
  onStart,
  onStop,
}: {
  listening: boolean;
  busy: boolean;
  continuous: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = listening
      ? withRepeat(withTiming(1.08, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true)
      : withTiming(1, { duration: 250 });
  }, [listening, pulse]);

  const halo = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    opacity: listening ? 0.35 : 0.15,
  }));

  return (
    <View style={{ height: CONTROL_SIZE, width: CONTROL_SIZE, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={[
          halo,
          {
            position: "absolute",
            height: CONTROL_SIZE,
            width: CONTROL_SIZE,
            borderRadius: CONTROL_SIZE / 2,
            backgroundColor: listening ? "#E2574C" : BRASS,
          },
        ]}
      />
      <Pressable
        testID="mic-orb"
        accessibilityLabel={listening ? "End conversation" : "Start conversation"}
        disabled={busy}
        onPressIn={continuous ? undefined : onStart}
        onPressOut={continuous ? undefined : onStop}
        onPress={continuous ? (listening ? onStop : onStart) : undefined}
        style={{
          height: CONTROL_SIZE,
          width: CONTROL_SIZE,
          borderRadius: CONTROL_SIZE / 2,
          borderWidth: 2,
          borderColor: listening ? "#E2574C" : BRASS,
          backgroundColor: listening ? "rgba(226,87,76,0.22)" : "rgba(216,165,74,0.2)",
          alignItems: "center",
          justifyContent: "center",
          opacity: busy ? 0.4 : 1,
        }}
      >
        <VoiceIcon
          source={listening ? ICONS.stop : ICONS.micStart}
          size={40}
          opacity={1}
        />
      </Pressable>
    </View>
  );
}
