/**
 * Sci-fi memory constellation — Skia canvas + force layout.
 * Nebula, orbits, stars and nodes share one camera (pan / zoom / rotate)
 * so the field feels like a single piece of space.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Line,
  Path,
  RadialGradient,
  Rect,
  Skia,
  Text as SkiaText,
  vec,
  matchFont,
} from "@shopify/react-native-skia";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { GraphLink, GraphNode } from "@/lib/types";
import {
  buildSimulation,
  filterGraph,
  isOrganizationNode,
  matchNodeIds,
  nodeRadius,
  tickSimulation,
  trimGraph,
  typeColor,
  type SimLink,
  type SimNode,
  type Simulation,
} from "@/lib/memory-graph-sim";

const FONT = matchFont({
  fontFamily: Platform.select({ ios: "Helvetica Neue", default: "sans-serif" })!,
  fontSize: 11,
  fontWeight: "500",
});

/** How far the nebula extends past the viewport so pan/rotate never shows a seam. */
const SPACE_PAD = 1.35;

interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
  warm: boolean;
  depth: number;
}

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  warm: boolean;
}

interface Camera {
  x: number;
  y: number;
  k: number;
  r: number;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildStarfield(width: number, height: number, count = 160): Star[] {
  const padX = width * SPACE_PAD;
  const padY = height * SPACE_PAD;
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: -padX + hash01(i * 3.1) * (width + padX * 2),
      y: -padY + hash01(i * 7.9 + 1) * (height + padY * 2),
      r: 0.4 + hash01(i * 11.3) * 1.8,
      phase: hash01(i * 19.7) * Math.PI * 2,
      warm: hash01(i * 5.5) > 0.62,
      depth: 0.45 + hash01(i * 13.1) * 0.55,
    });
  }
  return stars;
}

function buildOrbitPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot: number
): ReturnType<typeof Skia.Path.Make> {
  const path = Skia.Path.Make();
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x0 = Math.cos(t) * rx;
    const y0 = Math.sin(t) * ry;
    const x = cx + x0 * Math.cos(rot) - y0 * Math.sin(rot);
    const y = cy + x0 * Math.sin(rot) + y0 * Math.cos(rot);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.close();
  return path;
}

function buildAuroraPath(
  width: number,
  height: number,
  t: number,
  band: number
): ReturnType<typeof Skia.Path.Make> {
  const path = Skia.Path.Make();
  const pad = width * SPACE_PAD;
  const yBase = height * (0.28 + band * 0.18);
  const amp = height * 0.06;
  const steps = 48;
  const x0 = -pad;
  const x1 = width + pad;
  path.moveTo(x0, yBase);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (i / steps) * (x1 - x0);
    const y =
      yBase +
      Math.sin(x * 0.012 + t * (0.6 + band * 0.15) + band * 1.7) * amp +
      Math.sin(x * 0.031 - t * 0.4 + band) * amp * 0.45;
    path.lineTo(x, y);
  }
  for (let i = steps; i >= 0; i--) {
    const x = x0 + (i / steps) * (x1 - x0);
    const y =
      yBase +
      18 +
      Math.sin(x * 0.012 + t * (0.6 + band * 0.15) + band * 1.7) * amp * 0.7;
    path.lineTo(x, y);
  }
  path.close();
  return path;
}

function pulsePoint(a: SimNode, b: SimNode, u: number): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ox = (-dy / len) * 10;
  const oy = (dx / len) * 10;
  const s = Math.sin(u * Math.PI);
  return {
    x: a.x + dx * u + ox * s,
    y: a.y + dy * u + oy * s,
  };
}

interface LabelRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface VisibleLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  must: boolean;
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function estimateLabelWidth(text: string, fontSize: number): number {
  if (FONT) {
    try {
      const measured = FONT.measureText(text) as number | { width: number };
      return typeof measured === "number" ? measured : measured.width;
    } catch {
      /* fall through */
    }
  }
  return text.length * fontSize * 0.55;
}

