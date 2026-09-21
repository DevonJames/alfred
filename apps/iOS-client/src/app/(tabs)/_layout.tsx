import { Tabs } from "expo-router";
import { Archive, Bot, Mic, MessageSquare, Settings, Sunrise } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { BRASS, INK } from "@/components/ui";
import { isRobotClaimed } from "@/lib/robot-audio";
import { VoiceSessionHost } from "@/lib/voice/use-voice";

export default function TabLayout() {
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    const refresh = () => {
      void isRobotClaimed().then(setClaimed);
    };
    refresh();
    const sub = AppState.addEventListener("change", refresh);
    const timer = setInterval(refresh, 1500);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <VoiceSessionHost />
      <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: BRASS,
        tabBarInactiveTintColor: "#5F656F",
        tabBarStyle: {
          backgroundColor: INK,
          borderTopColor: "#2E343D",
          borderTopWidth: 1,
        },
        tabBarLabelStyle: { fontSize: 11, letterSpacing: 0.4 },
      }}
    >
      <Tabs.Screen
        name="talk"
        options={{
          title: "Talk",
          tabBarIcon: ({ color, size }) => <MessageSquare color={color} size={size ?? 22} />,
        }}
      />
      <Tabs.Screen
        name="memory"
        options={{
          title: "Memory",
          tabBarIcon: ({ color, size }) => <Archive color={color} size={size ?? 22} />,
        }}
      />
      <Tabs.Screen
        name="notes"
        options={{
          title: "Notes",
          tabBarIcon: ({ color, size }) => <Mic color={color} size={size ?? 22} />,
        }}
      />
      <Tabs.Screen
        name="brief"
        options={{
          title: "Brief",
          tabBarIcon: ({ color, size }) => <Sunrise color={color} size={size ?? 22} />,
        }}
      />
      <Tabs.Screen
        name="control"
        options={{
          title: "Bot",
          href: claimed ? undefined : null,
          tabBarIcon: ({ color, size }) => <Bot color={color} size={size ?? 22} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Settings color={color} size={size ?? 22} />,
        }}
      />
      </Tabs>
    </>
  );
}
