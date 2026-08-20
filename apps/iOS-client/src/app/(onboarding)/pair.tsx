/**
 * PairDevice (§12.1, H1). The desktop shows a PIN; the user types it back.
 * That round trip is what proves physical access to the Mac before any device
 * bearer is minted for this phone.
 */
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Device from "expo-device";
import { Backdrop, Button, Display, Field, Label, Notice } from "@/components/ui";
import { ApiError } from "@/lib/cloud-api";
import { useConnection } from "@/lib/connection";
import { confirmPairing, isNotBuiltYet, requestPairing } from "@/lib/desktop-api";
import { KEYS, setItem } from "@/lib/secure-store";

export default function PairDevice() {
  const insets = useSafeAreaInsets();
  const serverUrl = useConnection((s) => s.serverUrl);
  const cloudToken = useConnection((s) => s.cloudToken);
  const setDevice = useConnection((s) => s.setDevice);

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [devPin, setDevPin] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  /** Seconds left on the PIN the Mac is showing (§6.2 — it lives 300s). */
  const [remaining, setRemaining] = useState(0);

  const start = useMutation({
    mutationFn: async () => {
      const name = Device.deviceName ?? "iPhone";
      return requestPairing(serverUrl!, name, cloudToken);
    },
    onSuccess: (result) => {
      setDeviceId(result.deviceId);
      setRemaining(result.expiresInSeconds);
      // Sandbox affordance only — a real desktop host never returns the PIN.
      setDevPin(result.devPin ?? null);
    },
  });

  // Expiry is the desktop's call, not ours; this only stops the user typing
  // into a PIN the Mac has already thrown away.
  useEffect(() => {
    if (!deviceId || remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [deviceId, remaining]);

  const expired = Boolean(deviceId) && remaining <= 0;

  const confirm = useMutation({
    mutationFn: async () => {
      const result = await confirmPairing(serverUrl!, deviceId!, pin, cloudToken);
      await setDevice(result.deviceId, result.deviceToken, result.profileId);
      return result;
    },
    onSuccess: () => router.replace("/(onboarding)/permissions"),
  });

  /**
   * PIN pairing is a stated follow-on in the desktop client's connectivity
   * pass. When the Mac doesn't offer it, the honest thing is to say so and let
   * the user through on the connection alone, rather than inventing a token.
   */
  const notBuiltYet = isNotBuiltYet(start.error);

  const continueUnpaired = useMutation({
    mutationFn: async () => setItem(KEYS.pairingDeferred, "1"),
    onSuccess: () => router.replace("/(onboarding)/permissions"),
  });

  return (
    <Backdrop>
      <KeyboardAwareScrollView
        testID="pair-device-screen"
        contentContainerStyle={{
          paddingTop: insets.top + 64,
          paddingBottom: 48,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <Animated.View entering={FadeInDown.duration(400)}>
          <Label>Step 3 of 3</Label>
          <Display className="mt-3">Pair this phone</Display>
          <Text className="mt-4 text-base leading-[22px] text-muted">
            Your Mac will show a six-digit PIN. Typing it here proves you're standing in front of
            the machine that holds your memory.
          </Text>
        </Animated.View>

        {!deviceId ? (
          <Animated.View entering={FadeInDown.delay(120)} className="mt-10 space-y-4">
            {notBuiltYet ? (
              <Notice tone="info" testID="pairing-unavailable">
                This Mac's Alfred build doesn't ask for a PIN yet — pairing arrives with local auth
                on the desktop. Until then this phone talks to it over the connection you just
                established, which only your account can open.
              </Notice>
            ) : start.isError ? (
              <Notice testID="pair-request-error">
                {start.error instanceof ApiError
                  ? start.error.message
                  : "Couldn't ask your Mac to pair."}
              </Notice>
            ) : null}
            {notBuiltYet ? (
              <Button
                testID="continue-unpaired"
                label="Continue"
                loading={continueUnpaired.isPending}
                onPress={() => continueUnpaired.mutate()}
              />
            ) : (
              <Button
                testID="request-pairing"
                label="Ask my Mac for a PIN"
                loading={start.isPending}
                onPress={() => start.mutate()}
              />
            )}
          </Animated.View>
        ) : (
          <Animated.View entering={FadeInDown} className="mt-10 space-y-4">
            {devPin ? (
              <Notice tone="info" testID="dev-pin-hint">
                This preview has no Mac terminal to read, so the PIN is {devPin}. On a real desktop
                it appears only on the Mac.
              </Notice>
            ) : null}

            <Field
              testID="pin-input"
              label="PIN from your Mac"
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              placeholder="000000"
              maxLength={6}
              editable={!expired}
              style={{ letterSpacing: 10, fontSize: 22 }}
            />

            <Text
              testID="pin-countdown"
              className={expired ? "text-sm text-warn" : "text-sm text-faint"}
            >
              {expired
                ? "That PIN has expired. Ask your Mac for a new one."
                : `This PIN works for another ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}.`}
            </Text>

            {confirm.isError ? (
              <Notice testID="pair-confirm-error">
                {confirm.error instanceof ApiError
                  ? confirm.error.message
                  : "That PIN didn't match."}
              </Notice>
            ) : null}

            <Button
              testID="confirm-pairing"
              label="Pair"
              disabled={pin.length < 6 || expired}
              loading={confirm.isPending}
              onPress={() => confirm.mutate()}
            />
            <Button
              testID="restart-pairing"
              variant="ghost"
              label="Get a new PIN"
              onPress={() => {
                setDeviceId(null);
                setPin("");
                confirm.reset();
                start.reset();
              }}
            />
          </Animated.View>
        )}

        <View className="mt-12">
          <Text className="text-xs leading-5 text-faint">
            Pairing grants this phone permission to talk to Alfred and read and write your memory.
            You can revoke it from Settings, or from the Mac, at any time.
          </Text>
        </View>
      </KeyboardAwareScrollView>
    </Backdrop>
  );
}
