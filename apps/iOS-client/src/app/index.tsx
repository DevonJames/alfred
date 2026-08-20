/**
 * Bootstrap gate. Reads stored credentials, decides which stage of §12.1 the
 * user is actually at, and probes for the Mac before letting the tabs load —
 * so the app never opens on a Talk screen that can't talk to anything.
 */
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Backdrop, Display, Loading } from "@/components/ui";
import { restoreCloudSession } from "@/lib/cloud-identity";
import { useConnection } from "@/lib/connection";
import { discover } from "@/lib/discovery";
import { KEYS, getItem } from "@/lib/secure-store";

type Destination =
  | "/(onboarding)/claim"
  | "/(onboarding)/discovering"
  | "/(onboarding)/permissions"
  | "/(tabs)/talk";

export default function Bootstrap() {
  const hydrate = useConnection((s) => s.hydrate);
  const [destination, setDestination] = useState<Destination | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await hydrate();
      const { serverId, deviceToken, serverUrl } = useConnection.getState();

      // No claimed Mac yet — the whole app is one QR code away (§7 Screen 3).
      if (!serverId) return finish("/(onboarding)/claim");

      /**
       * The claim belongs to this phone's alfrd.net identity, so the token has
       * to be usable before discovery can ask the control plane anything.
       * Restoring may silently sign the device account back in; if even that
       * fails, the claim is unreachable and re-linking is the honest next step.
       */
      const token = await restoreCloudSession();
      if (!token) return finish("/(onboarding)/claim");
      // A desktop whose build predates PIN pairing has no token to give; the
      // user has already been told that on the pairing screen.
      const deferred = await getItem(KEYS.pairingDeferred);
      if (!deviceToken && !deferred) return finish("/(onboarding)/discovering");

      // Fully set up: confirm a live path before showing the app. A stored URL
      // is only a hint — the Mac may have moved networks since last launch.
      if (serverUrl) {
        try {
          await discover();
        } catch {
          // Offline is a legitimate state (§8.6); the tabs render it honestly.
        }
      }

      const primerSeen = await getItem(KEYS.permissionPrimerSeen);
      finish(primerSeen ? "/(tabs)/talk" : "/(onboarding)/permissions");
    })();

    function finish(next: Destination) {
      if (!cancelled) setDestination(next);
    }
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  if (destination) return <Redirect href={destination} />;

  return (
    <Backdrop>
      <View className="flex-1 items-center justify-center" testID="bootstrap-screen">
        <Animated.View entering={FadeIn.duration(600)} className="items-center">
          <Display className="text-5xl">Alfred</Display>
          <Loading label="Looking for your Mac" />
        </Animated.View>
      </View>
    </Backdrop>
  );
}
