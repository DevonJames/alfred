/**
 * Memory detail (§12.3, §11.1.2, §11.1.6).
 *
 * Shows the current reading of a memory *and* how it got there: every revision,
 * what superseded what, and which artifacts back each claim. Corrections append
 * — nothing here ever edits history in place.
 *
 * Text colors use StyleSheet — NativeWind className-only color often resolves
 * to black on this build and leaves cards unreadable.
 */
import { useQuery } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { Image } from "expo-image";
import { Link, Stack, router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, FileText, Pause, Pencil, Play, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  BONE,
  Body,
  BRASS,
  Button,
  Card,
  ConfidenceTag,
  Display,
  Empty,
  FAINT,
  FromPhone,
  Label,
  LINE,
  Loading,
  MUTED,
  Sheet,
  WARN,
} from "@/components/ui";
import { assetHeaders, assetUrl, desktopErrorMessage, getProvenance, isNotBuiltYet } from "@/lib/desktop-api";
import { describeCopy, recallOne } from "@/lib/recall";
import type { ArtifactRef, AssertionRef } from "@/lib/types";

function formatRevision(revision: number | undefined): string {
  if (
    revision == null ||
    !Number.isFinite(revision) ||
    revision <= 1 ||
    revision >= 10_000
  ) {
    return "";
  }
  return ` · revision ${revision}`;
}

