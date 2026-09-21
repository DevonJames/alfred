/**
 * Claim AlfredBot: scan the QR on the robot glass, then type the Mac PIN here.
 * The robot camera stays off.
 */
import { useMutation } from "@tanstack/react-query";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Backdrop, Button, Card, Display, Field, Label, Loading, Notice } from "@/components/ui";
import { parseBotPayload, type BotClaimPayload } from "@/lib/bot-qr";
import { useConnection } from "@/lib/connection";
import { confirmPairing, requestPairing } from "@/lib/desktop-api";
import { setRobotAudioEnabled, setRobotHost, setRobotTalkEnabled } from "@/lib/robot-audio";
import { botConnectionType, provisionRobot, provisionRobotPair, reachBot, RobotApiError } from "@/lib/robot-api";

export default function ClaimAlfredBot() {
  const insets = useSafeAreaInsets();
  const cloudToken = useConnection((s) => s.cloudToken);
  const serverId = useConnection((s) => s.serverId);
  const serverUrl = useConnection((s) => s.serverUrl);
  const mode = useConnection((s) => s.mode);
  const linked = Boolean(cloudToken && serverId && serverUrl);

  const [phase, setPhase] = useState<"scan" | "pin" | "done">("scan");
  const [bot, setBot] = useState<BotClaimPayload | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [devPin, setDevPin] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [remaining, setRemaining] = useState(0);
  const handled = useRef(false);

  useEffect(() => {
    if (!deviceId || remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [deviceId, remaining]);

  const start = useMutation({
    mutationFn: async (payload: BotClaimPayload) => {
      if (!cloudToken || !serverId || !serverUrl) {
        throw new RobotApiError("Link this phone to a Mac first, then scan AlfredBot.");
      }
      const reached = await reachBot(payload);
      await provisionRobot(reached, {
        session: payload.session,
        cloudToken,
        cloudServerId: serverId,
        serverUrl,
        connectionType: botConnectionType(mode),
      });
      const pending = await requestPairing(serverUrl, payload.name ?? "AlfredBot", cloudToken, "1.0.0", "robot");
      return { reached, pending };
    },
    onSuccess: ({ reached, pending }, payload) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setBot(payload);
      setHost(reached);
      setDeviceId(pending.deviceId);
      setRemaining(pending.expiresInSeconds);
      setDevPin(pending.devPin ?? null);
      setPhase("pin");
    },
    onError: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      handled.current = false;
    },
  });

  const confirm = useMutation({
    mutationFn: async () => {
      if (!serverUrl || !deviceId || !host || !bot || !cloudToken) {
        throw new RobotApiError("Scan AlfredBot again.");
      }
      const paired = await confirmPairing(serverUrl, deviceId, pin, cloudToken);
      await provisionRobotPair(host, {
        session: bot.session,
        deviceToken: paired.deviceToken,
        deviceId: paired.deviceId,
        desktopName: paired.serverName,
      });
      return paired;
    },
    onSuccess: async () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await setRobotTalkEnabled(true);
      await setRobotAudioEnabled(true);
      if (host) await setRobotHost(host);
      setPhase("done");
    },
  });

  const accept = useCallback(
    (raw: string) => {
      if (handled.current || start.isPending) return;
      const payload = parseBotPayload(raw);
      if (!payload) return;
      handled.current = true;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      start.mutate(payload);
    },
    [start]
  );

  const incoming = Linking.useURL();
  useEffect(() => {
    if (incoming && parseBotPayload(incoming)) accept(incoming);
  }, [incoming, accept]);

  return (
    <Backdrop>
      <KeyboardAwareScrollView
        testID="claim-bot-screen"
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <Pressable onPress={() => router.back()} testID="claim-bot-close">
          <Text className="text-sm text-brass">Close</Text>
        </Pressable>
        <Label className="mt-6">AlfredBot</Label>
        <Display className="mt-3">
          {phase === "done" ? "Robot is linked" : phase === "pin" ? "Type the Mac PIN" : "Claim AlfredBot"}
        </Display>
        <Text className="mt-4 text-base leading-[22px] text-muted">
          {phase === "done"
            ? `${bot?.name ?? "AlfredBot"} is paired to this Mac. Talk on this iPhone is now his microphone and speaker — you can change that in Settings.`
            : phase === "pin"
              ? "Your Mac is showing a six-digit PIN for the robot. Type it here — not on the robot glass."
              : "Point this camera at the code on the robot screen. Stay on the same Wi-Fi."}
        </Text>

        {!linked ? (
          <View className="mt-8">
            <Notice testID="claim-bot-need-mac">
              This phone isn't linked to a Mac yet. Scan the Mac's claim code first, then come back.
            </Notice>
          </View>
        ) : null}

        {phase === "scan" && linked ? (
          <View className="mt-8">
            {start.isPending ? (
              <Card className="items-center py-8">
                <Loading label="Talking to AlfredBot" />
              </Card>
            ) : (
              <BotScanner onScan={accept} />
            )}
            {start.isError ? (
              <View className="mt-4">
                <Notice testID="claim-bot-scan-error">
                  {start.error instanceof RobotApiError
                    ? start.error.message
                    : start.error instanceof Error
                      ? start.error.message
                      : "Couldn't claim that robot."}
                </Notice>
              </View>
            ) : null}
          </View>
        ) : null}

        {phase === "pin" ? (
          <View className="mt-8 space-y-4">
            {devPin ? (
              <Notice tone="info">This preview PIN is {devPin}.</Notice>
            ) : null}
            <Field
              testID="claim-bot-pin"
              label="PIN from your Mac"
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              placeholder="000000"
              maxLength={6}
              style={{ letterSpacing: 10, fontSize: 22 }}
            />
            {confirm.isError ? (
              <Notice testID="claim-bot-pin-error">
                {confirm.error instanceof Error ? confirm.error.message : "That PIN didn't match."}
              </Notice>
            ) : null}
            <Button
              testID="claim-bot-confirm"
              label="Pair AlfredBot"
              disabled={pin.length < 6}
              loading={confirm.isPending}
              onPress={() => confirm.mutate()}
            />
          </View>
        ) : null}

        {phase === "done" ? (
          <Button className="mt-10" label="Done" onPress={() => router.back()} />
        ) : null}
      </KeyboardAwareScrollView>
    </Backdrop>
  );
}

