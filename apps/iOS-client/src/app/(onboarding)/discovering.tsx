/**
 * Discovering (§12.1, §8.4). Runs the LAN → WAN → relay ladder and shows which
 * rung answered, because "connected" without a path is not information.
 */
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Backdrop, Button, Card, Display, Label, Loading, Notice } from "@/components/ui";
import { useConnection } from "@/lib/connection";
import { DiscoveryError, discover } from "@/lib/discovery";

const RUNGS = [
  { key: "lan", title: "On your network", detail: "Fastest. Your phone and Mac on the same Wi-Fi." },
  { key: "wan", title: "Direct over the internet", detail: "If your Mac is reachable from outside." },
  { key: "relay", title: "Through the alfrd.net relay", detail: "Encrypted fallback when nothing else answers." },
];

export default function Discovering() {
  const insets = useSafeAreaInsets();
  const mode = useConnection((s) => s.mode);
  const serverUrl = useConnection((s) => s.serverUrl);

  const run = useMutation({
    mutationFn: discover,
    onSuccess: () => router.replace("/(onboarding)/pair"),
  });

  useEffect(() => {
    run.mutate();
    // Intentionally once on mount; retry is an explicit user action below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failed = run.isError;

  return (
    <Backdrop>
      <View
        testID="discovering-screen"
        className="flex-1 px-6"
        style={{ paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 }}
      >
        <Animated.View entering={FadeInDown.duration(400)}>
          <Label>Step 2 of 3</Label>
          <Display className="mt-3">
            {failed ? "I can't reach your Mac." : "Finding a way through."}
          </Display>
          <Text className="mt-4 text-base leading-[22px] text-muted">
            {failed
              ? "Nothing answered on any path. Make sure the Alfred desktop client is running on your Mac, then try again."
              : "Alfred tries the closest path first and falls back only as far as it must."}
          </Text>
        </Animated.View>

        <View className="mt-10 space-y-3">
          {RUNGS.map((rung, index) => {
            const chosen = !run.isPending && !failed && mode === (rung.key === "wan" ? "direct" : rung.key);
            return (
              <Animated.View key={rung.key} entering={FadeInDown.delay(100 + index * 80)}>
                <Card
                  testID={`rung-${rung.key}`}
                  className={chosen ? "border-brass bg-brass/10" : undefined}
                >
                  <View className="flex-row items-center justify-between">
                    <Text className={chosen ? "text-base text-brass" : "text-base text-bone"}>
                      {rung.title}
                    </Text>
                    {chosen ? <Text className="text-xs text-brass">Connected</Text> : null}
                  </View>
                  <Text className="mt-1 text-xs leading-4 text-faint">{rung.detail}</Text>
                </Card>
              </Animated.View>
            );
          })}
        </View>

        {run.isPending ? <Loading label="Probing each path" /> : null}

        {failed ? (
          <View className="mt-6 space-y-4">
            <Notice testID="discovery-error">
              {run.error instanceof DiscoveryError
                ? run.error.message
                : "Discovery failed. Check that the desktop client is running."}
            </Notice>
            <Button testID="retry-discovery" label="Try again" onPress={() => run.mutate()} />
            <Button
              testID="back-to-claim"
              variant="ghost"
              label="Use a different Mac"
              onPress={() => router.replace("/(onboarding)/claim")}
            />
          </View>
        ) : null}

        <View className="flex-1" />
        {serverUrl && !failed ? (
          <Text testID="chosen-path" className="text-center text-xs text-faint">
            {serverUrl.replace(/^https?:\/\//, "")}
          </Text>
        ) : null}
      </View>
    </Backdrop>
  );
}
