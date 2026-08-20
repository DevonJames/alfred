/**
 * Memory detail (§12.3, §11.1.2, §11.1.6).
 *
 * Shows the current reading of a memory *and* how it got there: every revision,
 * what superseded what, and which artifacts back each claim. Corrections append
 * — nothing here ever edits history in place.
 */
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Link, Stack, router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, FileText, Pencil, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  Body,
  Button,
  Card,
  ConfidenceTag,
  Display,
  Empty,
  FromPhone,
  Label,
  Loading,
  Sheet,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { assetHeaders, assetUrl, getProvenance } from "@/lib/desktop-api";
import { describeCopy, recallOne } from "@/lib/recall";
import type { AssertionRef } from "@/lib/types";

export default function MemoryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [provenanceFor, setProvenanceFor] = useState<string | null>(null);

  // /episode resolves any package id — entity, episode or note. Falls back to
  // this phone's copy of the record when the Mac can't be reached (§11.3).
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
      <View className="flex-1" style={{ paddingTop: insets.top + 8 }}>
        <View className="flex-row items-center justify-between px-4">
          <Pressable
            testID="detail-back"
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full active:opacity-60"
          >
            <ChevronLeft color="#F4F1EA" size={22} />
          </Pressable>
          {/* Correcting and forgetting are writes. They belong to the Mac, so
              they go quiet while we're reading off the phone's copy. */}
          {pkg ? (
            <View className={cn("flex-row space-x-2", fromPhone && "opacity-30")}>
              <Pressable
                testID="open-correct"
                disabled={fromPhone}
                onPress={() => router.push({ pathname: "/correct", params: { id: pkg.id } })}
                className="h-10 w-10 items-center justify-center rounded-full border border-line active:opacity-60"
              >
                <Pencil color="#D8A54A" size={17} />
              </Pressable>
              <Pressable
                testID="open-forget"
                disabled={fromPhone}
                onPress={() => router.push({ pathname: "/forget", params: { id: pkg.id } })}
                className="h-10 w-10 items-center justify-center rounded-full border border-line active:opacity-60"
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
            title="I can't reach that right now"
            detail="Your Mac isn't answering. Nothing has been lost — it's all still there."
          />
        ) : null}

        {pkg ? (
          <ScrollView
            testID="memory-detail-screen"
            className="flex-1 px-5"
            contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
            showsVerticalScrollIndicator={false}
          >
            {fromPhone ? (
              <View className="mt-4">
                <FromPhone
                  testID="detail-from-phone"
                  detail={`${describeCopy(memory.data?.cachedAt ?? null)} Corrections and forgetting need your Mac, so they're unavailable until it's back.`}
                />
              </View>
            ) : null}

            <Animated.View entering={FadeInDown.duration(300)} className="mt-4">
              <Label>
                {pkg.entityType ?? pkg.kind}
                {pkg.revision > 1 ? ` · revision ${pkg.revision}` : ""}
              </Label>
              <Display className="mt-2">{pkg.title}</Display>
              {pkg.summary ? (
                <Text className="mt-3 text-base leading-[22px] text-muted">{pkg.summary}</Text>
              ) : null}
              <View className="mt-4 flex-row items-center space-x-2">
                <ConfidenceTag value={pkg.confidence} />
                {pkg.visibility === "public" ? (
                  <Text className="text-xs text-warn">Marked public on your Mac</Text>
                ) : null}
              </View>
            </Animated.View>

            {pkg.needsResolution.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(80)} className="mt-6">
                <Card className="border-warn/40 bg-warn/5" testID="needs-resolution-card">
                  <Label className="text-warn">I wasn't sure about this</Label>
                  {pkg.needsResolution.map((item) => (
                    <View key={item.field} className="mt-3">
                      <Body>{item.question}</Body>
                      <Text className="mt-1 text-xs text-faint">
                        Until you tell me, I've kept it as you said it rather than guessing.
                      </Text>
                    </View>
                  ))}
                  <Button
                    testID="resolve-ambiguity"
                    className="mt-4 h-11"
                    variant="ghost"
                    label="Clear this up"
                    onPress={() => router.push({ pathname: "/correct", params: { id: pkg.id } })}
                  />
                </Card>
              </Animated.View>
            ) : null}

            {pkg.reminder ? (
              <Animated.View entering={FadeInDown.delay(100)} className="mt-6">
                <Card testID="reminder-card">
                  <Label>Reminder</Label>
                  <Body className="mt-2">
                    {new Date(pkg.reminder.dueAt).toLocaleString(undefined, {
                      dateStyle: "full",
                      ...(pkg.reminder.dateOnly ? {} : { timeStyle: "short" }),
                    })}
                  </Body>
                  <Text className="mt-1 text-xs text-faint">
                    {pkg.reminder.status === "pending" ? "I'll bring this up" : pkg.reminder.status}
                  </Text>
                </Card>
              </Animated.View>
            ) : null}

            <View className="mt-8">
              <Label>What I remember</Label>
              <View className="mt-3 space-y-3">
                {current.map((assertion) => (
                  <AssertionCard
                    key={assertion.id}
                    assertion={assertion}
                    onProvenance={() => setProvenanceFor(assertion.id)}
                  />
                ))}
                {current.length === 0 ? (
                  <Text className="text-sm text-faint">
                    Nothing extracted yet — the raw note is still saved.
                  </Text>
                ) : null}
              </View>
            </View>

            {history.length > 0 ? (
              <View className="mt-8">
                <Label>What I used to think</Label>
                <Text className="mt-1 text-xs leading-4 text-faint">
                  Corrections are added, never overwritten. The old reading stays visible.
                </Text>
                <View className="mt-3 space-y-3">
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
              <View className="mt-8">
                <Label>Attached</Label>
                <View className="mt-3 space-y-3">
                  {pkg.artifacts.map((artifact) => (
                    <Card key={artifact.id} testID={`artifact-${artifact.id}`}>
                      {artifact.mimeType.startsWith("image/") && artifact.available ? (
                        <Image
                          source={{
                            uri: assetUrl(artifact.url) ?? undefined,
                            headers: assetHeaders(),
                          }}
                          style={{ width: "100%", height: 180, borderRadius: 12 }}
                          contentFit="cover"
                          transition={200}
                        />
                      ) : (
                        <View className="flex-row items-center space-x-2">
                          <FileText color="#8D939E" size={16} />
                          <Text className="text-sm text-muted">{artifact.filename}</Text>
                        </View>
                      )}
                      <Text className="mt-2 text-xs text-faint">
                        {artifact.available
                          ? `${artifact.hashAlgorithm}:${artifact.hash.slice(0, 12)}…`
                          : "This file was forgotten. What I learned from it remains."}
                      </Text>
                    </Card>
                  ))}
                </View>
              </View>
            ) : null}

            {pkg.related.length > 0 ? (
              <View className="mt-8">
                <Label>Connected to</Label>
                <View className="mt-3 space-y-2">
                  {pkg.related.map((related) => (
                    <Link
                      key={`${related.id}-${related.relation}`}
                      href={{ pathname: "/memory/[id]", params: { id: related.id } }}
                      asChild
                    >
                      <Pressable testID={`related-${related.id}`} className="active:opacity-60">
                        <Card className="flex-row items-center justify-between py-3">
                          <Text className="flex-1 pr-3 text-sm text-bone">{related.title}</Text>
                          <Text className="text-xs text-faint">{related.relation}</Text>
                        </Card>
                      </Pressable>
                    </Link>
                  ))}
                </View>
              </View>
            ) : null}

            <Text className="mt-10 text-xs text-faint">
              Remembered {new Date(pkg.createdAt).toLocaleDateString(undefined, { dateStyle: "long" })}
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

        {/* The chain — what superseded what, which file backs which claim —
            lives in the graph on the Mac. The phone's copy holds the claim
            itself, so show that much and be clear about the rest. */}
        {provenance.isError ? (
          <View className="space-y-4 pb-4" testID="provenance-offline">
            <FromPhone detail="I can only trace the full chain when your Mac is reachable. This is what this phone has." />
            {(() => {
              const cached = pkg?.assertions.find((a) => a.id === provenanceFor);
              if (!cached) return null;
              return (
                <View>
                  <Label>The claim</Label>
                  <Body className="mt-2">{cached.text}</Body>
                  <Text className="mt-1 text-xs text-faint">
                    Revision {cached.revision} · from {cached.sourceKind}
                    {cached.supersedes ? " · replaced an earlier reading" : ""}
                  </Text>
                </View>
              );
            })()}
          </View>
        ) : null}

        {provenance.data ? (
          <View className="space-y-4 pb-4">
            <View>
              <Label>The claim</Label>
              <Body className="mt-2">{provenance.data.assertion.text}</Body>
              <Text className="mt-1 text-xs text-faint">
                Revision {provenance.data.assertion.revision} · from{" "}
                {provenance.data.assertion.sourceKind}
              </Text>
            </View>

            {provenance.data.supersedes ? (
              <View>
                <Label>Replaced</Label>
                <Text className="mt-2 text-sm text-faint line-through">
                  {provenance.data.supersedes.text}
                </Text>
              </View>
            ) : null}

            {provenance.data.supersededBy ? (
              <View>
                <Label>Since replaced by</Label>
                <Body className="mt-2">{provenance.data.supersededBy.text}</Body>
              </View>
            ) : null}

            <View>
              <Label>Backed by</Label>
              {provenance.data.artifacts.length === 0 ? (
                <Text className="mt-2 text-sm text-faint">
                  You told me this directly — there's no file behind it.
                </Text>
              ) : (
                provenance.data.artifacts.map((artifact) => (
                  <Text key={artifact.id} className="mt-2 text-sm text-muted">
                    {artifact.filename}
                    {artifact.present ? "" : " (forgotten)"}
                  </Text>
                ))
              )}
            </View>

            {provenance.data.relatedEntities.length > 0 ? (
              <View>
                <Label>Mentions</Label>
                {provenance.data.relatedEntities.map((entity) => (
                  <Text key={entity.id} className="mt-2 text-sm text-muted">
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
      <Pressable
        testID={`assertion-${assertion.id}`}
        onPress={onProvenance}
        className="active:opacity-70"
      >
        <Card className={cn(superseded && "border-line/60 bg-ink-800/60")}>
          <Text
            className={cn(
              "text-base leading-[22px]",
              superseded ? "text-faint line-through" : "text-bone"
            )}
          >
            {assertion.text}
          </Text>
          <View className="mt-3 flex-row items-center justify-between">
            <ConfidenceTag value={assertion.confidence} />
            <Text className="text-xs text-brass">Where from?</Text>
          </View>
        </Card>
      </Pressable>
    </Animated.View>
  );
}
