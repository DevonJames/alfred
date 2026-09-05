/**
 * "Let's find your Mac".
 *
 * Point the phone at the claim QR on the Mac, or type the Desktop Client ID
 * and eight-character secret. No alfrd.net account — linking proves the secret
 * and stores a scoped relay token.
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
import { ApiError, linkDesktop } from "@/lib/cloud-api";
import {
  isCompleteSecret,
  isUuid,
  normalizeSecret,
  parseClaimPayload,
  suspectCharacters,
  type ClaimPayload,
} from "@/lib/claim-qr";
import { useConnection } from "@/lib/connection";
import { fetchDesktopInfo } from "@/lib/desktop-api";

/** Accept "192.168.1.24:3000", "mac.local" or a full URL. */
function normalizeAddress(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return /:\d+$/.test(withScheme) ? withScheme : `${withScheme}:3000`;
}

function claimMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Could not link that Mac.";
  if (error.status === 0) return "I couldn't reach alfrd.net. Check this phone's connection.";
  if (error.status === 404) {
    return "No Mac is registered with that ID right now. Make sure Alfred is running on your Mac, then try again.";
  }
  if (error.status === 401) return "That secret doesn't match the one your Mac is showing.";
  return error.message;
}

export default function FindYourMac() {
  const insets = useSafeAreaInsets();
  const setServer = useConnection((s) => s.setServer);
  const setCloudSession = useConnection((s) => s.setCloudSession);

  const [mode, setMode] = useState<"scan" | "manual">("manual");
  const [serverId, setServerId] = useState("");
  const [secret, setSecret] = useState("");
  const [address, setAddress] = useState("");
  const [pasted, setPasted] = useState("");
  const [foundName, setFoundName] = useState<string | null>(null);
  /** One scan per screen: the camera fires this callback many times a second. */
  const handled = useRef(false);

  const claim = useMutation({
    mutationFn: async (input: ClaimPayload) => {
      const result = await linkDesktop(input.serverId, input.claimSecret);
      await setCloudSession(result.token);
      await setServer(result.serverId);
      return result;
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(onboarding)/discovering");
    },
    onError: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      handled.current = false;
    },
  });

  // If the Mac is on this Wi-Fi it can hand over both values itself, which
  // beats reading a UUID off a terminal.
  const lookup = useMutation({
    mutationFn: () => fetchDesktopInfo(normalizeAddress(address)),
    onSuccess: (info) => {
      setServerId(info.desktopClientId);
      if (info.claimSecret) setSecret(normalizeSecret(info.claimSecret));
      setFoundName(info.desktopClientName);
    },
  });

  const { mutate: runClaim, isPending: claiming } = claim;
  const accept = useCallback(
    (payload: ClaimPayload) => {
      if (handled.current || claiming) return;
      handled.current = true;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setServerId(payload.serverId);
      setSecret(payload.claimSecret);
      setFoundName(payload.name ?? null);
      runClaim(payload);
    },
    [runClaim, claiming]
  );

  // Deep links: the iOS Camera app or Safari can hand the desktop's QR straight
  // to the app, cold start included.
  const incoming = Linking.useURL();
  useEffect(() => {
    if (!incoming) return;
    const payload = parseClaimPayload(incoming);
    if (payload) accept(payload);
  }, [incoming, accept]);

  const suspect = suspectCharacters(secret);
  const canSubmit = isUuid(serverId) && isCompleteSecret(secret);

  return (
    <Backdrop>
      <KeyboardAwareScrollView
        testID="find-mac-screen"
        contentContainerStyle={{
          paddingTop: insets.top + 56,
          paddingBottom: insets.bottom + 48,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <View>
          <Label>Step 1 of 3</Label>
          <Display style={{ marginTop: 12 }}>Let's find your Mac.</Display>
          <Text
            style={{
              marginTop: 16,
              fontSize: 16,
              lineHeight: 22,
              color: "#8D939E",
            }}
          >
            Alfred is running on your Mac and showing a code. Scan it, or type the eight characters
            underneath it. Your memory never leaves that machine — this only tells the phone where
            to knock.
          </Text>
        </View>

        {claim.isPending ? (
          <View className="mt-8">
            <Card testID="claiming-card" className="items-center py-8">
              <Loading label={foundName ? `Linking to ${foundName}` : "Linking this phone"} />
            </Card>
          </View>
        ) : mode === "scan" ? (
          <View className="mt-8">
            <Scanner
              onScan={(data) => {
                const payload = parseClaimPayload(data);
                if (payload) accept(payload);
              }}
              onGiveUp={() => setMode("manual")}
            />
          </View>
        ) : (
          <View className="mt-8 space-y-4">
            <Field
              testID="claim-secret-input"
              label="Claim secret"
              value={secret}
              onChangeText={(t) => setSecret(normalizeSecret(t))}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              maxLength={8}
              placeholder="8 characters"
              className="text-center text-xl"
              style={{ letterSpacing: 8 }}
            />
            {suspect.length > 0 ? (
              <Text testID="secret-suspect" className="text-xs leading-5 text-warn">
                Alfred never prints {suspect.join(", ")} — those look like a misread of a similar
                character.
              </Text>
            ) : null}

            <Field
              testID="server-id-input"
              label="Desktop Client ID"
              value={serverId}
              onChangeText={setServerId}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="4b21f0c8-…"
            />
            <Text className="text-xs leading-5 text-faint">
              Both are on your Mac: in the Alfred window, in the terminal where it started, or at
              127.0.0.1:3000/connect/claim.
            </Text>

            <Card>
              <Label>Got the link instead?</Label>
              <Text className="mt-2 text-sm leading-5 text-faint">
                Paste anything starting with alfred://claim — from the Alfred window, or the page at
                /connect/claim.
              </Text>
              <View className="mt-3">
                <Field
                  testID="claim-link-input"
                  value={pasted}
                  onChangeText={(text) => {
                    setPasted(text);
                    // Parsing as it lands means a paste needs no second tap.
                    const payload = parseClaimPayload(text);
                    if (payload) accept(payload);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="alfred://claim?…"
                />
              </View>
              {pasted.trim().length > 12 && !parseClaimPayload(pasted) ? (
                <Text testID="paste-error" className="mt-3 text-sm text-warn">
                  That isn't an Alfred claim link.
                </Text>
              ) : null}
            </Card>

            <Card>
              <Label>On the same Wi-Fi?</Label>
              <Text className="mt-2 text-sm leading-5 text-faint">
                Type your Mac's address and I'll read both values off it myself.
              </Text>
              <View className="mt-3">
                <Field
                  testID="desktop-address-input"
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.24:3000"
                />
              </View>
              <Button
                testID="lookup-desktop"
                className="mt-3 h-11"
                variant="ghost"
                label="Look it up"
                disabled={address.trim().length < 4}
                loading={lookup.isPending}
                onPress={() => lookup.mutate()}
              />
              {foundName && !claim.isError ? (
                <Text testID="lookup-found" className="mt-3 text-sm text-ok">
                  Found {foundName}. Filled in above.
                </Text>
              ) : null}
              {lookup.isError ? (
                <Text testID="lookup-error" className="mt-3 text-sm text-warn">
                  {lookup.error instanceof ApiError
                    ? lookup.error.message
                    : "Nothing answered at that address."}
                </Text>
              ) : null}
            </Card>

            <Button
              testID="claim-submit"
              label="Link this Mac"
              disabled={!canSubmit}
              onPress={() => accept({ serverId: serverId.trim(), claimSecret: secret })}
            />
          </View>
        )}

        {claim.isError ? (
          <View className="mt-6 space-y-3">
            <Notice testID="claim-error">{claimMessage(claim.error)}</Notice>
          </View>
        ) : null}

        {!claim.isPending ? (
          <Pressable
            testID="toggle-claim-mode"
            onPress={() => {
              handled.current = false;
              claim.reset();
              setMode(mode === "scan" ? "manual" : "scan");
            }}
            className="items-center py-5 active:opacity-60"
          >
            <Text className="text-sm text-brass">
              {mode === "scan" ? "Type the code instead" : "Scan the code instead"}
            </Text>
          </Pressable>
        ) : null}
      </KeyboardAwareScrollView>
    </Backdrop>
  );
}

/**
 * The viewfinder.
 *
 * Permission is asked for as the screen appears rather than behind a button:
 * this screen has exactly one job, and a card saying "tap to allow the camera"
 * before the card saying "allow the camera" is a tap that buys nothing. If the
 * ask is refused, or the camera can't run here at all, the explanation and the
 * way past it are both on screen.
 */
function Scanner({ onScan, onGiveUp }: { onScan: (data: string) => void; onGiveUp: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [rejected, setRejected] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  /**
   * State, not a ref: a browser that refuses the camera outright rejects the
   * request and never changes `permission`, and a ref wouldn't re-render — the
   * user would sit under a spinner that resolves to nothing.
   */
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!permission || permission.granted || asked) return;
    setAsked(true);
    if (permission.canAskAgain) {
      requestPermission().catch(() =>
        setBroken("This device won't let Alfred open the camera, so scanning won't work here.")
      );
    }
  }, [permission, asked, requestPermission]);

  if (!permission || (!permission.granted && !asked)) {
    return (
      <Card testID="camera-starting-card" className="items-center py-10">
        <Loading label="Starting the camera" />
      </Card>
    );
  }

  if (!permission.granted || broken) {
    return (
      <Card testID="camera-permission-card">
        <Text className="text-base leading-6 text-bone">
          {broken ?? "Alfred needs the camera to read the code on your Mac."}
        </Text>
        <Text className="mt-2 text-sm leading-5 text-faint">
          Nothing is recorded. The camera reads the code and closes.
        </Text>
        {!broken ? (
          <Button
            testID="grant-camera"
            className="mt-4"
            label={permission.canAskAgain ? "Allow camera" : "Open Settings"}
            onPress={() =>
              permission.canAskAgain ? requestPermission() : Linking.openSettings()
            }
          />
        ) : null}
        <Button
          testID="camera-give-up"
          className="mt-3"
          variant="ghost"
          label="Type the code instead"
          onPress={onGiveUp}
        />
      </Card>
    );
  }

  return (
    <View>
      <View
        testID="qr-scanner"
        className="overflow-hidden rounded-3xl border border-line bg-ink-800"
        style={{ aspectRatio: 1 }}
      >
        <CameraView
          // Children of CameraView are unsupported and render inconsistently;
          // the framing square is a sibling laid over the top instead.
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          // A camera that failed to start silently would leave the user
          // pointing a dead rectangle at their Mac.
          onMountError={() =>
            setBroken("This device's camera isn't available, so scanning won't work here.")
          }
          onBarcodeScanned={({ data }) => {
            if (!data) return;
            // Any other QR in frame is noise; say so once rather than silently
            // doing nothing while the user keeps pointing at it.
            if (!parseClaimPayload(data)) {
              setRejected(true);
              return;
            }
            setRejected(false);
            onScan(data);
          }}
        />
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          className="items-center justify-center"
        >
          <View className="h-56 w-56 rounded-2xl border-2 border-brass/70" />
        </View>
      </View>
      <Text className="mt-4 text-center text-sm leading-5 text-faint">
        {rejected
          ? "That code isn't from Alfred. Look for the one in the Alfred window on your Mac."
          : "Point this at the code in the Alfred window on your Mac."}
      </Text>
    </View>
  );
}
