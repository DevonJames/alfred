import { useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { BRASS, LINE } from "@/components/ui";

export type StickValue = { x: number; y: number };

export function Joystick({
  axes,
  label,
  hint,
  testID,
  disabled = false,
  onChange,
  onRelease,
}: {
  axes: "xy" | "x" | "y";
  label: string;
  hint: string;
  testID?: string;
  disabled?: boolean;
  onChange: (value: StickValue) => void;
  onRelease: () => void;
}) {
  const long = axes === "x" ? 168 : 196;
  const wellW = axes === "y" ? 92 : long;
  const wellH = axes === "x" ? 92 : long;
  const radius = (axes === "y" ? wellH : wellW) / 2 - 18;
  const last = useRef<StickValue>({ x: 0, y: 0 });
  const knob = useRef({ x: 0, y: 0 });
  const setKnob = useRef<(x: number, y: number) => void>(() => {});
  const onChangeRef = useRef(onChange);
  const onReleaseRef = useRef(onRelease);
  onChangeRef.current = onChange;
  onReleaseRef.current = onRelease;

  const gesture = useMemo(() => {
    const apply = (dx: number, dy: number) => {
      const nx = axes === "y" ? 0 : Math.max(-1, Math.min(1, dx / radius));
      const ny = axes === "x" ? 0 : Math.max(-1, Math.min(1, -dy / radius));
      last.current = { x: nx, y: ny };
      knob.current = { x: nx * radius, y: -ny * radius };
      setKnob.current(knob.current.x, knob.current.y);
      onChangeRef.current(last.current);
    };
    const reset = () => {
      last.current = { x: 0, y: 0 };
      knob.current = { x: 0, y: 0 };
      setKnob.current(0, 0);
      onReleaseRef.current();
    };
    // Sibling pans: each stick owns its own pointer. PanResponder cannot.
    return Gesture.Pan()
      .enabled(!disabled)
      .maxPointers(1)
      .minDistance(0)
      .shouldCancelWhenOutside(false)
      .cancelsTouchesInView(false)
      .runOnJS(true)
      .onUpdate((event) => {
        apply(event.translationX, event.translationY);
      })
      .onFinalize(() => {
        reset();
      });
  }, [axes, disabled, radius]);

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.wrap} testID={testID} pointerEvents={disabled ? "none" : "auto"}>
        <Text style={styles.label}>{label}</Text>
        <View
          style={[
            styles.well,
            { width: wellW, height: wellH },
            disabled && styles.wellDisabled,
          ]}
        >
          {axes === "x" ? (
            <View style={styles.rail} />
          ) : axes === "y" ? (
            <View style={styles.railY} />
          ) : (
            <View style={styles.cross} />
          )}
          <Knob
            register={(fn) => {
              setKnob.current = fn;
            }}
          />
        </View>
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </GestureDetector>
  );
}

function Knob({ register }: { register: (fn: (x: number, y: number) => void) => void }) {
  const view = useRef<View>(null);
  register((x, y) => {
    view.current?.setNativeProps({ style: { transform: [{ translateX: x }, { translateY: y }] } });
  });
  return <View ref={view} style={styles.knob} />;
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", flex: 1 },
  label: {
    color: BRASS,
    fontSize: 13,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  hint: { color: "#5F656F", fontSize: 12, marginTop: 10, textAlign: "center" },
  wellDisabled: { opacity: 0.35 },
  well: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "#111317",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  rail: {
    position: "absolute",
    left: 22,
    right: 22,
    height: 2,
    backgroundColor: "rgba(216,165,74,0.28)",
  },
  railY: {
    position: "absolute",
    top: 22,
    bottom: 22,
    width: 2,
    backgroundColor: "rgba(216,165,74,0.28)",
  },
  cross: {
    position: "absolute",
    width: "62%",
    height: "62%",
    borderColor: "rgba(216,165,74,0.16)",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
  },
  knob: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: BRASS,
    shadowColor: BRASS,
    shadowOpacity: 0.45,
    shadowRadius: 8,
  },
});
