/**
 * Bootstrap gate. Reads stored credentials, decides which stage of §12.1 the
 * user is actually at, and probes for the Mac before letting the tabs load —
 * so the app never opens on a Talk screen that can't talk to anything.
 *
 * Styles here are intentional StyleSheet / inline — not NativeWind className.
 * CssInterop has crashed this gate and can leave className colors unapplied
 * (black text on ink = looks like a blank black screen).
 */
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { restoreCloudSession } from "@/lib/cloud-identity";
import { useConnection } from "@/lib/connection";
import { discover } from "@/lib/discovery";
import { KEYS, getItem } from "@/lib/secure-store";

const INK = "#0A0B0D";
const BONE = "#F4F1EA";
const FAINT = "#8D939E";
const BRASS = "#D8A54A";

type Destination =
  | "/(onboarding)/claim"
  | "/(onboarding)/discovering"
  | "/(onboarding)/permissions"
  | "/(tabs)/talk";

export default function Bootstrap() {
  const hydrate = useConnection((s) => s.hydrate);
  const [label, setLabel] = useState("Looking for your Mac");

  useEffect(() => {
    let cancelled = false;
    let finished = false;

    function finish(next: Destination) {
      if (cancelled || finished) return;
      finished = true;
      setLabel("Opening…");
      console.log("[bootstrap] →", next);
      // Defer one tick so the root navigator is mounted after font/splash settle.
      requestAnimationFrame(() => {
        if (!cancelled) router.replace(next);
      });
    }

    // Never leave the user on ink forever if SecureStore / network hangs.
    const watchdog = setTimeout(() => {
      console.warn("[bootstrap] watchdog — forcing claim");
      finish("/(onboarding)/claim");
    }, 12_000);

    (async () => {
      try {
        await hydrate();
        if (cancelled) return;
        const { serverId, deviceToken, serverUrl } = useConnection.getState();

        if (!serverId) return finish("/(onboarding)/claim");

        const token = await restoreCloudSession();
        if (cancelled) return;
        if (!token) return finish("/(onboarding)/claim");

        const deferred = await getItem(KEYS.pairingDeferred);
        if (!deviceToken && !deferred) return finish("/(onboarding)/discovering");

        if (serverUrl) {
          try {
            await discover();
          } catch {
            // Offline is legitimate; tabs render it.
          }
        }
        if (cancelled) return;

        const primerSeen = await getItem(KEYS.permissionPrimerSeen);
        finish(primerSeen ? "/(tabs)/talk" : "/(onboarding)/permissions");
      } catch (err) {
        console.warn("[bootstrap] failed; sending user to claim", err);
        finish("/(onboarding)/claim");
      } finally {
        clearTimeout(watchdog);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, [hydrate]);

  return (
    <View style={styles.root} testID="bootstrap-screen">
      <Text style={styles.title}>Alfred</Text>
      <ActivityIndicator color={BRASS} size="large" />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: INK,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  title: {
    color: BONE,
    fontSize: 48,
    marginBottom: 24,
    fontWeight: "400",
  },
  label: {
    color: FAINT,
    fontSize: 14,
    marginTop: 16,
    textAlign: "center",
  },
});