/**
 * Greedy label placement (same idea as the desktop canvas): highest-priority
 * labels win; others are dropped when their boxes collide so the field stays readable.
 */
function pickVisibleLabels(
  nodes: SimNode[],
  opts: {
    focusId: string | null;
    linkedIds: Set<string> | null;
    matchA: Set<string>;
    matchB: Set<string>;
    scale: number;
  }
): VisibleLabel[] {
  const k = Math.max(0.45, opts.scale);
  // FONT is fixed in world space (Group scales by cam.k), so collision boxes use that size.
  const fontSize = 11;
  const candidates: Array<{
    id: string;
    text: string;
    priority: number;
    must: boolean;
    rect: LabelRect;
    x: number;
    y: number;
    color: string;
  }> = [];

  for (const node of nodes) {
    const focused = opts.focusId === node.id;
    const linked = opts.linkedIds?.has(node.id) ?? false;
    const isA = opts.matchA.has(node.id);
    const isB = opts.matchB.has(node.id);
    const dimmed = opts.focusId != null && !focused && !linked && !isA && !isB;
    if (dimmed) continue;

    const must = focused || linked || isA || isB;
    const eligible =
      must || k > 1.3 || (node.degree ?? 0) >= 4 || nodes.length < 80;
    if (!eligible) continue;

    const text = node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label;
    if (!text) continue;

    const r = nodeRadius(node);
    const width = estimateLabelWidth(text, fontSize);
    const pad = 5 / k;
    const y = node.y + r + 14 / k;
    const x = node.x - width / 2;
    candidates.push({
      id: node.id,
      text,
      must,
      priority: focused
        ? 1e9
        : isA || isB
          ? 1e7 + (node.degree ?? 0)
          : linked
            ? 1e6 + (node.degree ?? 0)
            : node.degree ?? 0,
      rect: {
        left: node.x - width / 2 - pad,
        right: node.x + width / 2 + pad,
        top: y - fontSize - pad,
        bottom: y + pad * 0.35,
      },
      x,
      y,
      color: focused || isA || isB ? "#F4F1EA" : "rgba(244,241,234,0.78)",
    });
  }

  candidates.sort(
    (a, b) => b.priority - a.priority || a.text.length - b.text.length
  );

  const placed: LabelRect[] = [];
  const visible: VisibleLabel[] = [];
  for (const item of candidates) {
    if (!item.must && placed.some((rect) => rectsOverlap(rect, item.rect))) continue;
    placed.push(item.rect);
    visible.push({
      id: item.id,
      text: item.text,
      x: item.x,
      y: item.y,
      color: item.color,
      must: item.must,
    });
  }
  return visible;
}

/** Camera: pan, then pivot about world center, scale, rotate. */
function spaceTransform(camera: Camera, cx: number, cy: number) {
  return [
    { translateX: camera.x },
    { translateY: camera.y },
    { translateX: cx },
    { translateY: cy },
    { scale: camera.k },
    { rotate: camera.r },
    { translateX: -cx },
    { translateY: -cy },
  ];
}

function screenToWorld(sx: number, sy: number, camera: Camera, cx: number, cy: number) {
  let x = sx - camera.x - cx;
  let y = sy - camera.y - cy;
  x /= camera.k || 1;
  y /= camera.k || 1;
  const cos = Math.cos(-camera.r);
  const sin = Math.sin(-camera.r);
  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;
  return { x: rx + cx, y: ry + cy };
}

