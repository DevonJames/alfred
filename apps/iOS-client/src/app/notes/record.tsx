import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { router, type Href } from "expo-router";
import { Pause, Square, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
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
import { useNoteUpload } from "@/lib/note-upload";
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

  const recorder = useAudioRecorder(RECORD_OPTIONS);
  const recState = useAudioRecorderState(recorder, 80);
  const startingRef = useRef(false);
  const armedRef = useRef(false);
  const resumingRef = useRef(false);

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

  useEffect(() => {
    if (phase !== "recording") return;
    setElapsed(Math.max(0, Math.floor(recState.durationMillis / 1000)));
    const normalized =
      recState.metering != null ? Math.max(0, Math.min(1, (recState.metering + 60) / 60)) : 0.08;
    setLevels((prev) => [...prev.slice(1), normalized]);
  }, [phase, recState.durationMillis, recState.metering]);

  useEffect(() => {
    if (elapsed >= LONG_AFTER_SECONDS && durationMode === "short") {
      setDurationMode("long");
    }
  }, [elapsed, durationMode]);

  const lastResumeAt = useRef(0);
  const resumeNativeRecording = async () => {
    if (resumingRef.current || phase !== "recording") return;
    if (recorder.isRecording && !recState.mediaServicesDidReset) return;
    if (Date.now() - lastResumeAt.current < 3000) return;
    lastResumeAt.current = Date.now();
    resumingRef.current = true;
    try {
      await prepareNoteRecordingSession();
      recorder.record();
    } catch {
      setPhase("paused");
      setError("Recording paused when another app took the microphone. Tap Resume.");
    } finally {
      resumingRef.current = false;
    }
  };

  useEffect(() => {
    if (phase !== "recording") {
      armedRef.current = false;
      return;
    }
    const wait = setTimeout(() => {
      armedRef.current = true;
    }, 1000);
    return () => clearTimeout(wait);
  }, [phase]);

  useEffect(() => {
    if (phase !== "recording" || !armedRef.current) return;
    if (recState.isRecording && !recState.mediaServicesDidReset) return;
    void resumeNativeRecording();
  }, [phase, recState.isRecording, recState.mediaServicesDidReset]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active" || phase !== "recording") return;
      void resumeNativeRecording();
    });
    return () => sub.remove();
  }, [phase]);

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
      recorder.record();
      setPhase("recording");
      return;
    }
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
});
