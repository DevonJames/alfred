/**
 * Alfred's shared surface. A private study at night: ink, brass, bone.
 * Restrained on purpose — this is a butler, not a dashboard.
 *
 * Base layout/colors use StyleSheet so screens stay visible even when
 * NativeWind CssInterop fails (className-only flex/text → blank ink frame).
 * className remains for optional NativeWind polish when it works.
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
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { cn } from "@/lib/cn";
import type { Confidence, ConnectionMode } from "@/lib/types";

export const INK = "#0A0B0D";
export const INK_800 = "#111317";
export const INK_700 = "#171A1F";
export const LINE = "#2E343D";
export const BONE = "#F4F1EA";
export const MUTED = "#8D939E";
export const FAINT = "#5F656F";
export const BRASS = "#D8A54A";
export const LIVE = "#E2574C";
export const OK = "#5AA97C";
export const WARN = "#E0A458";

/** Warm vignette that sits behind every screen. */
export function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.backdrop} className="flex-1 bg-ink">
      <LinearGradient
        colors={["#15120C", "#0A0B0D", "#0A0B0D"]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

export function Display({
  children,
  className,
  style,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  style?: TextStyle;
  testID?: string;
}) {
  return (
    <Text
      testID={testID}
      className={cn("font-display text-bone text-4xl leading-[46px]", className)}
      style={[styles.display, style]}
    >
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
      style={styles.label}
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
      style={styles.body}
    >
      {children}
    </Text>
  );
}

export function Card({
  children,
  className,
  style,
  testID,
}: {
  children: React.ReactNode;
  className?: string;
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      className={cn("rounded-2xl border border-line bg-ink-800 p-4", className)}
      style={[styles.card, style]}
    >
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
  const variantStyle =
    variant === "primary" ? styles.btnPrimary : variant === "danger" ? styles.btnDanger : styles.btnGhost;
  const labelStyle =
    variant === "primary"
      ? styles.btnLabelPrimary
      : variant === "danger"
        ? styles.btnLabelDanger
        : styles.btnLabelGhost;

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
      style={[styles.btn, variantStyle, inert ? styles.btnInert : null]}
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
          style={labelStyle}
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
  style,
  testID,
  ...props
}: TextInputProps & { label?: string; testID?: string }) {
  return (
    <View style={styles.fieldWrap} className="space-y-2">
      {label ? <Label>{label}</Label> : null}
      <TextInput
        testID={testID}
        placeholderTextColor={FAINT}
        className={cn(
          "h-14 rounded-2xl border border-line bg-ink-700 px-4 text-base text-bone",
          className
        )}
        style={[styles.field, style]}
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
    <View
      testID={testID}
      className={cn(
        "rounded-xl border px-4 py-3",
        tone === "error" ? "border-live/40 bg-live/10" : "border-line bg-ink-700"
      )}
      style={[styles.notice, tone === "error" ? styles.noticeError : styles.noticeInfo]}
    >
      <Text
        className={cn("text-sm", tone === "error" ? "text-live" : "text-muted")}
        style={tone === "error" ? styles.noticeTextError : styles.noticeTextInfo}
      >
        {children}
      </Text>
    </View>
  );
}

const MODE_COPY: Record<ConnectionMode, { label: string; color: string }> = {
  local: { label: "On your network", color: OK },
  direct: { label: "Direct", color: OK },
  relay: { label: "Via relay", color: WARN },
  offline: { label: "Mac unreachable", color: LIVE },
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
      style={styles.pill}
    >
      {busy ? (
        <ActivityIndicator size="small" color={BRASS} />
      ) : (
        <View style={[styles.pillDot, { backgroundColor: copy.color }]} />
      )}
      <Text style={{ color: busy ? MUTED : copy.color, fontSize: 12 }}>
        {busy ? "Finding your Mac…" : copy.label}
      </Text>
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
    <View testID={testID} style={styles.fromPhone} className="rounded-xl border border-line bg-ink-700 px-3.5 py-2.5">
      <View style={styles.fromPhoneRow} className="flex-row items-start space-x-2">
        <View style={{ paddingTop: 2 }}>
          <Smartphone color={MUTED} size={13} />
        </View>
        <Text style={styles.fromPhoneText} className="flex-1 text-xs leading-5 text-muted">
          {detail}
        </Text>
      </View>
      {children}
    </View>
  );
}

