/**
 * Alfred speech waveform — driven only by LiveKit native metering on the
 * remote agent TTS track (same idea as the desktop AnalyserNode scope).
 *
 * No caption-tied sine “fake talk” animation. If levels aren’t attached yet,
 * the panel stays near-flat with a status label rather than pretending.
 */
import { useMultibandTrackVolume, useTrackVolume } from "@livekit/react-native";
import type { RemoteAudioTrack } from "livekit-client";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutChangeEvent,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Line, Path as SvgPath } from "react-native-svg";

const BAR_COUNT = 32;
const EXPANDED_FRACTION = 0.32;
const COLLAPSED_FRACTION = 0.12;
const MINT = "#3DFFC4";
const AMBER = "#FFB347";
const INK = "#E8FBFF";
const PANEL = "#0A1220";
const PANEL_BORDER = "rgba(61, 255, 196, 0.28)";

export function AgentWaveform({
  track,
  collapsed,
  onToggleCollapsed,
}: {
  track: RemoteAudioTrack | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const targetHeight = Math.max(
    96,
    Math.round(windowHeight * (collapsed ? COLLAPSED_FRACTION : EXPANDED_FRACTION))
  );

  const [width, setWidth] = useState(Math.max(280, windowWidth - 32));

  // Official hooks do `instanceof Track`, which fails under Metro duplicates.
  // Passing `{ publication: { track } }` uses the fallback path that still works.
  const trackRef = useMemo(
    () => (track ? { publication: { track } } : undefined),
    [track]
  );

  const rawBands = useMultibandTrackVolume(trackRef as never, {
    bands: BAR_COUNT,
    minFrequency: 120,
    maxFrequency: 8000,
    updateInterval: 40,
  });
  const rawVolume = useTrackVolume(trackRef as never);

  const smoothRef = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0));
  const bandsRef = useRef(rawBands);
  const volumeRef = useRef(rawVolume);
  bandsRef.current = rawBands;
  volumeRef.current = rawVolume;

  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: BAR_COUNT }, () => 0));
  const [energy, setEnergy] = useState(0);

  // Drive from rAF + refs. Depending on `rawBands` directly loops because the
  // LiveKit hook returns a new array every render.
  useEffect(() => {
    let frame = 0;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      const bands = bandsRef.current;
      const vol = Number.isFinite(volumeRef.current) ? volumeRef.current : 0;
      const incoming =
        bands.length > 0
          ? Array.from({ length: BAR_COUNT }, (_, i) => {
              const idx = Math.min(
                bands.length - 1,
                Math.floor((i / Math.max(1, BAR_COUNT - 1)) * bands.length)
              );
              const band = bands[idx] ?? 0;
              return Math.min(1, Math.max(band, vol * 0.35));
            })
          : Array.from({ length: BAR_COUNT }, () => Math.min(1, vol));

      const next = incoming.map((target, i) => {
        const prev = smoothRef.current[i] ?? 0;
        return prev * 0.35 + target * 0.65;
      });
      smoothRef.current = next;
      const nextEnergy = next.reduce((a, b) => a + b, 0) / BAR_COUNT;

      setLevels((prev) => {
        if (
          prev.length === next.length &&
          prev.every((v, i) => Math.abs(v - (next[i] ?? 0)) < 0.004)
        ) {
          return prev;
        }
        return next;
      });
      setEnergy((prev) => (Math.abs(prev - nextEnergy) < 0.004 ? prev : nextEnergy));
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
    };
  }, [track]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setWidth(w);
  };

  const live = energy > 0.04;
  const innerH = Math.max(52, targetHeight - 30);
  const mid = innerH / 2;
  const barMax = mid - 4;

  let scope = "";
  let ghost = "";
  for (let i = 0; i < BAR_COUNT; i++) {
    const mag = levels[i] ?? 0;
    const x = (i / Math.max(1, BAR_COUNT - 1)) * width;
    const yTop = mid - mag * barMax;
    const yBot = mid + mag * barMax * 0.85;
    scope += i === 0 ? `M ${x} ${yTop}` : ` L ${x} ${yTop}`;
    ghost += i === 0 ? `M ${x} ${yBot}` : ` L ${x} ${yBot}`;
  }

  const label = !track ? "Standby" : live ? "Alfred // out" : "Linked · quiet";

  return (
    <View
      testID="agent-waveform"
      onLayout={onLayout}
      style={{
        height: targetHeight,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: PANEL_BORDER,
        backgroundColor: PANEL,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          position: "absolute",
          left: 10,
          right: 10,
          top: 28,
          height: innerH,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {levels.map((level, i) => {
          const h = Math.max(live ? 3 : 2, level * barMax);
          return (
            <View
              key={i}
              style={{
                width: 4,
                height: innerH,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View
                style={{
                  width: 4,
                  height: h,
                  marginBottom: 1,
                  borderRadius: 2,
                  backgroundColor: AMBER,
                  opacity: live ? 0.9 : 0.2,
                }}
              />
              <View
                style={{
                  width: 4,
                  height: Math.max(2, h * 0.9),
                  borderRadius: 2,
                  backgroundColor: MINT,
                  opacity: live ? 0.8 : 0.18,
                }}
              />
            </View>
          );
        })}
      </View>

      <Svg
        width={width}
        height={innerH}
        style={{ position: "absolute", left: 0, top: 28 }}
        pointerEvents="none"
      >
        <Line
          x1={0}
          y1={mid}
          x2={width}
          y2={mid}
          stroke="rgba(111, 143, 163, 0.4)"
          strokeWidth={1}
          strokeDasharray="4 6"
        />
        <SvgPath d={ghost} stroke={MINT} strokeWidth={1.6} fill="none" opacity={live ? 0.55 : 0.15} />
        <SvgPath d={scope} stroke={INK} strokeWidth={2.6} fill="none" opacity={live ? 0.95 : 0.3} />
      </Svg>

      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          zIndex: 2,
          paddingHorizontal: 10,
          paddingTop: 6,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text
          style={{
            color: live ? MINT : "#6F8FA3",
            fontSize: 10,
            letterSpacing: 1.6,
            textTransform: "uppercase",
          }}
        >
          {label}
        </Text>
        <Pressable
          testID="toggle-waveform-size"
          onPress={onToggleCollapsed}
          hitSlop={10}
          accessibilityLabel={collapsed ? "Expand waveform" : "Shrink waveform"}
          style={{
            height: 28,
            width: 28,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: MINT,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(10, 18, 32, 0.9)",
          }}
        >
          {collapsed ? <ChevronDown color={MINT} size={14} /> : <ChevronUp color={MINT} size={14} />}
        </Pressable>
      </View>
    </View>
  );
}
