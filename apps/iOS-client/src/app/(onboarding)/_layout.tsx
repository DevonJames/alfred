import { Stack } from "expo-router";
import { INK } from "@/components/ui";

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: INK },
        // The funnel is linear; a swipe back into a stale step would strand
        // the user between "claimed" and "paired".
        gestureEnabled: false,
      }}
    />
  );
}
