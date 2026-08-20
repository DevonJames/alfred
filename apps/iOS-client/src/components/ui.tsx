/**
 * Alfred's shared surface. A private study at night: ink, brass, bone.
 * Restrained on purpose — this is a butler, not a dashboard.
 */
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { Smartphone } from "lucide-react-native";
import React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";
import { cn } from "@/lib/cn";
import type { Confidence, ConnectionMode } from "@/lib/types";

export const INK = "#0A0B0D";
export const BRASS = "#D8A54A";

/** Warm vignette that sits behind every screen. */
export function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-1 bg-ink">
      <LinearGradient
        colors={["#15120C", "#0A0B0D", "#0A0B0D"]}
        locations={[0, 0.45, 1]}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {children}
    </View>
  );
}

export function Display({
  children,
  className,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  testID?: string;
}) {
  return (
    <Text testID={testID} className={cn("font-display text-bone text-4xl leading-[46px]", className)}>
      {children}
    </Text>
  );
}

export function Label({
  children,
  className,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  testID?: string;
}) {
  return (
    <Text
      testID={testID}
      className={cn("text-faint text-xs uppercase", className)}
      style={{ letterSpacing: 1.6 }}
    >
      {children}
    </Text>
  );
}

export function Body({
  children,
  className,
  numberOfLines,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  numberOfLines?: number;
  testID?: string;
}) {
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      className={cn("text-bone text-base leading-[22px]", className)}
    >
      {children}
    </Text>
  );
}

export function Card({
  children,
  className,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  testID?: string;
}) {
  return (
    <View testID={testID} className={cn("rounded-2xl border border-line bg-ink-800 p-4", className)}>
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
  className,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  testID?: string;
}) {
  const inert = disabled || loading;
  return (
    <Pressable
      testID={testID}
      disabled={inert}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      className={cn(
        "h-14 flex-row items-center justify-center rounded-2xl px-6 active:opacity-70",
        variant === "primary" && "bg-brass",
        variant === "ghost" && "border border-line bg-ink-700",
        variant === "danger" && "border border-live/40 bg-live/10",
        inert && "opacity-40",
        className
      )}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? INK : BRASS} />
      ) : (
        <Text
          className={cn(
            "text-base font-semibold",
            variant === "primary" && "text-ink",
            variant === "ghost" && "text-bone",
            variant === "danger" && "text-live"
          )}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  className,
  testID,
  ...props
}: TextInputProps & { label?: string; testID?: string }) {
  return (
    <View className="space-y-2">
      {label ? <Label>{label}</Label> : null}
      <TextInput
        testID={testID}
        placeholderTextColor="#5F656F"
        className={cn(
          "h-14 rounded-2xl border border-line bg-ink-700 px-4 text-base text-bone",
          className
        )}
        {...props}
      />
    </View>
  );
}

/** Non-blocking inline error. Never surfaces token or secret values. */
export function Notice({
  tone = "error",
  children,
  testID,
}: {
  tone?: "error" | "info";
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <Animated.View
      testID={testID}
      entering={FadeInDown.duration(180)}
      exiting={FadeOut}
      className={cn(
        "rounded-xl border px-4 py-3",
        tone === "error" ? "border-live/40 bg-live/10" : "border-line bg-ink-700"
      )}
    >
      <Text className={cn("text-sm", tone === "error" ? "text-live" : "text-muted")}>
        {children}
      </Text>
    </Animated.View>
  );
}

const MODE_COPY: Record<ConnectionMode, { label: string; dot: string; text: string }> = {
  local: { label: "On your network", dot: "bg-ok", text: "text-ok" },
  direct: { label: "Direct", dot: "bg-ok", text: "text-ok" },
  relay: { label: "Via relay", dot: "bg-warn", text: "text-warn" },
  offline: { label: "Mac unreachable", dot: "bg-live", text: "text-live" },
};

