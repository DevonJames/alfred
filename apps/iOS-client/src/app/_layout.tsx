import {
  InstrumentSerif_400Regular,
  InstrumentSerif_400Regular_Italic,
  useFonts,
} from "@expo-google-fonts/instrument-serif";
import { DarkTheme, ThemeProvider } from "@react-navigation/native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { parseClaimPayload } from "@/lib/claim-qr";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { INK } from "@/components/ui";
import { useMirror } from "@/lib/memory-cache";
import { watchForMirrorSync } from "@/lib/mirror-sync";
import { useNoteUpload, watchConnectionForNoteUpload } from "@/lib/note-upload";
import { useOutbox, watchConnectionForFlush } from "@/lib/outbox";

export const unstable_settings = {
  initialRouteName: "index",
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The desktop is the source of truth and may be a relay hop away. Don't
      // hammer it, and don't retry transport failures — desktop-api already
      // handles those by rediscovering the path.
      retry: false,
      staleTime: 15_000,
    },
  },
});

const alfredTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: INK, card: INK, border: "#2E343D", text: "#F4F1EA" },
};

function RootLayoutNav() {
  return (
    <ThemeProvider value={alfredTheme}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: INK } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(onboarding)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="capture" options={{ presentation: "modal" }} />
        <Stack.Screen name="correct" options={{ presentation: "modal" }} />
        <Stack.Screen name="forget" options={{ presentation: "modal" }} />
        <Stack.Screen name="notes/[id]" />
        <Stack.Screen name="notes/record" options={{ presentation: "modal" }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const router = useRouter();
  const [fontsLoaded, fontError] = useFonts({
    InstrumentSerif_400Regular,
    InstrumentSerif_400Regular_Italic,
  });

  // Warm/cold alfred://claim → onboarding claim screen (QR deep link).
  useEffect(() => {
    const go = (url: string | null) => {
      if (!url || !parseClaimPayload(url)) return;
      router.push("/(onboarding)/claim");
    };
    void Linking.getInitialURL().then(go);
    const sub = Linking.addEventListener("url", ({ url }) => go(url));
    return () => sub.remove();
  }, [router]);

  useEffect(() => {
    // Don't hold the splash forever if the font download fails — proceed with
    // system fonts so the user isn't stuck on a black frame.
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  // Absolute fallback: if fonts hang, still show the app after a few seconds.
  useEffect(() => {
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 5_000);
    return () => clearTimeout(t);
  }, []);

  // Captures made while the Mac was unreachable are held on this phone and go
  // up the moment a path appears (§11.3).
  useEffect(() => {
    useOutbox.getState().hydrate().catch(() => {});
    const stopFlush = watchConnectionForFlush();
    useNoteUpload.getState().hydrate().catch(() => {});
    const stopNoteUpload = watchConnectionForNoteUpload();

    // The read copy of memory this phone has been shown, so recall works before
    // — and without — a path to the Mac (§11.3). Watching starts only once the
    // copy is off disk, so the first sync knows what it already holds.
    let stopSync: (() => void) | null = null;
    let torn = false;
    useMirror
      .getState()
      .hydrate()
      .catch(() => {})
      .then(() => {
        if (!torn) stopSync = watchForMirrorSync();
      });

    return () => {
      torn = true;
      stopFlush();
      stopNoteUpload();
      stopSync?.();
    };
  }, []);

  // Always mount the navigator. Waiting on fonts with a blank ink view looked
  // like a hang; Instrument Serif swaps in when ready.
  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: INK }}>
        <KeyboardProvider>
          <StatusBar style="light" />
          <RootLayoutNav />
        </KeyboardProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}