export function MemoryGraphView({
  nodes,
  links,
  width,
  height,
  types,
  query,
  queryB = "",
  focusId,
  onFocus,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
  types: Set<string>;
  query: string;
  queryB?: string;
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const filtered = useMemo(() => {
    // Filter first so dual-search endpoints aren't dropped by the phone node cap.
    const scoped = filterGraph(nodes, links, { types, query, queryB });
    return trimGraph(scoped.nodes, scoped.links);
  }, [nodes, links, types, query, queryB]);

  const matchSets = useMemo(() => {
    const a = query.trim();
    const b = (queryB ?? "").trim();
    if (!a || !b) return { a: new Set<string>(), b: new Set<string>() };
    return { a: matchNodeIds(nodes, a), b: matchNodeIds(nodes, b) };
  }, [nodes, query, queryB]);

  const simRef = useRef<Simulation | null>(null);
  const [frame, setFrame] = useState(0);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1, r: 0 });
  const draggingId = useRef<string | null>(null);
  const panOrigin = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
  const pinchOrigin = useRef({ k: 1, r: 0, focalX: 0, focalY: 0, camX: 0, camY: 0 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const timeRef = useRef(0);
  const embersRef = useRef<Ember[]>([]);
  const cx = width / 2;
  const cy = height / 2;
  const pivotRef = useRef({ cx, cy });
  pivotRef.current = { cx, cy };

  const stars = useMemo(() => buildStarfield(width, height), [width, height]);

  const orbits = useMemo(() => {
    const s = Math.min(width, height);
    return [
      buildOrbitPath(cx, cy, s * 0.38, s * 0.18, -0.35),
      buildOrbitPath(cx, cy, s * 0.48, s * 0.22, 0.55),
      buildOrbitPath(cx, cy * 1.02, s * 0.3, s * 0.14, 1.1),
      buildOrbitPath(cx, cy, s * 0.62, s * 0.28, -0.9),
    ];
  }, [width, height, cx, cy]);

  useEffect(() => {
    if (width < 8 || height < 8) return;
    simRef.current = buildSimulation(filtered.nodes, filtered.links, width, height);
    setCamera({ x: 0, y: 0, k: 1, r: 0 });
    const padX = width * SPACE_PAD;
    const padY = height * SPACE_PAD;
    embersRef.current = Array.from({ length: 36 }, (_, i) => ({
      x: -padX + hash01(i * 2.2) * (width + padX * 2),
      y: -padY + hash01(i * 4.1 + 3) * (height + padY * 2),
      vx: (hash01(i * 8.3) - 0.5) * 0.25,
      vy: -0.12 - hash01(i * 6.7) * 0.28,
      life: hash01(i * 9.1),
      warm: hash01(i * 3.3) > 0.5,
    }));
    setFrame((f) => f + 1);
  }, [filtered, width, height]);

  useEffect(() => {
    let raf = 0;
    let lastDraw = 0;
    const padX = width * SPACE_PAD;
    const padY = height * SPACE_PAD;
    const loop = (now: number) => {
      timeRef.current = now / 1000;
      const sim = simRef.current;
      if (sim && sim.alpha > 0.018) {
        tickSimulation(sim, draggingId.current);
      }
      for (const e of embersRef.current) {
        e.x += e.vx;
        e.y += e.vy;
        e.life += 0.004;
        if (e.y < -padY - 8 || e.life > 1) {
          e.x = -padX + hash01(e.x * 0.1 + now) * (width + padX * 2);
          e.y = height + padY;
          e.life = 0;
        }
      }
      if (now - lastDraw > 32) {
        lastDraw = now;
        setFrame((f) => f + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [width, height]);

  const toWorld = useCallback((sx: number, sy: number) => {
    const { cx: px, cy: py } = pivotRef.current;
    return screenToWorld(sx, sy, cameraRef.current, px, py);
  }, []);

  const hitTest = useCallback(
    (sx: number, sy: number): SimNode | null => {
      const sim = simRef.current;
      if (!sim) return null;
      const p = toWorld(sx, sy);
      const { k } = cameraRef.current;
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const node of sim.nodes) {
        const dx = node.x - p.x;
        const dy = node.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const r = nodeRadius(node) + 10 / k;
        if (d <= r && d < bestD) {
          best = node;
          bestD = d;
        }
      }
      return best;
    },
    [toWorld]
  );

  // Drag a node to move it; drag empty space to pan the camera.
  // Pinch / twist are two-finger; tap selects.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minPointers(1)
    .maxPointers(1)
    .onBegin((e) => {
      const hit = hitTest(e.x, e.y);
      if (hit) {
        draggingId.current = hit.id;
        Haptics.selectionAsync().catch(() => {});
      } else {
        draggingId.current = null;
        const cam = cameraRef.current;
        panOrigin.current = { x: e.x, y: e.y, camX: cam.x, camY: cam.y };
      }
    })
    .onUpdate((e) => {
      const id = draggingId.current;
      const sim = simRef.current;
      if (id && sim) {
        const node = sim.nodes.find((n) => n.id === id);
        if (node) {
          const world = toWorld(e.x, e.y);
          node.x = world.x;
          node.y = world.y;
          node.vx = 0;
          node.vy = 0;
          sim.alpha = Math.max(sim.alpha, 0.25);
        }
        return;
      }
      setCamera((c) => ({
        ...c,
        x: panOrigin.current.camX + e.translationX,
        y: panOrigin.current.camY + e.translationY,
      }));
    })
    .onEnd(() => {
      draggingId.current = null;
    })
    .onFinalize(() => {
      draggingId.current = null;
    });

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onBegin((e) => {
      const cam = cameraRef.current;
      pinchOrigin.current = {
        k: cam.k,
        r: cam.r,
        focalX: e.focalX,
        focalY: e.focalY,
        camX: cam.x,
        camY: cam.y,
      };
    })
    .onUpdate((e) => {
      const next = Math.min(3.2, Math.max(0.45, pinchOrigin.current.k * e.scale));
      const { focalX, focalY, camX, camY, k, r } = pinchOrigin.current;
      const { cx: px, cy: py } = pivotRef.current;
      const before = screenToWorld(focalX, focalY, { x: camX, y: camY, k, r }, px, py);
      const afterCam = { x: camX, y: camY, k: next, r };
      const after = screenToWorld(focalX, focalY, afterCam, px, py);
      setCamera({
        k: next,
        r,
        x: camX + (after.x - before.x) * next,
        y: camY + (after.y - before.y) * next,
      });
    });

  const rotation = Gesture.Rotation()
    .runOnJS(true)
    .onBegin((e) => {
      const cam = cameraRef.current;
      pinchOrigin.current = {
        k: cam.k,
        r: cam.r,
        focalX: e.anchorX,
        focalY: e.anchorY,
        camX: cam.x,
        camY: cam.y,
      };
    })
    .onUpdate((e) => {
      const nextR = pinchOrigin.current.r + e.rotation;
      const { focalX, focalY, camX, camY, k, r } = pinchOrigin.current;
      const { cx: px, cy: py } = pivotRef.current;
      const before = screenToWorld(focalX, focalY, { x: camX, y: camY, k, r }, px, py);
      const afterCam = { x: camX, y: camY, k, r: nextR };
      const after = screenToWorld(focalX, focalY, afterCam, px, py);
      setCamera({
        k,
        r: nextR,
        x: camX + (after.x - before.x) * k,
        y: camY + (after.y - before.y) * k,
      });
    });

  const tap = Gesture.Tap()
    .runOnJS(true)
    .maxDuration(250)
    .onEnd((e) => {
      const hit = hitTest(e.x, e.y);
      if (hit) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onFocus(hit.id === focusId ? null : hit.id);
      } else {
        onFocus(null);
      }
    });

  const gesture = Gesture.Simultaneous(Gesture.Exclusive(pan, tap), pinch, rotation);

  void frame;

  const sim = simRef.current;
  const simNodes: SimNode[] = sim?.nodes ?? [];
  const simLinks: SimLink[] = sim?.links ?? [];
  const linkedIds = useMemo(() => {
    if (!focusId) return null;
    const set = new Set<string>([focusId]);
    for (const l of simLinks) {
      if (l.source.id === focusId) set.add(l.target.id);
      if (l.target.id === focusId) set.add(l.source.id);
    }
    return set;
  }, [focusId, simLinks, frame]);

  const t = timeRef.current;
  const breath = 0.5 + 0.5 * Math.sin(t * 0.7);

  const auroras = useMemo(
    () => [0, 1, 2].map((band) => buildAuroraPath(width, height, t, band)),
    [width, height, t]
  );

  const pulses = useMemo(() => {
    const out: { x: number; y: number; warm: boolean; r: number }[] = [];
    const n = simLinks.length;
    if (!n) return out;
    const take = Math.min(n, 48);
    for (let i = 0; i < take; i++) {
      const l = simLinks[(i * 7) % n]!;
      const focused =
        focusId != null && (l.source.id === focusId || l.target.id === focusId);
      if (focusId && !focused) continue;
      const u = (t * (0.18 + (i % 5) * 0.04) + i * 0.17) % 1;
      const p = pulsePoint(l.source, l.target, u);
      out.push({
        x: p.x,
        y: p.y,
        warm: i % 3 !== 0,
        r: focused ? 2.8 : 1.6,
      });
    }
    return out;
  }, [simLinks, t, focusId]);

  const visibleLabels = useMemo(
    () =>
      pickVisibleLabels(simNodes, {
        focusId,
        linkedIds,
        matchA: matchSets.a,
        matchB: matchSets.b,
        scale: camera.k,
      }),
    [simNodes, focusId, linkedIds, matchSets, camera.k, frame]
  );

  const cam = camera;
  const transform = spaceTransform(cam, cx, cy);
  const padX = width * SPACE_PAD;
  const padY = height * SPACE_PAD;

  return (
    <View style={{ width, height, overflow: "hidden" }}>
      <GestureDetector gesture={gesture}>
        <View style={{ width, height }}>
          <Canvas style={{ width, height }}>
            {/* Screen-fixed void so rotate/zoom never flashes a hard edge */}
            <Rect x={0} y={0} width={width} height={height} color="#050608" />

            <Group transform={transform}>
              {/* Nebula well — rides with the constellation */}
              <Circle cx={cx} cy={cy} r={Math.max(width, height) * (1 + SPACE_PAD)}>
                <RadialGradient
                  c={vec(cx, cy * 0.78)}
                  r={Math.max(width, height) * (0.95 + SPACE_PAD * 0.4)}
                  colors={["#1A1610", "#0C1016", "#050608"]}
                />
              </Circle>

              <Path path={auroras[0]!} color={`rgba(216,165,74,${0.05 + breath * 0.03})`} />
              <Path path={auroras[1]!} color={`rgba(61,255,196,${0.04 + breath * 0.025})`} />
              <Path path={auroras[2]!} color={`rgba(226,87,76,${0.03 + breath * 0.02})`} />

              {orbits.map((path, i) => (
                <Path
                  key={`orbit-${i}`}
                  path={path}
                  color={i % 2 === 1 ? "rgba(61,255,196,0.1)" : "rgba(216,165,74,0.11)"}
                  style="stroke"
                  strokeWidth={1 / cam.k}
                />
              ))}

              {stars.map((s, i) => {
                const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.8 + s.phase));
                return (
                  <Circle
                    key={`star-${i}`}
                    cx={s.x}
                    cy={s.y}
                    r={(s.r * (0.7 + twinkle * 0.5) * s.depth) / Math.max(0.7, Math.sqrt(cam.k))}
                    color={
                      s.warm
                        ? `rgba(244,241,234,${0.2 + twinkle * 0.55 * s.depth})`
                        : `rgba(61,255,196,${0.12 + twinkle * 0.45 * s.depth})`
                    }
                  />
                );
              })}

              {embersRef.current.map((e, i) => {
                const fade = Math.sin(Math.min(1, e.life) * Math.PI);
                if (e.x < -padX - 20 || e.x > width + padX + 20) return null;
                return (
                  <Circle
                    key={`ember-${i}`}
                    cx={e.x}
                    cy={e.y}
                    r={(1.2 + fade) / Math.max(0.7, Math.sqrt(cam.k))}
                    color={
                      e.warm
                        ? `rgba(216,165,74,${0.15 + fade * 0.45})`
                        : `rgba(61,255,196,${0.12 + fade * 0.4})`
                    }
                  />
                );
              })}

              {simLinks.map((l, i) => {
                const focused =
                  focusId != null && (l.source.id === focusId || l.target.id === focusId);
                const bridging = matchSets.a.size > 0 && matchSets.b.size > 0;
                const dimmed = focusId != null && !focused;
                return (
                  <Line
                    key={`${l.source.id}-${l.target.id}-${i}`}
                    p1={vec(l.source.x, l.source.y)}
                    p2={vec(l.target.x, l.target.y)}
                    color={
                      focused || bridging
                        ? "rgba(216,165,74,0.85)"
                        : dimmed
                          ? "rgba(93,160,148,0.08)"
                          : "rgba(61,255,196,0.2)"
                    }
                    strokeWidth={focused || bridging ? 2.2 / cam.k : 1 / cam.k}
                  />
                );
              })}

              {pulses.map((p, i) => (
                <Group key={`pulse-${i}`}>
                  <Circle
                    cx={p.x}
                    cy={p.y}
                    r={(p.r + 3) / cam.k}
                    color={p.warm ? "rgba(216,165,74,0.35)" : "rgba(61,255,196,0.3)"}
                    opacity={0.7}
                  >
                    <BlurMask blur={4} style="normal" />
                  </Circle>
                  <Circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r / cam.k}
                    color={p.warm ? "#F0E0B0" : "#B8FFE8"}
                  />
                </Group>
              ))}

              {simNodes.map((node) => {
                const focused = focusId === node.id;
                const linked = linkedIds?.has(node.id) ?? false;
                const isA = matchSets.a.has(node.id);
                const isB = matchSets.b.has(node.id);
                const dimmed = focusId != null && !focused && !linked;
                const r = nodeRadius(node) + (isA || isB ? 2 : 0);
                const color = focused
                  ? "#F4F1EA"
                  : isA
                    ? "#D8A54A"
                    : isB
                      ? "#3DFFC4"
                      : dimmed
                        ? "rgba(141,147,158,0.25)"
                        : typeColor(
                            isOrganizationNode(node) ? "Organization" : node.type,
                          );

                return (
                  <Group key={node.id}>
                    {focused || linked || isA || isB ? (
                      <Circle cx={node.x} cy={node.y} r={r + 8} color={color} opacity={0.35}>
                        <BlurMask blur={8} style="normal" />
                      </Circle>
                    ) : null}
                    <Circle
                      cx={node.x}
                      cy={node.y}
                      r={focused ? r + 2 : r}
                      color={color}
                    />
                    {(isA || isB) && !focused ? (
                      <Circle
                        cx={node.x}
                        cy={node.y}
                        r={r + 3}
                        color={isA ? "#D8A54A" : "#3DFFC4"}
                        style="stroke"
                        strokeWidth={1.5 / cam.k}
                      />
                    ) : null}
                    <Circle
                      cx={node.x}
                      cy={node.y}
                      r={Math.max(1.5, r * 0.35)}
                      color={focused ? "#0A0B0D" : "rgba(10,11,13,0.55)"}
                    />
                  </Group>
                );
              })}

              {FONT
                ? visibleLabels.map((label) => (
                    <SkiaText
                      key={`label-${label.id}`}
                      x={label.x}
                      y={label.y}
                      text={label.text}
                      font={FONT}
                      color={label.color}
                    />
                  ))
                : null}
            </Group>
          </Canvas>
        </View>
      </GestureDetector>
      <View pointerEvents="none" style={styles.vignette} />
    </View>
  );
}

const styles = StyleSheet.create({
  vignette: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: "rgba(216,165,74,0.18)",
  },
});
