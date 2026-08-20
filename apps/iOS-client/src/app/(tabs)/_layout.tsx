import { Tabs } from "expo-router";
import { Archive, MessageSquare, Settings, Sunrise } from "lucide-react-native";
import { BRASS, INK } from "@/components/ui";

export default function TabLayout() {
  return (
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
        name="brief"
        options={{
          title: "Brief",
          tabBarIcon: ({ color, size }) => <Sunrise color={color} size={size ?? 22} />,
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
  );
}