function BotScanner({ onScan }: { onScan: (data: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [rejected, setRejected] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!permission || permission.granted || asked) return;
    setAsked(true);
    if (permission.canAskAgain) {
      requestPermission().catch(() =>
        setBroken("This phone won't let Alfred open the camera, so scanning won't work here.")
      );
    }
  }, [permission, asked, requestPermission]);

  if (!permission || (!permission.granted && !asked)) {
    return (
      <Card className="items-center py-10">
        <Loading label="Starting the camera" />
      </Card>
    );
  }

  if (!permission.granted || broken) {
    return (
      <Card>
        <Text className="text-base leading-6 text-bone">
          {broken ?? "Alfred needs the camera to read the code on AlfredBot."}
        </Text>
        <Button
          className="mt-4"
          label={permission.canAskAgain ? "Allow camera" : "Open Settings"}
          onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
        />
      </Card>
    );
  }

  return (
    <View>
      <View
        testID="bot-qr-scanner"
        className="overflow-hidden rounded-3xl border border-line bg-ink-800"
        style={{ aspectRatio: 1 }}
      >
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onMountError={() => setBroken("This phone's camera isn't available.")}
          onBarcodeScanned={({ data }) => {
            if (!data) return;
            if (!parseBotPayload(data)) {
              setRejected(true);
              return;
            }
            setRejected(false);
            onScan(data);
          }}
        />
        <View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
          <View className="h-56 w-56 rounded-2xl border-2 border-brass/70" />
        </View>
      </View>
      <Text className="mt-4 text-center text-sm leading-5 text-faint">
        {rejected
          ? "That code isn't from AlfredBot. Look for the amber square on the robot screen."
          : "Point this at the amber code on the robot."}
      </Text>
    </View>
  );
}
