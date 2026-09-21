/**
 * Landscape robot controls. Shown only after AlfredBot is claimed.
 * Head, wheels, and a wave on Arm are live; robot is still a placeholder.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useFocusEffect, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Joystick, type StickValue } from "@/components/Joystick";
import { Backdrop, BRASS, Card, Display, INK, Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  cameraLatestUri,
  fetchCameraStatus,
  fetchHeadStatus,
  invertHeadStick,
  invertWheelStick,
  moveHeadStick,
  moveWheelStick,
  releaseHead,
  releaseWheels,
  RobotApiError,
  setHeadTracking,
  setRobotCameraPreview,
  waveArm,
} from "@/lib/robot-api";
import { getItem, KEYS, setItem } from "@/lib/secure-store";
import { getRobotHost } from "@/lib/robot-audio";

const TAB_BAR = {
  backgroundColor: INK,
  borderTopColor: "#2E343D",
  borderTopWidth: 1,
} as const;

type Deck = "head" | "arm" | "wheels" | "robot";

const DECKS: { id: Deck; label: string }[] = [
  { id: "head", label: "Head" },
  { id: "arm", label: "Arm" },
  { id: "wheels", label: "Wheels" },
  { id: "robot", label: "Robot" },
];

export default function RobotControl() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [host, setHost] = useState<string | null>(null);
  const [deck, setDeck] = useState<Deck>("head");
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [invertLR, setInvertLR] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraTick, setCameraTick] = useState(0);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraMirror, setCameraMirror] = useState(false);
  const [wheelsFacingMe, setWheelsFacingMe] = useState(false);
  const hostRef = useRef<string | null>(null);
  const onCameraFrame = useCallback(() => setCameraTick(Date.now()), []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.all([
        getRobotHost(),
        getItem(KEYS.headInvertLR),
        getItem(KEYS.headCameraMirror),
        getItem(KEYS.wheelsFacingMe),
      ]).then(async ([next, invert, mirror, facing]) => {
        if (cancelled) return;
        setInvertLR(invert === "1");
        setCameraMirror(mirror === "1");
        setWheelsFacingMe(facing === "1");
        hostRef.current = next;
        setHost(next);
        if (!next) return;
        try {
          const status = await fetchHeadStatus(next);
          if (cancelled) return;
          if (typeof status.tracking === "boolean") setTracking(status.tracking);
          if (status.error) setError(status.error);
          else if (status.pcaPresent === false) {
            setError("The neck board isn't on I2C. Face tracking is down for the same reason.");
          } else {
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof RobotApiError ? err.message : "Couldn't reach AlfredBot.");
          }
        }
      });
      return () => {
        cancelled = true;
        const live = hostRef.current;
        if (live) {
          void setRobotCameraPreview(live, false).catch(() => {});
          void releaseWheels(live).catch(() => {});
        }
        setCameraOn(false);
        setCameraTick(0);
      };
    }, [])
  );

  useEffect(() => {
    navigation.setOptions({
      tabBarStyle: landscape ? { display: "none" } : TAB_BAR,
    });
    return () => {
      navigation.setOptions({ tabBarStyle: TAB_BAR });
    };
  }, [landscape, navigation]);

  if (!host) {
    return (
      <Backdrop>
        <View style={{ flex: 1, paddingTop: insets.top + 24, paddingHorizontal: 24 }}>
          <Display>Robot</Display>
          <View className="mt-6">
            <Notice testID="control-need-claim">
              Claim AlfredBot in Settings first. These sticks talk to him on your Wi-Fi.
            </Notice>
          </View>
        </View>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <View
        testID="robot-control-screen"
        style={{
          flex: 1,
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 6,
          paddingLeft: insets.left + 16,
          paddingRight: insets.right + 16,
        }}
      >
        <View className="flex-row items-center justify-between">
          {landscape ? (
            <Text
              style={{
                color: BRASS,
                fontSize: 13,
                letterSpacing: 1.6,
                textTransform: "uppercase",
              }}
            >
              Robot
            </Text>
          ) : (
            <Display>Robot</Display>
          )}
          <Pressable
            testID="control-tracking"
            disabled={trackingBusy}
            onPress={() => {
              setTrackingBusy(true);
              void setHeadTracking(host, !tracking)
                .then((result) => {
                  setTracking(result.tracking);
                  setError(null);
                })
                .catch((err) => {
                  setError(err instanceof RobotApiError ? err.message : "Couldn't change tracking.");
                })
                .finally(() => setTrackingBusy(false));
            }}
            className="rounded-xl border px-3 py-1.5"
            style={{
              borderColor: tracking ? BRASS : "#2E343D",
              backgroundColor: tracking ? "rgba(216,165,74,0.18)" : "#111317",
              opacity: trackingBusy ? 0.6 : 1,
            }}
          >
            <Text style={{ color: tracking ? BRASS : "#5F656F", fontSize: 13 }}>
              {tracking ? "Tracking on" : "Tracking off"}
            </Text>
          </Pressable>
          <Pressable
            testID="control-invert-lr"
            onPress={() => {
              const next = !invertLR;
              setInvertLR(next);
              void setItem(KEYS.headInvertLR, next ? "1" : "0");
            }}
            className="rounded-xl border px-3 py-1.5"
            style={{
              borderColor: invertLR ? BRASS : "#2E343D",
              backgroundColor: invertLR ? "rgba(216,165,74,0.18)" : "#111317",
            }}
          >
            <Text style={{ color: invertLR ? BRASS : "#5F656F", fontSize: 13 }}>
              {invertLR ? "Behind" : "In front"}
            </Text>
          </Pressable>
          <View className="flex-row rounded-2xl border border-line bg-ink-800 p-1">
            {DECKS.map((item) => (
              <Pressable
                key={item.id}
                testID={`control-deck-${item.id}`}
                onPress={() => setDeck(item.id)}
                className={cn(
                  "rounded-xl px-3 py-1.5",
                  deck === item.id && "bg-brass/15"
                )}
              >
                <Text
                  className={cn("text-sm", deck === item.id ? "text-brass" : "text-faint")}
                  style={deck === item.id ? { color: BRASS } : undefined}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {error ? (
          <View className="mt-3">
            <Notice testID="control-error">{error}</Notice>
          </View>
        ) : null}

        {!landscape ? (
          <View className="mt-4">
            <Notice tone="info" testID="control-rotate">
              Turn the phone on its side — both thumbs reach the sticks that way.
            </Notice>
          </View>
        ) : null}

        <View style={{ flex: 1, marginTop: 12 }}>
          {deck === "arm" ? (
            <ArmDeck host={host} onError={setError} />
          ) : deck === "wheels" ? (
            <WheelsDeck
              host={host}
              facingMe={wheelsFacingMe}
              onError={setError}
              onToggleFacing={() => {
                const next = !wheelsFacingMe;
                setWheelsFacingMe(next);
                void setItem(KEYS.wheelsFacingMe, next ? "1" : "0");
              }}
            />
          ) : deck === "head" ? (
            <HeadDeck
              host={host}
              tracking={tracking}
              invertLR={invertLR}
              cameraOn={cameraOn}
              cameraTick={cameraTick}
              cameraBusy={cameraBusy}
              cameraMirror={cameraMirror}
              onError={setError}
              onToggleCamera={() => {
                setCameraBusy(true);
                const next = !cameraOn;
                void setRobotCameraPreview(host, next)
                  .then((status) => {
                    if (status.error) throw new RobotApiError(status.error);
                    setCameraOn(Boolean(status.running) && next);
                    setCameraTick(status.hasFrame ? Date.now() : 0);
                    setError(null);
                  })
                  .catch((err) => {
                    setCameraOn(false);
                    setError(err instanceof RobotApiError ? err.message : "Couldn't start the camera.");
                  })
                  .finally(() => setCameraBusy(false));
              }}
              onToggleMirror={() => {
                const next = !cameraMirror;
                setCameraMirror(next);
                void setItem(KEYS.headCameraMirror, next ? "1" : "0");
              }}
              onCameraFrame={onCameraFrame}
            />
          ) : (
            <Card className="flex-1 items-center justify-center">
              <Text className="text-base text-bone">Robot status and tracking will live here.</Text>
            </Card>
          )}
        </View>
      </View>
    </Backdrop>
  );
}

function HeadDeck({
  host,
  tracking,
  invertLR,
  cameraOn,
  cameraTick,
  cameraBusy,
  cameraMirror,
  onError,
  onToggleCamera,
  onToggleMirror,
  onCameraFrame,
}: {
  host: string;
  tracking: boolean;
  invertLR: boolean;
  cameraOn: boolean;
  cameraTick: number;
  cameraBusy: boolean;
  cameraMirror: boolean;
  onError: (message: string | null) => void;
  onToggleCamera: () => void;
  onToggleMirror: () => void;
  onCameraFrame: () => void;
}) {
  const left = useRef<StickValue>({ x: 0, y: 0 });
  const right = useRef<StickValue>({ x: 0, y: 0 });
  const sending = useRef(false);
  const [deckSize, setDeckSize] = useState({ w: 0, h: 0 });

  const flush = useCallback(async () => {
    if (tracking || sending.current) return;
    sending.current = true;
    try {
      const stick = invertHeadStick(
        { neck: left.current.x, tilt: left.current.y, roll: right.current.x },
        invertLR
      );
      await moveHeadStick(host, { ...stick, dtMs: 80 });
      onError(null);
    } catch (err) {
      onError(err instanceof RobotApiError ? err.message : "Couldn't move his head.");
    } finally {
      sending.current = false;
    }
  }, [host, invertLR, onError, tracking]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (tracking) return;
      const active =
        Math.abs(left.current.x) > 0.08 ||
        Math.abs(left.current.y) > 0.08 ||
        Math.abs(right.current.x) > 0.08;
      if (active) void flush();
    }, 80);
    return () => {
      clearInterval(timer);
      void releaseHead(host).catch(() => {});
    };
  }, [flush, host, tracking]);

  const stop = useCallback(() => {
    left.current = { x: 0, y: 0 };
    right.current = { x: 0, y: 0 };
    void releaseHead(host).catch(() => {});
  }, [host]);

  useEffect(() => {
    if (tracking) stop();
  }, [stop, tracking]);

  useEffect(() => {
    if (!cameraOn) return;
    const timer = setInterval(() => {
      void fetchCameraStatus(host)
        .then((status) => {
          if (status.error) onError(status.error);
          if (status.hasFrame) onCameraFrame();
        })
        .catch(() => {});
    }, 280);
    return () => clearInterval(timer);
  }, [cameraOn, host, onCameraFrame, onError]);

  const cameraTransform = cameraMirror
    ? ([{ rotate: "-90deg" }, { scaleX: -1 }] as const)
    : ([{ rotate: "-90deg" }] as const);

  return (
    <View
      testID="control-head"
      style={{ flex: 1 }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setDeckSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
      }}
    >
      {cameraOn && cameraTick && deckSize.w > 0 ? (
        <Image
          testID="control-camera-feed"
          source={{ uri: cameraLatestUri(host, cameraTick) }}
          resizeMode="cover"
          style={{
            position: "absolute",
            width: deckSize.h,
            height: deckSize.w,
            left: (deckSize.w - deckSize.h) / 2,
            top: (deckSize.h - deckSize.w) / 2,
            transform: [...cameraTransform],
          }}
        />
      ) : null}
      {cameraOn ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(8,8,10,0.38)" }]}
        />
      ) : null}
      {cameraOn && !cameraTick ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { alignItems: "center", justifyContent: "center" }]}>
          <Text style={{ color: "#8A9099", fontSize: 13 }}>Starting camera…</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 8, marginBottom: 8 }}>
        <Pressable
          testID="control-camera"
          disabled={cameraBusy}
          onPress={onToggleCamera}
          className="rounded-xl border px-3 py-1.5"
          style={{
            borderColor: cameraOn ? BRASS : "#2E343D",
            backgroundColor: cameraOn ? "rgba(216,165,74,0.18)" : "#111317",
            opacity: cameraBusy ? 0.6 : 1,
          }}
        >
          <Text style={{ color: cameraOn ? BRASS : "#5F656F", fontSize: 13 }}>
            {cameraOn ? "Camera on" : "Camera off"}
          </Text>
        </Pressable>
        <Pressable
          testID="control-camera-mirror"
          onPress={onToggleMirror}
          className="rounded-xl border px-3 py-1.5"
          style={{
            borderColor: cameraMirror ? BRASS : "#2E343D",
            backgroundColor: cameraMirror ? "rgba(216,165,74,0.18)" : "#111317",
          }}
        >
          <Text style={{ color: cameraMirror ? BRASS : "#5F656F", fontSize: 13 }}>
            {cameraMirror ? "Mirror" : "As seen"}
          </Text>
        </Pressable>
      </View>
      <View className="flex-1 flex-row items-center">
      <Joystick
        testID="joystick-neck"
        axes="xy"
        label="Neck"
        hint={tracking ? "Locked while tracking" : "Look around"}
        disabled={tracking}
        onChange={(value) => {
          left.current = value;
        }}
        onRelease={() => {
          left.current = { x: 0, y: 0 };
          if (Math.abs(right.current.x) < 0.08) stop();
        }}
      />
      <View className="w-6" />
      <Joystick
        testID="joystick-roll"
        axes="x"
        label="Tilt"
        hint={tracking ? "Locked while tracking" : "Ear to shoulder"}
        disabled={tracking}
        onChange={(value) => {
          right.current = value;
        }}
        onRelease={() => {
          right.current = { x: 0, y: 0 };
          if (Math.abs(left.current.x) < 0.08 && Math.abs(left.current.y) < 0.08) stop();
        }}
      />
      </View>
    </View>
  );
}

function ArmDeck({ host, onError }: { host: string; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);

  return (
    <View testID="control-arm" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Pressable
        testID="control-arm-wave"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void waveArm(host)
            .then(() => onError(null))
            .catch((err) => {
              onError(err instanceof RobotApiError ? err.message : "Couldn't start the wave.");
            })
            .finally(() => setBusy(false));
        }}
        className="rounded-xl border px-6 py-3"
        style={{
          borderColor: busy ? BRASS : "#2E343D",
          backgroundColor: busy ? "rgba(216,165,74,0.18)" : "#111317",
          opacity: busy ? 0.7 : 1,
        }}
      >
        <Text style={{ color: busy ? BRASS : "#F4F1EA", fontSize: 17 }}>
          {busy ? "Waving…" : "Wave"}
        </Text>
      </Pressable>
      <Text style={{ color: "#5F656F", fontSize: 13, marginTop: 14, textAlign: "center" }}>
        The Pi talks to the arm over Bluetooth. This phone only sends the cue.
      </Text>
    </View>
  );
}

function WheelsDeck({
  host,
  facingMe,
  onError,
  onToggleFacing,
}: {
  host: string;
  facingMe: boolean;
  onError: (message: string | null) => void;
  onToggleFacing: () => void;
}) {
  const left = useRef(0);
  const right = useRef(0);
  const sending = useRef(false);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      const stick = invertWheelStick({ left: left.current, right: right.current }, facingMe);
      await moveWheelStick(host, stick);
      onError(null);
    } catch (err) {
      onError(err instanceof RobotApiError ? err.message : "Couldn't drive the wheels.");
    } finally {
      sending.current = false;
    }
  }, [facingMe, host, onError]);

  useEffect(() => {
    const timer = setInterval(() => {
      const active = Math.abs(left.current) > 0.08 || Math.abs(right.current) > 0.08;
      if (active) void flush();
    }, 80);
    return () => {
      clearInterval(timer);
      void releaseWheels(host).catch(() => {});
    };
  }, [flush, host]);

  const stop = useCallback(() => {
    left.current = 0;
    right.current = 0;
    void releaseWheels(host).catch(() => {});
  }, [host]);

  useEffect(() => {
    stop();
  }, [facingMe, stop]);

  return (
    <View testID="control-wheels" style={{ flex: 1 }}>
      <View style={{ alignItems: "center", marginBottom: 8 }}>
        <Pressable
          testID="control-wheels-facing"
          onPress={onToggleFacing}
          className="rounded-xl border px-3 py-1.5"
          style={{
            borderColor: facingMe ? BRASS : "#2E343D",
            backgroundColor: facingMe ? "rgba(216,165,74,0.18)" : "#111317",
          }}
        >
          <Text style={{ color: facingMe ? BRASS : "#5F656F", fontSize: 13 }}>
            {facingMe ? "Facing me" : "Facing away"}
          </Text>
        </Pressable>
      </View>
      <View className="flex-1 flex-row items-center">
        <Joystick
          testID="joystick-wheel-left"
          axes="y"
          label="Left"
          hint={facingMe ? "Your left — flipped" : "Left motor"}
          onChange={(value) => {
            left.current = value.y;
          }}
          onRelease={() => {
            left.current = 0;
            if (Math.abs(right.current) < 0.08) stop();
          }}
        />
        <View className="w-6" />
        <Joystick
          testID="joystick-wheel-right"
          axes="y"
          label="Right"
          hint={facingMe ? "Your right — flipped" : "Right motor"}
          onChange={(value) => {
            right.current = value.y;
          }}
          onRelease={() => {
            right.current = 0;
            if (Math.abs(left.current) < 0.08) stop();
          }}
        />
      </View>
    </View>
  );
}