export default function MemoryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [provenanceFor, setProvenanceFor] = useState<string | null>(null);

  const memory = useQuery({
    queryKey: ["memory", id],
    queryFn: () => recallOne(id),
    enabled: Boolean(id),
  });

  const provenance = useQuery({
    queryKey: ["provenance", provenanceFor],
    queryFn: () => getProvenance(provenanceFor!),
    enabled: Boolean(provenanceFor),
  });

  const pkg = memory.data?.data.memory;
  const fromPhone = memory.data?.source === "phone";
  const current = pkg?.assertions.filter((a) => a.current) ?? [];
  const history = pkg?.assertions.filter((a) => !a.current) ?? [];

  return (
    <Backdrop>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <View style={styles.topBar}>
          <Pressable
            testID="detail-back"
            onPress={() => router.back()}
            style={styles.iconBtn}
          >
            <ChevronLeft color={BONE} size={22} />
          </Pressable>
          {pkg ? (
            <View style={[styles.actions, fromPhone && { opacity: 0.3 }]}>
              <Pressable
                testID="open-correct"
                disabled={fromPhone}
                onPress={() => router.push({ pathname: "/correct", params: { id: pkg.id } })}
                style={styles.iconBtnBordered}
              >
                <Pencil color={BRASS} size={17} />
              </Pressable>
              <Pressable
                testID="open-forget"
                disabled={fromPhone}
                onPress={() => router.push({ pathname: "/forget", params: { id: pkg.id } })}
                style={styles.iconBtnBordered}
              >
                <Trash2 color="#E2574C" size={17} />
              </Pressable>
            </View>
          ) : null}
        </View>

        {memory.isLoading ? <Loading /> : null}
        {memory.isError ? (
          <Empty
            testID="detail-error"
            title={
              isNotBuiltYet(memory.error)
                ? "This memory isn't available yet"
                : "I can't reach that right now"
            }
            detail={desktopErrorMessage(
              memory.error,
              "Your Mac isn't answering. Nothing has been lost — it's all still there."
            )}
          />
        ) : null}

        {pkg ? (
          <ScrollView
            testID="memory-detail-screen"
            style={styles.scroll}
            contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
            showsVerticalScrollIndicator={false}
          >
            {fromPhone ? (
              <View style={styles.block}>
                <FromPhone
                  testID="detail-from-phone"
                  detail={`${describeCopy(memory.data?.cachedAt ?? null)} Corrections and forgetting need your Mac, so they're unavailable until it's back.`}
                />
              </View>
            ) : null}

            <Animated.View entering={FadeInDown.duration(300)} style={styles.block}>
              <Label>
                {pkg.entityType ?? pkg.kind}
                {formatRevision(pkg.revision)}
              </Label>
              <Display style={styles.title}>{pkg.title}</Display>
              {pkg.summary ? <Text style={styles.summary}>{pkg.summary}</Text> : null}
              <View style={styles.tagRow}>
                <ConfidenceTag value={pkg.confidence} />
                {pkg.visibility === "public" ? (
                  <Text style={styles.warnText}>Marked public on your Mac</Text>
                ) : null}
              </View>
            </Animated.View>

            {pkg.needsResolution.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(80)} style={styles.section}>
                <Card style={styles.warnCard} testID="needs-resolution-card">
                  <Text style={styles.warnLabel}>I wasn't sure about this</Text>
                  {pkg.needsResolution.map((item) => (
                    <View key={item.field} style={styles.needItem}>
                      <Body>{item.question}</Body>
                      <Text style={styles.faint}>
                        Until you tell me, I've kept it as you said it rather than guessing.
                      </Text>
                    </View>
                  ))}
                  <Button
                    testID="resolve-ambiguity"
                    variant="ghost"
                    label="Clear this up"
                    onPress={() => router.push({ pathname: "/correct", params: { id: pkg.id } })}
                  />
                </Card>
              </Animated.View>
            ) : null}

            {pkg.reminder ? (
              <Animated.View entering={FadeInDown.delay(100)} style={styles.section}>
                <Card testID="reminder-card">
                  <Label>Reminder</Label>
                  <Body>
                    {new Date(pkg.reminder.dueAt).toLocaleString(undefined, {
                      dateStyle: "full",
                      ...(pkg.reminder.dateOnly ? {} : { timeStyle: "short" }),
                    })}
                  </Body>
                  <Text style={styles.faint}>
                    {pkg.reminder.status === "pending" ? "I'll bring this up" : pkg.reminder.status}
                  </Text>
                </Card>
              </Animated.View>
            ) : null}

            <View style={styles.section}>
              <Label>What I remember</Label>
              <View style={styles.stack}>
                {current.map((assertion) => (
                  <AssertionCard
                    key={assertion.id}
                    assertion={assertion}
                    onProvenance={() => setProvenanceFor(assertion.id)}
                  />
                ))}
                {current.length === 0 ? (
                  <Text style={styles.muted}>
                    Nothing extracted yet — the raw note is still saved.
                  </Text>
                ) : null}
              </View>
            </View>

            {history.length > 0 ? (
              <View style={styles.section}>
                <Label>What I used to think</Label>
                <Text style={styles.faint}>
                  Corrections are added, never overwritten. The old reading stays visible.
                </Text>
                <View style={styles.stack}>
                  {history.map((assertion) => (
                    <AssertionCard
                      key={assertion.id}
                      assertion={assertion}
                      superseded
                      onProvenance={() => setProvenanceFor(assertion.id)}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {pkg.artifacts.length > 0 ? (
              <View style={styles.section}>
                <Label>Attached</Label>
                <View style={styles.stack}>
                  {pkg.artifacts.map((artifact) => (
                    <MemoryArtifactCard key={artifact.id} artifact={artifact} />
                  ))}
                </View>
              </View>
            ) : null}

            {pkg.related.length > 0 ? (
              <View style={styles.section}>
                <Label>Connected to</Label>
                <View style={styles.stack}>
                  {pkg.related.map((related) => (
                    <Link
                      key={`${related.id}-${related.relation}`}
                      href={{ pathname: "/memory/[id]", params: { id: related.id } }}
                      asChild
                    >
                      <Pressable testID={`related-${related.id}`} style={styles.relatedTap}>
                        <Card style={styles.relatedCard}>
                          <Text style={styles.relatedTitle}>{related.title}</Text>
                          <Text style={styles.relatedRel}>{related.relation}</Text>
                        </Card>
                      </Pressable>
                    </Link>
                  ))}
                </View>
              </View>
            ) : null}

            <Text style={styles.footer}>
              Remembered{" "}
              {new Date(pkg.createdAt).toLocaleDateString(undefined, { dateStyle: "long" })}
            </Text>
          </ScrollView>
        ) : null}
      </View>

      <Sheet
        testID="provenance-sheet"
        visible={Boolean(provenanceFor)}
        title="Where this came from"
        onClose={() => setProvenanceFor(null)}
      >
        {provenance.isLoading ? <Loading /> : null}

        {provenance.isError ? (
          <View style={styles.sheetBlock} testID="provenance-offline">
            <FromPhone detail="I can only trace the full chain when your Mac is reachable. This is what this phone has." />
            {(() => {
              const cached = pkg?.assertions.find((a) => a.id === provenanceFor);
              if (!cached) return null;
              return (
                <View style={styles.sheetSection}>
                  <Label>The claim</Label>
                  <Body>{cached.text}</Body>
                  <Text style={styles.faint}>
                    Revision {formatAssertionRevision(cached.revision)} · from {cached.sourceKind}
                    {cached.supersedes ? " · replaced an earlier reading" : ""}
                  </Text>
                </View>
              );
            })()}
          </View>
        ) : null}

        {provenance.data ? (
          <View style={styles.sheetBlock}>
            <View style={styles.sheetSection}>
              <Label>The claim</Label>
              <Body>{provenance.data.assertion.text}</Body>
              <Text style={styles.faint}>
                Revision {formatAssertionRevision(provenance.data.assertion.revision)} · from{" "}
                {provenance.data.assertion.sourceKind}
              </Text>
            </View>

            {provenance.data.supersedes ? (
              <View style={styles.sheetSection}>
                <Label>Replaced</Label>
                <Text style={styles.struck}>{provenance.data.supersedes.text}</Text>
              </View>
            ) : null}

            {provenance.data.supersededBy ? (
              <View style={styles.sheetSection}>
                <Label>Since replaced by</Label>
                <Body>{provenance.data.supersededBy.text}</Body>
              </View>
            ) : null}

            <View style={styles.sheetSection}>
              <Label>Backed by</Label>
              {provenance.data.artifacts.length === 0 ? (
                <Text style={styles.muted}>
                  You told me this directly — there's no file behind it.
                </Text>
              ) : (
                provenance.data.artifacts.map((artifact) => (
                  <Text key={artifact.id} style={styles.muted}>
                    {artifact.filename}
                    {artifact.present ? "" : " (forgotten)"}
                  </Text>
                ))
              )}
            </View>

            {provenance.data.relatedEntities.length > 0 ? (
              <View style={styles.sheetSection}>
                <Label>Mentions</Label>
                {provenance.data.relatedEntities.map((entity) => (
                  <Text key={entity.id} style={styles.muted}>
                    {entity.title} · {entity.relation}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Backdrop>
  );
}

function isAudioArtifact(artifact: ArtifactRef): boolean {
  return artifact.mimeType.startsWith("audio/");
}

function MemoryArtifactCard({ artifact }: { artifact: ArtifactRef }) {
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    return () => {
      sound?.unloadAsync().catch(() => undefined);
    };
  }, [sound]);

  const togglePlayback = async () => {
    if (!artifact.available) return;
    const uri = assetUrl(artifact.url);
    if (!uri) return;
    if (sound) {
      const status = await sound.getStatusAsync();
      if (status.isLoaded && status.isPlaying) {
        await sound.pauseAsync();
        setPlaying(false);
        return;
      }
      await sound.playAsync();
      setPlaying(true);
      return;
    }
    const created = await Audio.Sound.createAsync(
      { uri, headers: assetHeaders() },
      { shouldPlay: true },
    );
    created.sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) setPlaying(false);
    });
    setSound(created.sound);
    setPlaying(true);
  };

  return (
    <Card testID={`artifact-${artifact.id}`}>
      {artifact.mimeType.startsWith("image/") && artifact.available ? (
        <Image
          source={{
            uri: assetUrl(artifact.url) ?? undefined,
            headers: assetHeaders(),
          }}
          style={styles.artifactImage}
          contentFit="cover"
          transition={200}
        />
      ) : isAudioArtifact(artifact) && artifact.available ? (
        <Pressable onPress={togglePlayback} style={styles.play} testID={`artifact-play-${artifact.id}`}>
          {playing ? <Pause color={BONE} size={16} /> : <Play color={BONE} size={16} />}
          <Text style={styles.playText}>
            {playing ? "Pause recording" : "Play recording"}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.artifactRow}>
          <FileText color={MUTED} size={16} />
          <Text style={styles.muted}>{artifact.filename}</Text>
        </View>
      )}
      <Text style={styles.faint}>
        {artifact.available
          ? `${artifact.filename} · ${artifact.hashAlgorithm}:${artifact.hash.slice(0, 12)}…`
          : "This file was forgotten. What I learned from it remains."}
      </Text>
    </Card>
  );
}

function formatAssertionRevision(revision: number): string {
  if (!Number.isFinite(revision) || revision < 1 || revision >= 10_000) return "1";
  return String(revision);
}

function AssertionCard({
  assertion,
  superseded,
  onProvenance,
}: {
  assertion: AssertionRef;
  superseded?: boolean;
  onProvenance: () => void;
}) {
  return (
    <Animated.View entering={FadeIn}>
      <Pressable testID={`assertion-${assertion.id}`} onPress={onProvenance} style={styles.relatedTap}>
        <Card style={superseded ? styles.supersededCard : undefined}>
          <Text style={[styles.assertionText, superseded && styles.struck]}>{assertion.text}</Text>
          <View style={styles.assertionFooter}>
            <ConfidenceTag value={assertion.confidence} />
            <Text style={styles.whereFrom}>Where from?</Text>
          </View>
        </Card>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnBordered: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: LINE,
  },
  scroll: {
    flex: 1,
    paddingHorizontal: 20,
  },
  block: {
    marginTop: 16,
  },
  section: {
    marginTop: 28,
  },
  stack: {
    marginTop: 12,
    gap: 10,
  },
  title: {
    marginTop: 8,
  },
  summary: {
    marginTop: 12,
    color: MUTED,
    fontSize: 16,
    lineHeight: 22,
  },
  tagRow: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warnText: {
    color: WARN,
    fontSize: 12,
  },
  warnLabel: {
    color: WARN,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  warnCard: {
    borderColor: "rgba(224,164,88,0.4)",
    backgroundColor: "rgba(224,164,88,0.06)",
  },
  needItem: {
    marginTop: 12,
  },
  assertionText: {
    color: BONE,
    fontSize: 16,
    lineHeight: 22,
  },
  assertionFooter: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  whereFrom: {
    color: BRASS,
    fontSize: 12,
  },
  supersededCard: {
    opacity: 0.7,
  },
  struck: {
    color: FAINT,
    textDecorationLine: "line-through",
  },
  artifactImage: {
    width: "100%",
    height: 180,
    borderRadius: 12,
  },
  artifactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
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
  playText: {
    color: BONE,
    fontSize: 14,
  },
  relatedTap: {
    opacity: 1,
  },
  relatedCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    gap: 12,
  },
  relatedTitle: {
    flex: 1,
    color: BONE,
    fontSize: 14,
    lineHeight: 20,
  },
  relatedRel: {
    color: FAINT,
    fontSize: 12,
  },
  muted: {
    color: MUTED,
    fontSize: 14,
    lineHeight: 20,
  },
  faint: {
    marginTop: 6,
    color: FAINT,
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    marginTop: 36,
    color: FAINT,
    fontSize: 12,
  },
  sheetBlock: {
    gap: 16,
    paddingBottom: 16,
  },
  sheetSection: {
    gap: 6,
  },
});
