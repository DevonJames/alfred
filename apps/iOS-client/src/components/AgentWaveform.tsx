/**
 * Live Alfred waveform — port of apps/voice-client LiveWaveform for React Native.
 *
 * Desktop uses Web Audio AnalyserNode (time-domain scope + FFT bars). Here we
 * drive the same visual recipe from LiveKit's native multiband + track volume
 * processors on the remote agent TTS track, drawn with Skia.
 */
import { useMultibandTrackVolume, useTrackVolume } from "@livekit/react-native";
import type { RemoteAudioTrack } from "livekit-client";
import {
  Canvas,
  DashPathEffect,
  Line,
  LinearGradient,
  Path,
  Rect,
  Skia,
  vec,
} from "@shopify/react-native-skia";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, Text, View } from "react-native";
import { useWindowDimensions } from "react-native";

const BAR_COUNT = 48;
const SCOPE_POINTS = 96;
const EXPANDED_FRACTION = 0.26;
const COLLAPSED_FRACTION = 0.1;
const MINT = "rgb(61, 255, 196)";
const AMBER = "rgb(255, 179, 71)";
const INK = "rgb(215, 246, 255)";
const MUTED = "rgba(111, 143, 163, 0.45)";
const PANEL = "#0A1220";
const PANEL_BORDER = "rgba(61, 255, 196, 0.22)";

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
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const targetHeight = Math.max(
    64,
    Math.round(windowHeight * (collapsed ? COLLAPSED_FRACTION : EXPANDED_FRACTION))
  );

  const [size, setSize] = useState({ w: Math.max(280, windowWidth - 40), h: targetHeight });

  const bands = useMultibandTrackVolume(track ?? undefined, {
    bands: BAR_COUNT,
    minFrequency: 80,
    maxFrequency: 8000,
    updateInterval: 32,
  });
  const volume = useTrackVolume(track ?? undefined);

  const historyRef = useRef<number[]>(Array.from({ length: SCOPE_POINTS }, () => 0));
  const smoothedRef = useRef(0);
  const phaseRef = useRef(0);
  const [, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      const live = Number.isFinite(volume) ? volume : 0;
      const bandEnergy =
        bands.length > 0 ? bands.reduce((a, b) => a + b, 0) / bands.length : 0;
      // Prefer real track energy; while captions say speaking but FFT is quiet,
      // lift a little so the scope still moves with the voice turn.
      const raw = Math.max(live, bandEnergy, speaking ? 0.08 : 0);
      smoothedRef.current = smoothedRef.current * 0.82 + raw * 0.18;
      phaseRef.current += 0.02 + smoothedRef.current * 0.35;

      const next = historyRef.current.slice(1);
      next.push(smoothedRef.current);
      historyRef.current = next;
      setFrame((n) => n + 1);
    }, 32);
    return () => clearInterval(id);
  }, [bands, speaking, volume]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ w: width, h: height });
  };

  const smoothed = smoothedRef.current;
  const live = smoothed > 0.04 || speaking;

  const { barRects, scopePath, ghostPath, midY } = useMemo(() => {
    const w = size.w;
    const h = size.h;
    const mid = h / 2;
    const barW = w / BAR_COUNT;
    const mags =
      bands.length >= BAR_COUNT / 2
        ? Array.from({ length: BAR_COUNT }, (_, i) => {
            const src = bands[Math.floor((i / BAR_COUNT) * bands.length)] ?? 0;
            return src;
          })
        : Array.from({ length: BAR_COUNT }, () => 0);

    // Idle: almost flat — only a faint midline shimmer, not a fake equalizer.
    const idle = smoothed < 0.035 && !speaking;
    const rects: { x: number; y: number; bw: number; bh: number; top: boolean; alpha: number }[] =
      [];
    for (let i = 0; i < BAR_COUNT; i++) {
      const mag = idle ? 0.02 : Math.min(1, Math.max(0, mags[i] ?? 0));
      const bh = mag * h * 0.38;
      const alpha = idle ? 0.08 : 0.12 + mag * 0.55;
      const x = i * barW + 1;
      rects.push({ x, y: mid - bh, bw: Math.max(1, barW - 2), bh, top: true, alpha });
      rects.push({
        x,
        y: mid,
        bw: Math.max(1, barW - 2),
        bh: bh * 0.85,
        top: false,
        alpha: alpha * 0.75,
      });
    }

    const scope = Skia.Path.Make();
    const ghost = Skia.Path.Make();
    const hist = historyRef.current;
    if (idle) {
      scope.moveTo(0, mid);
      scope.lineTo(w, mid);
      ghost.moveTo(0, mid);
      ghost.lineTo(w, mid);
    } else {
      for (let x = 0; x < w; x++) {
        const idx = Math.min(hist.length - 1, Math.floor((x / w) * hist.length));
        const level = hist[idx] ?? 0;
        const v =
          (level - 0.02) *
          Math.sin(phaseRef.current * 3 + x * 0.085) *
          (0.35 + level * 2.2);
        const y = mid + v * (h * 0.42);
        const gy =
          mid +
          v * (h * 0.28) * 0.85 +
          Math.sin(phaseRef.current + x * 0.02) * (2 + level * 8);
        if (x === 0) {
          scope.moveTo(x, y);
          ghost.moveTo(x, gy);
        } else {
          scope.lineTo(x, y);
          ghost.lineTo(x, gy);
        }
      }
    }

    return { barRects: rects, scopePath: scope, ghostPath: ghost, midY: mid };
    // frame bump via smoothed/history is intentional — setFrame triggers recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bands, size.h, size.w, smoothed, speaking]);

  return (
    <View
      testID="agent-waveform"
      onLayout={onLayout}
      style={{
        height: targetHeight,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: PANEL_BORDER,
        backgroundColor: PANEL,
        overflow: "hidden",
      }}
    >
      <Canvas style={{ flex: 1 }}>
        <Rect x={0} y={0} width={size.w} height={size.h}>
          <LinearGradient
            start={vec(size.w / 2, size.h / 2 - 20)}
            end={vec(size.w / 2, size.h)}
            colors={[
              `rgba(61, 255, 196, ${0.04 + smoothed * 0.28})`,
              "rgba(61, 255, 196, 0)",
            ]}
          />
        </Rect>

        {barRects.map((b, i) => (
          <Rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.bw}
            height={Math.max(0.5, b.bh)}
            color={b.top ? AMBER : MINT}
            opacity={b.alpha}
          />
        ))}

        <Line
          p1={vec(0, midY)}
          p2={vec(size.w, midY)}
          color={MUTED}
          strokeWidth={1}
        >
          <DashPathEffect intervals={[4, 6]} />
        </Line>

        <Path
          path={ghostPath}
          color={MINT}
          style="stroke"
          strokeWidth={1.2}
          opacity={0.2 + smoothed * 0.4}
        />
        <Path
          path={scopePath}
          color={INK}
          style="stroke"
          strokeWidth={2.2}
          opacity={0.55 + Math.min(0.45, smoothed)}
        />
      </Canvas>

      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          paddingHorizontal: 12,
          paddingTop: 8,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <Text
          style={{
            color: live ? MINT : "#6F8FA3",
            fontSize: 10,
            letterSpacing: 1.6,
            textTransform: "uppercase",
            fontVariant: ["small-caps"],
          }}
        >
          {live ? "Alfred // out" : "Standby"}
        </Text>
        <Pressable
          testID="toggle-waveform-size"
          onPress={onToggleCollapsed}
          hitSlop={10}
          accessibilityLabel={collapsed ? "Expand waveform" : "Shrink waveform"}
          style={{
            height: 30,
            width: 30,
            borderRadius: 15,
            borderWidth: 1,
            borderColor: MINT,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(10, 18, 32, 0.85)",
          }}
        >
          {collapsed ? <ChevronDown color={MINT} size={15} /> : <ChevronUp color={MINT} size={15} />}
        </Pressable>
      </View>
    </View>
  );
}
