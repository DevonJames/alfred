/**
 * PermissionPrimer (§10.1). Ask in context, explain before the system sheet
 * appears, and never block the app on a denial — text input is a full citizen.
 */
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { Bell, Mic } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { Backdrop, BRASS, Button, Card, Display, Label } from "@/components/ui";
import { KEYS, setItem } from "@/lib/secure-store";
import { requestMicPermission } from "@/lib/audio";

type Status = "idle" | "granted" | "denied";

export default function PermissionPrimer() {
  const insets = useSafeAreaInsets();
  const [mic, setMic] = useState<Status>("idle");
  const [notify, setNotify] = useState<Status>("idle");

  const askMic = useMutation({
    mutationFn: requestMicPermission,
    onSuccess: (granted) => setMic(granted ? "granted" : "denied"),
  });

  const askNotifications = useMutation({
    mutationFn: async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      return status === "granted";
    },
    onSuccess: (granted) => setNotify(granted ? "granted" : "denied"),
  });

  const finish = useMutation({
    mutationFn: async () => setItem(KEYS.permissionPrimerSeen, "1"),
    onSuccess: () => router.replace("/(tabs)/talk"),
  });

  return (
    <Backdrop>
      <View
        testID="permission-primer-screen"
        className="flex-1 px-6"
        style={{ paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 }}
      >
        <Animated.View entering={FadeInDown.duration(400)}>
          <Label>Before we begin</Label>
          <Display className="mt-3">Two small permissions.</Display>
          <Text className="mt-4 text-base leading-[22px] text-muted">
            Both are optional. Alfred works entirely by typing if you'd rather not grant them.
          </Text>
        </Animated.View>

        <View className="mt-10 space-y-4">
          <Animated.View entering={FadeInDown.delay(100)}>
            <Card testID="mic-permission-card">
              <View className="flex-row items-start space-x-3">
                <Mic color={BRASS} size={20} />
                <View className="flex-1">
                  <Text className="text-base text-bone">Microphone</Text>
                  <Text className="mt-1 text-sm leading-5 text-faint">
                    So you can speak to Alfred instead of typing. Audio is sent to your Mac, which
                    does the listening — nothing is stored on this phone.
                  </Text>
                </View>
              </View>
              <Button
                testID="grant-mic"
                className="mt-4 h-11"
                variant={mic === "granted" ? "ghost" : "primary"}
                label={
                  mic === "granted" ? "Allowed" : mic === "denied" ? "Denied — you can type" : "Allow microphone"
                }
                disabled={mic !== "idle"}
                loading={askMic.isPending}
                onPress={() => askMic.mutate()}
              />
            </Card>
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(180)}>
            <Card testID="notification-permission-card">
              <View className="flex-row items-start space-x-3">
                <Bell color={BRASS} size={20} />
                <View className="flex-1">
                  <Text className="text-base text-bone">Notifications</Text>
                  <Text className="mt-1 text-sm leading-5 text-faint">
                    So reminders you asked Alfred to keep can reach you at the right moment.
                  </Text>
                </View>
              </View>
              <Button
                testID="grant-notifications"
                className="mt-4 h-11"
                variant={notify === "granted" ? "ghost" : "primary"}
                label={
                  notify === "granted"
                    ? "Allowed"
                    : notify === "denied"
                      ? "Denied — reminders stay in Brief"
                      : "Allow notifications"
                }
                disabled={notify !== "idle"}
                loading={askNotifications.isPending}
                onPress={() => askNotifications.mutate()}
              />
            </Card>
          </Animated.View>
        </View>

        <View className="flex-1" />

        <Button
          testID="finish-onboarding"
          label="Start using Alfred"
          loading={finish.isPending}
          onPress={() => finish.mutate()}
        />
      </View>
    </Backdrop>
  );
}
