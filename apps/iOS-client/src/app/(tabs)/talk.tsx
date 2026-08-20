/**
 * Talk (§12.2). Voice-first, text-equal.
 *
 * Everything on this screen is a rendering of desktop state. In voice mode the
 * phone is a microphone and a speaker on a LiveKit room: it runs no STT, no LLM,
 * no TTS, and it never decides that an answer is final — the agent on the Mac
 * does, and says so over the caption channel (§9.1, §9.3).
 */
import { useMutation } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { Keyboard, Radio, Send } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
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

type InputMode = "hold" | "continuous" | "text";

/**
 * Why the Speak control isn't on offer. These are genuinely different problems
 * and deserve different sentences — telling someone to check their Mac when the
 * app itself lacks the audio engine would send them on a pointless errand.
 */
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
  const [inputMode, setInputMode] = useState<InputMode>("hold");
  const [draft, setDraft] = useState("");

  const turns = useSession((s) => s.turns);
  const partial = useSession((s) => s.partial);
  const state = useSession((s) => s.state);
  const sessionError = useSession((s) => s.error);
  const sessionUnavailable = useSession((s) => s.unavailable);
  // Text turns still arrive by polling the desktop's event stream; voice runs
  // beside it on the room, and the two histories stay separate by design.
  useConversationSession(focused);

  const { agentHint } = useVoiceAvailability(focused);
  const blocker = useVoice((s) => s.blocker);
  const phase = useVoice((s) => s.phase);
  const micEnabled = useVoice((s) => s.micEnabled);
  const agentPresent = useVoice((s) => s.agentPresent);
  const voiceError = useVoice((s) => s.error);
  const userPartial = useVoice((s) => s.userPartial);
  const caption = useSpokenCaption();
  const { start, stop, setMic } = useVoiceSession();

  const scroller = useRef<ScrollView>(null);

  const voiceBlocked = blocker !== "none";

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );

  // A room the user has navigated away from is a hot microphone nobody is
  // watching. Leave it the moment Talk loses focus.
  useEffect(() => {
    if (!focused) stop().catch(() => {});
  }, [focused, stop]);

  // Discovering mid-session that voice can't work should move the user, not
  // leave them holding a mic that does nothing.
  useEffect(() => {
    if (voiceBlocked) setInputMode("text");
  }, [voiceBlocked]);

  useEffect(() => {
    const timer = setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [turns.length, partial, caption, userPartial]);

  const sendText = useMutation({
    mutationFn: async (text: string) => sendTurn(text, { source: "text" }),
    onMutate: () => setDraft(""),
  });

  /**
   * Open the mic. The room is joined on first use rather than on arrival, so
   * simply looking at Talk never lights the microphone indicator.
   */
  const openMic = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (phase !== "live") {
      const joined = await start();
      // `start` already publishes the mic, so there's nothing more to enable.
      if (!joined) setInputMode("text");
      return;
    }
    await setMic(true);
  }, [phase, setMic, start]);

  /**
   * Close the mic but stay in the room: Alfred is very likely mid-sentence, and
   * disconnecting here would cut off his own answer.
   */
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
            <Pressable
              testID="toggle-input-mode"
              // Cycling back to a voice mode that can't connect is a dead end.
              disabled={voiceBlocked || sessionUnavailable}
              onPress={() => {
                const next: InputMode =
                  inputMode === "hold" ? "continuous" : inputMode === "continuous" ? "text" : "hold";
                setInputMode(next);
                if (next === "text") stop().catch(() => {});
              }}
              className="flex-row items-center space-x-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 active:opacity-70"
            >
              {inputMode === "text" ? (
                <Keyboard color="#8D939E" size={13} />
              ) : (
                <Radio color="#8D939E" size={13} />
              )}
              <Text className="text-xs text-muted">
                {inputMode === "hold" ? "Hold to talk" : inputMode === "continuous" ? "Hands free" : "Typing"}
              </Text>
            </Pressable>
          </View>

          <ScrollView
            ref={scroller}
            testID="captions-scroll"
            className="mt-4 flex-1"
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

            {/* Live speech, straight off the data channel. Kept separate from
                the typed ledger above — the Mac owns voice history, not us. */}
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

          {/* A feature the Mac hasn't shipped isn't an error the user caused. */}
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
          {/* The Mac can tell us the room is fine but the agent isn't running. */}
          {agentHint && phase === "live" && !agentPresent ? (
            <Notice tone="info" testID="agent-hint">
              {agentHint}
            </Notice>
          ) : null}

          {/* Offering a mic that can only fail is worse than offering nothing. */}
          {sessionUnavailable ? null : inputMode === "text" ? (
            <View className="mt-3 flex-row items-end space-x-2" testID="text-input-row">
              <TextInput
                testID="talk-text-input"
                value={draft}
                onChangeText={setDraft}
                placeholder="Say something to Alfred"
                placeholderTextColor="#5F656F"
                multiline
                className="max-h-32 min-h-[52px] flex-1 rounded-2xl border border-line bg-ink-700 px-4 py-3.5 text-base text-bone"
                onSubmitEditing={() => draft.trim() && sendText.mutate(draft.trim())}
              />
              <Pressable
                testID="send-text"
                disabled={!draft.trim() || sendText.isPending}
                onPress={() => sendText.mutate(draft.trim())}
                className={cn(
                  "h-[52px] w-[52px] items-center justify-center rounded-2xl active:opacity-70",
                  draft.trim() ? "bg-brass" : "bg-ink-600"
                )}
              >
                <Send color={draft.trim() ? "#0A0B0D" : "#5F656F"} size={19} />
              </Pressable>
            </View>
          ) : (
            <MicOrb
              listening={micEnabled}
              busy={connecting}
              continuous={inputMode === "continuous"}
              onStart={() => void openMic()}
              onStop={() => void closeMic()}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}

/** One caption line. Superseded answers are struck through, never deleted (§9.3). */
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
          isUser ? "text-right text-lg leading-6 text-bone" : "font-display text-2xl leading-8 text-bone",
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
          From {turn.memoryIdsUsed.length} thing{turn.memoryIdsUsed.length === 1 ? "" : "s"} I remember
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
    <View className="items-center pb-3 pt-2">
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
        <View
          className={cn("h-5 w-5 rounded-full", listening ? "bg-live" : "bg-brass")}
          style={listening ? undefined : { backgroundColor: BRASS }}
        />
      </Pressable>
      <Label className="mt-3">
        {busy ? "Connecting" : listening ? "Listening" : continuous ? "Tap to start" : "Hold to speak"}
      </Label>
    </View>
  );
}
