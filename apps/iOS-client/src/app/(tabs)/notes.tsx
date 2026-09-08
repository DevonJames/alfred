import { useQuery } from "@tanstack/react-query";
import { router, type Href } from "expo-router";
import { useEffect } from "react";
import { Plus } from "lucide-react-native";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  BONE,
  BRASS,
  Card,
  ConnectionPill,
  Display,
  Empty,
  FAINT,
  INK,
  Label,
  MUTED,
  Loading,
  Notice,
} from "@/components/ui";
import { useConnection } from "@/lib/connection";
import { desktopErrorMessage, listAudioNotes } from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import { useNoteUpload } from "@/lib/note-upload";
import type { AudioNote } from "@/lib/types";

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function NotesTab() {
  const insets = useSafeAreaInsets();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const connected = useConnection((s) => Boolean(s.serverUrl));
  const upload = useNoteUpload((s) => s.current);

  const notes = useQuery({
    queryKey: ["notes", "list"],
    queryFn: () => listAudioNotes(),
    enabled: connected,
    refetchInterval: (query) =>
      query.state.data?.some((note) => note.processingStatus === "processing") ? 4000 : false,
  });

  useEffect(() => {
    if (upload?.status !== "done" || !upload.noteId) return;
    notes.refetch().catch(() => undefined);
    const noteId = upload.noteId;
    void useNoteUpload.getState().clear();
    router.push({ pathname: "/notes/[id]", params: { id: noteId } } as unknown as Href);
  }, [upload?.status, upload?.noteId, notes]);

  return (
    <Backdrop>
      <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
        <View style={styles.header}>
          <View>
            <Label>Notes</Label>
            <Display>Recordings</Display>
          </View>
          <View style={styles.headerRight}>
            <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
            <Pressable
              onPress={() => router.push("/notes/record" as Href)}
              style={styles.captureBtn}
              disabled={!connected}
            >
              <Plus color={INK} size={18} />
            </Pressable>
          </View>
        </View>

        {upload && upload.status !== "done" ? (
          <Notice tone={upload.status === "error" ? "error" : "info"}>
            {upload.status === "error"
              ? upload.error || "Upload paused. It will retry when your Mac is reachable."
              : `${upload.message}${upload.filename ? ` · ${upload.filename}` : ""}`}
          </Notice>
        ) : null}

        {!connected ? (
          <Notice tone="info">Find your Mac to record and see audio notes.</Notice>
        ) : notes.isLoading ? (
          <Loading />
        ) : notes.isError ? (
          <Notice>{desktopErrorMessage(notes.error, "Couldn't reach your Mac for notes.")}</Notice>
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingBottom: insets.bottom + 28, gap: 12 }}
            refreshControl={
              <RefreshControl
                refreshing={notes.isRefetching}
                onRefresh={() => notes.refetch()}
                tintColor={BRASS}
              />
            }
          >
            {(notes.data?.length ?? 0) === 0 ? (
              <Empty
                title="No audio notes yet"
                detail="Record a short or long note here, or upload one from the Notes tab on your Mac."
              />
            ) : (
              <Animated.View entering={FadeIn} style={styles.list}>
                {notes.data!.map((note, index) => (
                  <Animated.View key={note.id} entering={FadeInDown.delay(index * 40)}>
                    <NoteRow note={note} />
                  </Animated.View>
                ))}
              </Animated.View>
            )}
          </ScrollView>
        )}
      </View>
    </Backdrop>
  );
}

function NoteRow({ note }: { note: AudioNote }) {
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: "/notes/[id]", params: { id: note.id } } as unknown as Href)
      }
    >
      <Card>
        <Text style={styles.title}>{note.title}</Text>
        <Text style={styles.meta}>
          {note.template} · {note.processingStatus}
          {note.createdAt ? ` · ${formatWhen(note.createdAt)}` : ""}
        </Text>
        {note.processingStatus === "processing" && note.job ? (
          <Text style={styles.progress}>
            {note.job.message} · {note.job.progress}%
          </Text>
        ) : null}
        {note.summary ? (
          <Text style={styles.summary} numberOfLines={3}>
            {note.summary}
          </Text>
        ) : note.processingStatus === "processing" && note.transcript ? (
          <Text style={styles.summary} numberOfLines={3}>
            {note.transcript}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
  },
  headerRight: { alignItems: "flex-end", gap: 10 },
  captureBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: BRASS,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { gap: 12 },
  title: { color: BONE, fontSize: 18, fontWeight: "600" },
  meta: { color: FAINT, fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase", marginTop: 4 },
  progress: { color: BRASS, fontSize: 13, marginTop: 8 },
  summary: { color: MUTED, fontSize: 14, lineHeight: 20, marginTop: 8 },
});
