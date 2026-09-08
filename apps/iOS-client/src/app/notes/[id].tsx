import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Pause, Play } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  BONE,
  BRASS,
  Card,
  FAINT,
  Label,
  LINE,
  Loading,
  MUTED,
  Notice,
} from "@/components/ui";
import {
  desktopErrorMessage,
  getAudioNote,
  retryAudioNoteDetails,
  retryAudioNoteTranscript,
} from "@/lib/desktop-api";
import { prepareNotePlaybackSession } from "@/lib/audio";
import { playableNoteAudio } from "@/lib/note-audio";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [playBusy, setPlayBusy] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [loadedUri, setLoadedUri] = useState<string | null>(null);

  const note = useQuery({
    queryKey: ["notes", id],
    queryFn: () => getAudioNote(id!),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.processingStatus === "processing" ? 4000 : false,
  });

  useEffect(() => {
    if (note.data?.processingStatus && note.data.processingStatus !== "processing") {
      queryClient.invalidateQueries({ queryKey: ["notes", "list"] });
    }
  }, [note.data?.processingStatus, queryClient]);

  const retryDetails = useMutation({
    mutationFn: () => retryAudioNoteDetails(id!),
    onSuccess: (next) => {
      queryClient.setQueryData(["notes", id], next);
      queryClient.invalidateQueries({ queryKey: ["notes", "list"] });
    },
  });

  const retryTranscript = useMutation({
    mutationFn: () => retryAudioNoteTranscript(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes", id] });
      queryClient.invalidateQueries({ queryKey: ["notes", "list"] });
    },
  });

  const togglePlayback = async () => {
    if (!id || playBusy) return;
    try {
      setPlayError(null);
      if (playback.playing) {
        player.pause();
        return;
      }
      if (loadedUri) {
        await prepareNotePlaybackSession();
        player.play();
        return;
      }
      setPlayBusy(true);
      const source = await playableNoteAudio(id);
      await prepareNotePlaybackSession();
      player.replace({ uri: source.uri });
      setLoadedUri(source.uri);
      player.play();
    } catch (err) {
      setPlayError(err instanceof Error ? err.message : "Couldn't play that recording.");
    } finally {
      setPlayBusy(false);
    }
  };

  const data = note.data;

  return (
    <Backdrop>
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
            <ChevronLeft color={BRASS} size={22} />
            <Text style={styles.backText}>Notes</Text>
          </Pressable>
        </View>

        {note.isLoading ? (
          <Loading />
        ) : note.isError ? (
          <Notice>{desktopErrorMessage(note.error, "Couldn't load that note.")}</Notice>
        ) : !data ? (
          <Notice>That note is not on this Mac.</Notice>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
            <Animated.View entering={FadeIn} style={styles.body}>
              <Label>{data.template}</Label>
              <Text style={styles.title}>{data.title}</Text>
              <Text style={styles.meta}>{data.processingStatus}</Text>
              {data.processingStatus === "processing" ? (
                <Notice>
                  {data.job
                    ? `${data.job.message} · ${data.job.progress}%`
                    : "Your Mac is transcribing this in the background. You can leave — the recording is already saved."}
                </Notice>
              ) : null}
              {data.processingStatus === "failed" ? (
                <Notice>
                  {data.job?.error || "Transcription failed. Retry transcript to try again."}
                </Notice>
              ) : null}

              <Pressable onPress={togglePlayback} style={styles.play} disabled={playBusy}>
                {playback.playing ? <Pause color={BONE} size={18} /> : <Play color={BONE} size={18} />}
                <Text style={styles.playText}>
                  {playBusy ? "Loading recording…" : playback.playing ? "Pause recording" : "Play recording"}
                </Text>
              </Pressable>
              {playError ? <Notice>{playError}</Notice> : null}

              <View style={styles.grid}>
                <Box title="Summary" wide>
                  <Text style={styles.copy}>{data.summary || "No summary yet."}</Text>
                </Box>
                <Box title="Key Takeaways">
                  <Bullets items={data.takeaways} empty="None" />
                </Box>
                <Box title="Action Items">
                  <Bullets
                    items={data.nextSteps.map((step) => {
                      const extra = [step.assignee && `→ ${step.assignee}`, step.dueDate]
                        .filter(Boolean)
                        .join("  ");
                      return extra ? `${step.text}  ${extra}` : step.text;
                    })}
                    empty="None"
                  />
                </Box>
                <Box title="Open Questions">
                  <Bullets items={data.openQuestions} empty="None" />
                </Box>
                <Box title="Attendees">
                  <Bullets items={data.attendees.map((a) => a.name)} empty="None" />
                </Box>
                <Box title="Transcript" wide>
                  <Text style={styles.copy}>{data.transcript || "No transcript yet."}</Text>
                </Box>
              </View>

              <View style={styles.actions}>
                <Pressable
                  onPress={() => retryDetails.mutate()}
                  disabled={retryDetails.isPending}
                  style={styles.action}
                >
                  <Text style={styles.actionText}>
                    {retryDetails.isPending ? "Working…" : "Retry details"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => retryTranscript.mutate()}
                  disabled={retryTranscript.isPending}
                  style={styles.action}
                >
                  <Text style={styles.actionText}>
                    {retryTranscript.isPending ? "Working…" : "Retry transcript"}
                  </Text>
                </Pressable>
              </View>
            </Animated.View>
          </ScrollView>
        )}
      </View>
    </Backdrop>
  );
}

function Box({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Card style={wide ? styles.wide : undefined}>
      <Text style={styles.boxTitle}>{title}</Text>
      {children}
    </Card>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <Text style={styles.faint}>{empty}</Text>;
  return (
    <View style={styles.bullets}>
      {items.map((item) => (
        <Text key={item} style={styles.copy}>
          • {item}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20 },
  topBar: { marginBottom: 12 },
  back: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { color: BRASS, fontSize: 16 },
  body: { gap: 12 },
  title: { color: BONE, fontSize: 32, lineHeight: 38, fontWeight: "600" },
  meta: { color: FAINT, fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase" },
  play: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: LINE,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  playText: { color: BONE, fontSize: 14 },
  grid: { gap: 10 },
  wide: {},
  boxTitle: {
    color: BRASS,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  copy: { color: BONE, fontSize: 15, lineHeight: 22 },
  faint: { color: MUTED, fontSize: 14 },
  bullets: { gap: 6 },
  actions: { flexDirection: "row", gap: 10, marginTop: 8 },
  action: { borderWidth: 1, borderColor: LINE, paddingHorizontal: 12, paddingVertical: 8 },
  actionText: { color: BRASS, fontSize: 13, letterSpacing: 0.4, textTransform: "uppercase" },
});
