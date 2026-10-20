import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { router, type Href } from "expo-router";
import { Camera, Minus, Pause, Plus, Square, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  BONE,
  Button,
  Chip,
  FAINT,
  Field,
  Label,
  LINE,
  LIVE,
  MUTED,
  Notice,
} from "@/components/ui";
import { desktopErrorMessage } from "@/lib/desktop-api";
import { prepareNoteRecordingSession, releaseAudioSession } from "@/lib/audio";
import { prepareNoteStill, saveStillToLibrary } from "@/lib/note-stills";
import { useNoteUpload, type NoteStillInput } from "@/lib/note-upload";
import type { AudioNoteTemplate } from "@/lib/types";

const LONG_AFTER_SECONDS = 50 * 60;

const TEMPLATES: { key: AudioNoteTemplate; label: string }[] = [
  { key: "meeting", label: "Meeting" },
  { key: "brainstorm", label: "Brainstorm" },
  { key: "checkin", label: "Check-in" },
  { key: "freeform", label: "Freeform" },
];

const RECORD_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function zoomLabel(zoom: number): string {
  return `${(1 + zoom * 4).toFixed(1)}×`;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function RecordingKeepAwake() {
  useKeepAwake();
  return null;
}

export default function RecordNote() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [durationMode, setDurationMode] = useState<"short" | "long">("long");
  const [template, setTemplate] = useState<AudioNoteTemplate>("meeting");
  const [title, setTitle] = useState("");
  const [attendees, setAttendees] = useState("");
  const [phase, setPhase] = useState<"setup" | "recording" | "paused" | "uploading">("setup");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(16).fill(0.08));
  const [error, setError] = useState<string | null>(null);
  const [stills, setStills] = useState<NoteStillInput[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const recorder = useAudioRecorder(RECORD_OPTIONS);
  const cameraRef = useRef<CameraView>(null);
  const pinchStartZoom = useRef(0);
  const recState = useAudioRecorderState(recorder, 80);
  const startingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);

  const releaseRecorder = async () => {
    try {
      if (recorder.isRecording) await recorder.stop();
    } catch {
      // already stopped
    }
    await releaseAudioSession().catch(() => undefined);
  };

  useEffect(() => {
    return () => {
      void releaseRecorder();
    };
  }, []);

  const wallElapsed = () => {
    const extra = startedAtRef.current ? Math.floor((Date.now() - startedAtRef.current) / 1000) : 0;
    return elapsedBeforePauseRef.current + extra;
  };

  useEffect(() => {
    if (phase !== "recording") return;
    setElapsed(wallElapsed());
    const normalized =
      recState.metering != null ? Math.max(0, Math.min(1, (recState.metering + 60) / 60)) : 0.08;
    setLevels((prev) => [...prev.slice(1), normalized]);
  }, [phase, recState.durationMillis, recState.metering]);

  useEffect(() => {
    if (phase !== "recording") return;
    const tick = setInterval(() => setElapsed(wallElapsed()), 1000);
    return () => clearInterval(tick);
  }, [phase]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && phase === "recording") setElapsed(wallElapsed());
    });
    return () => sub.remove();
  }, [phase]);

  useEffect(() => {
    if (elapsed >= LONG_AFTER_SECONDS && durationMode === "short") {
      setDurationMode("long");
    }
  }, [elapsed, durationMode]);

  useEffect(() => {
    if (!cameraOpen || phase !== "recording") return;
    if (recState.isRecording) return;
    try {
      recorder.record();
    } catch {
      // keep the same file; do not re-prepare the session
    }
  }, [cameraOpen, phase, recState.isRecording]);

  const startRecording = async () => {
    if (startingRef.current || phase !== "setup") return;
    startingRef.current = true;
    setError(null);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError("Microphone permission is required to record.");
        return;
      }
      await prepareNoteRecordingSession();
      await recorder.prepareToRecordAsync();
      recorder.record();
      elapsedBeforePauseRef.current = 0;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase("recording");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(
        /not prepared|prepare/i.test(raw)
          ? "Couldn't start the microphone. Leave Talk if it's still connected, then try Start again."
          : raw,
      );
    } finally {
      startingRef.current = false;
    }
  };

  const pauseOrResume = async () => {
    if (phase === "paused") {
      await prepareNoteRecordingSession();
      recorder.record();
      startedAtRef.current = Date.now();
      setPhase("recording");
      return;
    }
    elapsedBeforePauseRef.current = wallElapsed();
    startedAtRef.current = null;
    recorder.pause();
    setPhase("paused");
    setLevels(Array(16).fill(0.08));
  };

  const upload = useMutation({
    mutationFn: async () => {
      if (!recorder.isRecording && phase !== "paused") throw new Error("Nothing to upload.");
      await recorder.stop();
      const uri = recorder.uri;
      await releaseAudioSession().catch(() => undefined);
      if (!uri) throw new Error("Recording produced no file.");
      setPhase("uploading");
      const names = attendees
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const result = await useNoteUpload.getState().begin({
        uri,
        title,
        template,
        attendees: names,
        durationSeconds: elapsed,
        durationMode: elapsed >= LONG_AFTER_SECONDS ? "long" : durationMode,
        stills,
      });
      if (result.noteId) return { noteId: result.noteId, deferred: false };
      if (result.deferred) return { deferred: true };
      throw new Error("The Mac did not return a note.");
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      if (result.noteId) {
        router.replace({ pathname: "/notes/[id]", params: { id: result.noteId } } as unknown as Href);
        return;
      }
      router.replace("/(tabs)/notes" as Href);
    },
    onError: (err) => {
      setError(desktopErrorMessage(err, "Couldn't send that recording to your Mac."));
      setPhase("setup");
    },
  });

  const openCamera = async () => {
    setError(null);
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) {
      setError("Camera permission is required to take pictures during a note.");
      return;
    }
    setZoom(0);
    setCameraOpen(true);
  };

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onBegin(() => {
      pinchStartZoom.current = zoom;
    })
    .onUpdate((event) => {
      setZoom(clampZoom(pinchStartZoom.current + (event.scale - 1) * 0.5));
    });

  const takeStill = async () => {
    if (capturing || !cameraRef.current) return;
    setCapturing(true);
    try {
      const snapped = await cameraRef.current.takePictureAsync({ quality: 0.85, shutterSound: false });
      if (!snapped?.uri) throw new Error("The camera did not return a picture.");
      await saveStillToLibrary(snapped.uri).catch(() => undefined);
      const still = await prepareNoteStill({ uri: snapped.uri, offsetSeconds: wallElapsed() });
      setStills((current) => [...current, still]);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setCameraOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't take that picture.");
    } finally {
      setCapturing(false);
    }
  };

  const busy = phase === "uploading" || upload.isPending;

  return (
    <Backdrop>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.top}>
            <Label>New recording</Label>
            <Pressable
              onPress={() => {
                void releaseRecorder();
                router.back();
              }}
              hitSlop={12}
            >
              <X color={MUTED} size={18} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {phase === "recording" || phase === "paused" ? <RecordingKeepAwake /> : null}

            <View style={styles.chips}>
              <Chip label="Short (<60 min)" active={durationMode === "short"} onPress={() => setDurationMode("short")} />
              <Chip label="Long (tours / 60+ min)" active={durationMode === "long"} onPress={() => setDurationMode("long")} />
            </View>
            {durationMode === "long" ? (
              <Text style={styles.hint}>
                Long notes upload in small pieces so they work from work or cellular, then your Mac transcribes in the background.
              </Text>
            ) : null}
            {phase === "recording" ? (
              <Text style={styles.hint}>
                Keep recording if you lock the phone or switch apps. Snap a slide any time — it goes to Photos and into this note.
              </Text>
            ) : null}
            <View style={styles.chips}>
              {TEMPLATES.map((item) => (
                <Chip
                  key={item.key}
                  label={item.label}
                  active={template === item.key}
                  onPress={() => setTemplate(item.key)}
                />
              ))}
            </View>

            <Field label="Title" value={title} onChangeText={setTitle} placeholder="Optional" />
            <Field
              label="Attendees"
              value={attendees}
              onChangeText={setAttendees}
              placeholder="Comma-separated names"
            />

            {phase === "recording" || phase === "paused" ? (
              <View style={styles.meterBox}>
                <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
                <Text style={styles.phaseLabel}>{phase === "paused" ? "Paused" : "Recording"}</Text>
                <View style={styles.bars}>
                  {levels.map((level, index) => (
                    <View
                      key={index}
                      style={[styles.bar, { height: 8 + level * 36, backgroundColor: phase === "paused" ? FAINT : LIVE }]}
                    />
                  ))}
                </View>
                {stills.length ? (
                  <ScrollView horizontal contentContainerStyle={styles.stillStrip}>
                    {stills.map((still) => (
                      <View key={still.uri} style={styles.stillThumbWrap}>
                        <Image source={{ uri: still.uri }} style={styles.stillThumb} />
                        <Text style={styles.stillStamp}>{formatElapsed(still.offsetSeconds)}</Text>
                      </View>
                    ))}
                  </ScrollView>
                ) : null}
              </View>
            ) : null}

            {error ? <Notice>{error}</Notice> : null}
          </ScrollView>

          <View style={styles.actions}>
            {phase === "setup" ? (
              <Button label="Start recording" onPress={() => startRecording().catch((err) => setError(String(err)))} />
            ) : phase === "recording" || phase === "paused" ? (
              <View style={styles.row}>
                <Pressable onPress={() => pauseOrResume().catch((err) => setError(String(err)))} style={styles.sideBtn}>
                  <Pause color={BONE} size={18} />
                  <Text style={styles.sideText}>{phase === "paused" ? "Resume" : "Pause"}</Text>
                </Pressable>
                <Pressable onPress={() => openCamera().catch((err) => setError(String(err)))} style={styles.sideBtn}>
                  <Camera color={BONE} size={18} />
                  <Text style={styles.sideText}>Photo</Text>
                </Pressable>
                <Pressable onPress={() => upload.mutate()} style={styles.stopBtn}>
                  <Square color={BONE} size={16} />
                  <Text style={styles.sideText}>Stop & send</Text>
                </Pressable>
              </View>
            ) : (
              <Button label="Sending to your Mac…" onPress={() => undefined} disabled loading />
            )}
            {busy ? (
              <Text style={styles.hint}>Sending the recording to your Mac…</Text>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
      <Modal visible={cameraOpen} animationType="fade" presentationStyle="overFullScreen" transparent>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={[styles.cameraScreen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.cameraTop}>
              <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
              <Pressable onPress={() => setCameraOpen(false)} hitSlop={12}>
                <X color={BONE} size={22} />
              </Pressable>
            </View>
            <View style={styles.viewfinder}>
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing="back"
                mode="picture"
                mute
                animateShutter={false}
                zoom={zoom}
              />
              <GestureDetector gesture={pinch}>
                <View style={StyleSheet.absoluteFill} />
              </GestureDetector>
              <View style={styles.zoomBadge}>
                <Text style={styles.zoomBadgeText}>{zoomLabel(zoom)}</Text>
              </View>
            </View>
            <View style={styles.zoomRow}>
              <Pressable
                onPress={() => setZoom((current) => clampZoom(current - ZOOM_STEP))}
                style={styles.zoomBtn}
                hitSlop={8}
              >
                <Minus color={BONE} size={18} />
              </Pressable>
              <Pressable onPress={() => setZoom(0)} style={styles.zoomReset}>
                <Text style={styles.zoomResetText}>{zoom === 0 ? "1×" : "Reset"}</Text>
              </Pressable>
              <Pressable
                onPress={() => setZoom((current) => clampZoom(current + ZOOM_STEP))}
                style={styles.zoomBtn}
                hitSlop={8}
              >
                <Plus color={BONE} size={18} />
              </Pressable>
            </View>
            <Text style={styles.hint}>Pinch or use + / − to frame a slide. Recording keeps going.</Text>
            <Pressable onPress={() => takeStill().catch((err) => setError(String(err)))} style={styles.shutter} disabled={capturing}>
              <View style={styles.shutterInner} />
            </Pressable>
            {capturing ? <Text style={styles.hint}>Saving picture…</Text> : null}
          </View>
        </GestureHandlerRootView>
      </Modal>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20 },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  body: { gap: 14, paddingTop: 18, paddingBottom: 24 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  meterBox: {
    borderWidth: 1,
    borderColor: LINE,
    padding: 16,
    alignItems: "center",
    gap: 8,
  },
  timer: { color: BONE, fontSize: 40, fontVariant: ["tabular-nums"] },
  phaseLabel: { color: FAINT, letterSpacing: 1, textTransform: "uppercase", fontSize: 11 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 48, marginTop: 8 },
  bar: { width: 6, borderRadius: 2 },
  actions: { gap: 10 },
  row: { flexDirection: "row", gap: 10 },
  sideBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: LINE,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  stopBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: LIVE,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  sideText: { color: BONE, fontSize: 15, fontWeight: "600" },
  hint: { color: MUTED, fontSize: 12, textAlign: "center" },
  stillStrip: { gap: 8, paddingTop: 8 },
  stillThumbWrap: { alignItems: "center", gap: 4 },
  stillThumb: { width: 56, height: 56, borderWidth: 1, borderColor: LINE },
  stillStamp: { color: FAINT, fontSize: 10, fontVariant: ["tabular-nums"] },
  cameraScreen: { flex: 1, backgroundColor: "#0A0B0D", paddingHorizontal: 20, gap: 12 },
  cameraTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  viewfinder: { flex: 1, overflow: "hidden", backgroundColor: "#111317" },
  zoomBadge: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "rgba(10, 11, 13, 0.7)",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  zoomBadgeText: { color: BONE, fontSize: 13, fontVariant: ["tabular-nums"] },
  zoomRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12 },
  zoomBtn: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: LINE,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomReset: { minWidth: 72, alignItems: "center", paddingVertical: 8 },
  zoomResetText: { color: BONE, fontSize: 14, fontWeight: "600" },
  shutter: {
    alignSelf: "center",
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    borderColor: BONE,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: BONE },
});
