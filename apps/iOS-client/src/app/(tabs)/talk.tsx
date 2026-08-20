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
import { Keyboard, Mic, Radio, Send } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
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
import { Backdrop, BRASS, ConnectionPill, Display, Label, Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useConnection } from "@/lib/connection";
import { rediscover } from "@/lib/discovery";
import { sendTurn } from "@/lib/desktop-api";
import { useConversationSession, useSession } from "@/lib/session";
import type { ConversationTurn } from "@/lib/types";
import {
  useSpokenCaption,
  useVoice,
  useVoiceAvailability,
  useVoiceSession,
} from "@/lib/voice/use-voice";
import type { VoiceBlocker } from "@/lib/voice/use-voice";
import type { UiLayout } from "@/lib/voice/protocol";

/** Within voice layout: press-and-hold vs hands-free mic. */
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
  const { start, stop, setMic, setLayout, sendVoiceText } = useVoiceSession();

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
        if (phase === "live") await setLayout("chat");
        else await stop().catch(() => {});
        return;
      }
      // voice
      if (voiceBlocked) return;
      const joined = phase === "live" ? true : await start();
      if (!joined) {
        setUiLayout("chat");
        return;
      }
      await setLayout("voice");
    },
    [layout, phase, setLayout, start, stop, voiceBlocked]
  );

  const openMic = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (phase !== "live") {
      const joined = await start();
      if (!joined) {
        setUiLayout("chat");
        return;
      }
      await setLayout("voice");
      return;
    }
    await setMic(true);
  }, [phase, setLayout, setMic, start]);

  const closeMic = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await setMic(false);
  }, [setMic]);

  const connecting = phase === "connecting";
  const busy = connecting || state === "thinking";
  const notice = voiceError ?? (voiceBlocked ? BLOCKER_MESSAGE[blocker] : null);

  return (
    <Backdrop>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={49}>
        <View
          testID="talk-screen"
          className="flex-1 px-5"
          style={{ paddingTop: insets.top + 12, paddingBottom: 8 }}
        >
          <View className="flex-row items-center justify-between">
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
              onCycleMicMode={() =>
                setMicMode((m) => (m === "hold" ? "continuous" : "hold"))
              }
              micEnabled={micEnabled}
              busy={connecting}
              sessionUnavailable={sessionUnavailable}
              onStart={() => void openMic()}
              onStop={() => void closeMic()}
            />
          ) : (
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
      </KeyboardAvoidingView>
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
  onCycleMicMode,
  micEnabled,
  busy,
  sessionUnavailable,
  onStart,
  onStop,
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
  onCycleMicMode: () => void;
  micEnabled: boolean;
  busy: boolean;
  sessionUnavailable: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const ghost = fullCaption.length > caption.length ? fullCaption.slice(caption.length) : "";

  return (
    <View className="mt-4 flex-1" testID="voice-stage">
      {userPartial ? (
        <Text className="mb-2 text-right text-sm leading-5 text-muted" testID="voice-user-partial">
          {userPartial}
        </Text>
      ) : null}

      <AgentWaveform
        track={track}
        speaking={speaking}
        collapsed={waveCollapsed}
        onToggleCollapsed={onToggleWave}
      />

      <ScrollView
        ref={scrollerRef}
        testID="voice-response-scroll"
        className="mt-3 flex-1 rounded-2xl border border-line bg-ink-800/80 px-4 py-3"
        contentContainerStyle={{ paddingBottom: 16, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        {!caption && userFinal.length === 0 ? (
          <Animated.View entering={FadeIn.delay(120)} className="mt-6">
            <Display className="text-3xl leading-10">
              I'm listening,{"\n"}whenever you are.
            </Display>
          </Animated.View>
        ) : null}

        {userFinal.map((line, i) => (
          <Text key={`uf-${i}`} className="mt-3 text-right text-base leading-6 text-muted">
            {line}
          </Text>
        ))}

        {caption || ghost ? (
          <Animated.View entering={FadeIn} className="mt-4" testID="voice-caption">
            <Text className="font-display text-2xl leading-8 text-bone">
              {caption}
              {ghost ? <Text className="text-faint">{ghost}</Text> : null}
              {speaking ? <Text className="text-brass">▍</Text> : null}
            </Text>
          </Animated.View>
        ) : null}

        {connecting ? (
          <Text className="mt-4 text-sm italic text-faint">Opening the line…</Text>
        ) : null}
      </ScrollView>

      {sessionUnavailable ? null : (
        <View className="mt-2 items-center">
          <Pressable
            testID="toggle-mic-mode"
            onPress={onCycleMicMode}
            className="mb-1 rounded-full px-3 py-1 active:opacity-70"
          >
            <Text className="text-xs text-muted">
              {micMode === "hold" ? "Hold to talk" : "Hands free"} · tap to switch
            </Text>
          </Pressable>
          <MicOrb
            listening={micEnabled}
            busy={busy}
            continuous={micMode === "continuous"}
            onStart={onStart}
            onStop={onStop}
          />
        </View>
      )}
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
            <Text className="font-display text-2xl leading-8 text-bone">{caption}</Text>
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
      <Text
        className={cn(
          isUser
            ? "text-right text-lg leading-6 text-bone"
            : "font-display text-2xl leading-8 text-bone",
          (superseded || cancelled) && "text-faint line-through"
        )}
      >
        {turn.text}
      </Text>
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
      ? withRepeat(withTiming(1.12, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true)
      : withTiming(1, { duration: 250 });
  }, [listening, pulse]);

  const halo = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  return (
    <View className="items-center pb-2 pt-1">
      <Animated.View
        style={halo}
        className={cn(
          "absolute h-[104px] w-[104px] rounded-full",
          listening ? "bg-live/20" : "bg-brass/10"
        )}
      />
      <Pressable
        testID="mic-orb"
        disabled={busy}
        onPressIn={continuous ? undefined : onStart}
        onPressOut={continuous ? undefined : onStop}
        onPress={continuous ? (listening ? onStop : onStart) : undefined}
        className={cn(
          "h-[88px] w-[88px] items-center justify-center rounded-full border-2",
          listening ? "border-live bg-live/15" : "border-brass bg-brass/10",
          busy && "opacity-40"
        )}
      >
        <Mic color={listening ? "#E2574C" : BRASS} size={28} />
      </Pressable>
      <Label className="mt-3">
        {busy ? "Connecting" : listening ? "Listening" : continuous ? "Tap to start" : "Hold to speak"}
      </Label>
    </View>
  );
}