/** §8.6: the path is always visible, never guessed at. */
export function ConnectionPill({
  mode,
  busy,
  onPress,
  testID = "connection-pill",
}: {
  mode: ConnectionMode;
  busy?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const copy = MODE_COPY[mode];
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      className="flex-row items-center space-x-2 self-start rounded-full border border-line bg-ink-700 px-3 py-1.5 active:opacity-70"
    >
      {busy ? (
        <ActivityIndicator size="small" color={BRASS} />
      ) : (
        <View className={cn("h-1.5 w-1.5 rounded-full", copy.dot)} />
      )}
      <Text className={cn("text-xs", copy.text)}>{busy ? "Finding your Mac…" : copy.label}</Text>
    </Pressable>
  );
}

/**
 * §11.3: an answer read off this phone's copy is never dressed up as a live one.
 * Wherever cached records are shown, this line says so and says how old it is.
 */
export function FromPhone({
  detail,
  children,
  testID = "from-phone",
}: {
  detail: string;
  children?: React.ReactNode;
  testID?: string;
}) {
  return (
    <Animated.View
      testID={testID}
      entering={FadeIn.duration(180)}
      className="rounded-xl border border-line bg-ink-700 px-3.5 py-2.5"
    >
      <View className="flex-row items-start space-x-2">
        <View className="pt-0.5">
          <Smartphone color="#8D939E" size={13} />
        </View>
        <Text className="flex-1 text-xs leading-5 text-muted">{detail}</Text>
      </View>
      {children}
    </Animated.View>
  );
}

const CONFIDENCE_COPY: Record<Confidence, { label: string; className: string }> = {
  remembered: { label: "Remembered", className: "text-ok border-ok/30" },
  likely: { label: "Likely", className: "text-brass border-brass/30" },
  ambiguous: { label: "Ambiguous", className: "text-warn border-warn/30" },
  inferred: { label: "Inferred", className: "text-muted border-line" },
  unknown: { label: "Unknown", className: "text-faint border-line" },
};

/**
 * §11.1.4: confidence is stated, not implied. An inferred claim must never read
 * like a remembered one.
 */
export function ConfidenceTag({ value, testID }: { value: Confidence; testID?: string }) {
  const copy = CONFIDENCE_COPY[value] ?? CONFIDENCE_COPY.unknown;
  return (
    <View
      testID={testID ?? `confidence-${value}`}
      className={cn("self-start rounded-full border px-2 py-0.5", copy.className)}
    >
      <Text className={cn("text-xs", copy.className.split(" ")[0])}>{copy.label}</Text>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      className={cn(
        "rounded-full border px-3 py-1.5 active:opacity-70",
        active ? "border-brass bg-brass/15" : "border-line bg-ink-700"
      )}
    >
      <Text className={cn("text-sm", active ? "text-brass" : "text-muted")}>{label}</Text>
    </Pressable>
  );
}

export function Empty({
  title,
  detail,
  testID,
}: {
  title: string;
  detail: string;
  testID?: string;
}) {
  return (
    <Animated.View entering={FadeIn} testID={testID} className="items-center px-8 py-16">
      <Text className="font-display text-2xl text-bone">{title}</Text>
      <Text className="mt-2 text-center text-sm leading-5 text-faint">{detail}</Text>
    </Animated.View>
  );
}

export function Loading({ label, testID = "loading-indicator" }: { label?: string; testID?: string }) {
  return (
    <View testID={testID} className="items-center py-12">
      <ActivityIndicator color={BRASS} />
      {label ? <Text className="mt-3 text-sm text-faint">{label}</Text> : null}
    </View>
  );
}

/** Custom sheet — Alert.alert has no place in this palette. */
export function Sheet({
  visible,
  title,
  children,
  onClose,
  testID,
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  testID?: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        testID={`${testID}-scrim`}
        onPress={onClose}
        className="flex-1 justify-end bg-black/70"
      >
        <Pressable
          testID={testID}
          onPress={(e) => e.stopPropagation()}
          className="max-h-[80%] rounded-t-3xl border-t border-line bg-ink-800 px-5 pb-10 pt-3"
        >
          <View className="mb-4 h-1 w-10 self-center rounded-full bg-line" />
          <Text className="font-display text-2xl text-bone">{title}</Text>
          <ScrollView className="mt-4" keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
