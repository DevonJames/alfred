/**
 * Alfred speech waveform for Talk voice mode.
 *
 * Driven by LiveKit's multiband volume processor on the remote agent track
 * when available; otherwise a soft idle/speaking animation so the stage still
 * reads correctly without real FFT.
 */
import { useMultibandTrackVolume } from "@livekit/react-native";
import type { RemoteAudioTrack } from "livekit-client";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Label } from "@/components/ui";
import { cn } from "@/lib/cn";

const BAR_COUNT = 40;
const EXPANDED_FRACTION = 0.33;
const COLLAPSED_FRACTION = 0.1;

export function AgentWaveform({
  track,
  speaking,
  collapsed,
  onToggleCollapsed,
}: {
  track: RemoteAudioTrack | null;
  speaking: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const targetHeight = Math.round(
    windowHeight * (collapsed ? COLLAPSED_FRACTION : EXPANDED_FRACTION)
  );

  const bands = useMultibandTrackVolume(track ?? undefined, {
    bands: BAR_COUNT,
    minFrequency: 100,
    maxFrequency: 8000,
    updateInterval: 40,
  });

  const [tick, setTick] = useState(0);
  const hasLiveBands = bands.length > 0 && bands.some((v) => v > 0.02);

  useEffect(() => {
    if (hasLiveBands) return;
    const id = setInterval(() => setTick((t) => t + 1), 50);
    return () => clearInterval(id);
  }, [hasLiveBands]);

  const height = useSharedValue(targetHeight);
  useEffect(() => {
    height.value = withTiming(targetHeight, { duration: 280, easing: Easing.out(Easing.cubic) });
  }, [height, targetHeight]);

  const heightStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  const levels = hasLiveBands
    ? bands
    : Array.from({ length: BAR_COUNT }, (_, i) => {
        if (!speaking) return 0.06 + (i % 5 === 0 ? 0.04 : 0);
        const t = tick * 0.18;
        return 0.18 + 0.55 * Math.abs(Math.sin(t + i * 0.35));
      });

  return (
    <Animated.View
      testID="agent-waveform"
      style={heightStyle}
      className="relative overflow-hidden rounded-2xl border border-line bg-ink-800"
    >
      <View className="absolute inset-0 flex-row items-center justify-between px-2">
        {levels.map((level, i) => (
          <WaveBar
            key={i}
            level={Math.min(1, Math.max(0.04, level))}
            speaking={speaking || hasLiveBands}
          />
        ))}
      </View>

      <View className="absolute left-3 top-3">
        <Label className="text-faint">{speaking || hasLiveBands ? "Alfred" : "Standby"}</Label>
      </View>

      <Pressable
        testID="toggle-waveform-size"
        onPress={onToggleCollapsed}
        accessibilityLabel={collapsed ? "Expand waveform" : "Shrink waveform"}
        className="absolute right-2 top-2 z-10 h-8 w-8 items-center justify-center rounded-full border border-line bg-ink-700 active:opacity-70"
      >
        {collapsed ? (
          <ChevronDown color="#8D939E" size={16} />
        ) : (
          <ChevronUp color="#8D939E" size={16} />
        )}
      </Pressable>
    </Animated.View>
  );
}

function WaveBar({ level, speaking }: { level: number; speaking: boolean }) {
  const scale = useSharedValue(level);

  useEffect(() => {
    scale.value = withTiming(level, { duration: 60 });
  }, [level, scale]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: Math.max(0.08, scale.value) }],
  }));

  return (
    <Animated.View
      style={style}
      className={cn(
        "mx-[1px] h-[86%] w-[3px] rounded-full",
        speaking ? "bg-brass" : "bg-faint/40"
      )}
    />
  );
}