const CONFIDENCE_COPY: Record<Confidence, { label: string; color: string }> = {
  remembered: { label: "Remembered", color: OK },
  likely: { label: "Likely", color: BRASS },
  ambiguous: { label: "Ambiguous", color: WARN },
  inferred: { label: "Inferred", color: MUTED },
  unknown: { label: "Unknown", color: FAINT },
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
      style={[styles.confidence, { borderColor: `${copy.color}55` }]}
    >
      <Text style={{ color: copy.color, fontSize: 12 }}>{copy.label}</Text>
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
      style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}
      className={cn(
        "rounded-full border px-3 py-1.5 active:opacity-70",
        active ? "border-brass bg-brass/15" : "border-line bg-ink-700"
      )}
    >
      <Text style={{ color: active ? BRASS : MUTED, fontSize: 14 }}>{label}</Text>
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
    <View testID={testID} style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDetail}>{detail}</Text>
    </View>
  );
}

export function Loading({ label, testID = "loading-indicator" }: { label?: string; testID?: string }) {
  return (
    <View testID={testID} style={styles.loading} className="items-center py-12">
      <ActivityIndicator color={BRASS} />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
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
        style={styles.sheetScrim}
        className="flex-1 justify-end bg-black/70"
      >
        <Pressable
          testID={testID}
          onPress={(e) => e.stopPropagation()}
          style={styles.sheet}
          className="max-h-[80%] rounded-t-3xl border-t border-line bg-ink-800 px-5 pb-10 pt-3"
        >
          <View style={styles.sheetHandle} className="mb-4 h-1 w-10 self-center rounded-full bg-line" />
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView style={{ marginTop: 16 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: INK,
  },
  display: {
    color: BONE,
    fontSize: 40,
    lineHeight: 46,
  },
  label: {
    color: FAINT,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  body: {
    color: BONE,
    fontSize: 14,
    lineHeight: 22,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: INK_800,
    padding: 16,
  },
  btn: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    paddingHorizontal: 24,
  },
  btnPrimary: {
    backgroundColor: BRASS,
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: INK_700,
  },
  btnDanger: {
    borderWidth: 1,
    borderColor: `${LIVE}66`,
    backgroundColor: `${LIVE}1A`,
  },
  btnInert: {
    opacity: 0.4,
  },
  btnLabelPrimary: {
    color: INK,
    fontSize: 14,
    fontWeight: "600",
  },
  btnLabelGhost: {
    color: BONE,
    fontSize: 14,
    fontWeight: "600",
  },
  btnLabelDanger: {
    color: LIVE,
    fontSize: 14,
    fontWeight: "600",
  },
  fieldWrap: {
    gap: 8,
  },
  field: {
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: INK_700,
    paddingHorizontal: 16,
    fontSize: 14,
    color: BONE,
  },
  notice: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  noticeError: {
    borderColor: `${LIVE}66`,
    backgroundColor: `${LIVE}1A`,
  },
  noticeInfo: {
    borderColor: LINE,
    backgroundColor: INK_700,
  },
  noticeTextError: {
    color: LIVE,
    fontSize: 14,
  },
  noticeTextInfo: {
    color: MUTED,
    fontSize: 14,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: INK_700,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  fromPhone: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: INK_700,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  fromPhoneRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  fromPhoneText: {
    flex: 1,
    color: MUTED,
    fontSize: 12,
    lineHeight: 20,
  },
  confidence: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    borderColor: BRASS,
    backgroundColor: `${BRASS}26`,
  },
  chipIdle: {
    borderColor: LINE,
    backgroundColor: INK_700,
  },
  empty: {
    alignItems: "center",
    paddingHorizontal: 32,
    paddingVertical: 64,
  },
  emptyTitle: {
    color: BONE,
    fontSize: 24,
  },
  emptyDetail: {
    marginTop: 8,
    color: FAINT,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  loading: {
    alignItems: "center",
    paddingVertical: 48,
  },
  loadingLabel: {
    marginTop: 12,
    color: FAINT,
    fontSize: 14,
  },
  sheetScrim: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  sheet: {
    maxHeight: "80%",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: LINE,
    backgroundColor: INK_800,
    paddingHorizontal: 20,
    paddingBottom: 40,
    paddingTop: 12,
  },
  sheetHandle: {
    height: 4,
    width: 40,
    borderRadius: 999,
    backgroundColor: LINE,
    alignSelf: "center",
    marginBottom: 16,
  },
  sheetTitle: {
    color: BONE,
    fontSize: 24,
  },
});
