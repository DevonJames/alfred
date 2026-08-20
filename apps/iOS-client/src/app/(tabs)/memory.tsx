/**
 * Memory (§12.3). Ask, search, capture, inspect.
 *
 * The ask hero answers in Alfred's voice with its confidence stated and its
 * sources listed. Nothing here is *generated* on the phone — the desktop does
 * the reasoning (§11.1.3).
 *
 * Lists and searches, though, survive the Mac being out of reach: they fall back
 * to the mirror kept in local storage (§11.3), labelled as the phone's own copy.
 * Asking a question is the one thing that can't degrade — there is no reasoning
 * here to fall back on, so the screen says that plainly and shows the matching
 * records instead of inventing an answer.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, router } from "expo-router";
import { Plus, Search } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  Card,
  Chip,
  ConfidenceTag,
  ConnectionPill,
  Display,
  Empty,
  FromPhone,
  Label,
  Loading,
  Notice,
} from "@/components/ui";
import { useConnection } from "@/lib/connection";
import { askMemory, desktopErrorMessage } from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import { useOutbox } from "@/lib/outbox";
import { describeCopy, recallRecent, recallSearch } from "@/lib/recall";
import type { Memory, MemoryKind } from "@/lib/types";

const KINDS: { key: MemoryKind; label: string }[] = [
  { key: "entity", label: "People & things" },
  { key: "episode", label: "Moments" },
  { key: "note", label: "Notes" },
];

export default function MemoryTab() {
  const insets = useSafeAreaInsets();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);

  const heldCount = useOutbox((s) => s.items.length);
  const flushing = useOutbox((s) => s.flushing);

  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<MemoryKind[]>([]);

  // No `enabled` guard: with no path to the Mac these still answer, from the
  // copy on this phone.
  const recent = useQuery({
    queryKey: ["memory", "recent"],
    queryFn: () => recallRecent(30),
  });

  const search = useMutation({
    mutationFn: (q: string) => recallSearch(q, { kinds: kinds.length ? kinds : undefined }),
  });

  const ask = useMutation({
    mutationFn: (q: string) => askMemory(q),
  });

  const submitted = search.data ?? null;
  const showing = submitted ? submitted.data.results : (recent.data?.data.memories ?? []);
  const filtered = kinds.length ? showing.filter((m) => kinds.includes(m.kind)) : showing;

  // Whichever list is on screen decides whether the source line is shown.
  const shown = submitted ?? recent.data ?? null;
  const fromPhone = shown?.source === "phone";

  return (
    <Backdrop>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={49}>
        <View className="flex-1" testID="memory-screen" style={{ paddingTop: insets.top + 12 }}>
          <View className="flex-row items-center justify-between px-5">
            <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
            <Pressable
              testID="open-capture"
              onPress={() => router.push("/capture")}
              className="h-9 w-9 items-center justify-center rounded-full bg-brass active:opacity-70"
            >
              <Plus color="#0A0B0D" size={18} />
            </Pressable>
          </View>

          <ScrollView
            className="mt-3 flex-1"
            contentContainerStyle={{ paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View className="px-5">
              <Display>What would you like to know?</Display>

              <View className="mt-5 flex-row items-center space-x-2 rounded-2xl border border-line bg-ink-700 px-4">
                <Search color="#5F656F" size={17} />
                <TextInput
                  testID="memory-query-input"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Ask, or search for anything"
                  placeholderTextColor="#5F656F"
                  returnKeyType="search"
                  className="h-14 flex-1 text-base text-bone"
                  onSubmitEditing={() => {
                    const q = query.trim();
                    if (!q) return;
                    // Questions get an answer; everything else gets a list.
                    if (/^(who|what|when|where|why|how|did|do|does|is|are|was|were)\b/i.test(q) || q.endsWith("?")) {
                      ask.mutate(q);
                      search.mutate(q);
                    } else {
                      ask.reset();
                      search.mutate(q);
                    }
                  }}
                />
              </View>

              <View className="mt-3 flex-row flex-wrap space-x-2">
                {KINDS.map((kind) => (
                  <Chip
                    key={kind.key}
                    testID={`kind-chip-${kind.key}`}
                    label={kind.label}
                    active={kinds.includes(kind.key)}
                    onPress={() =>
                      setKinds((current) =>
                        current.includes(kind.key)
                          ? current.filter((k) => k !== kind.key)
                          : [...current, kind.key]
                      )
                    }
                  />
                ))}
              </View>
            </View>

            {heldCount > 0 ? (
              <Pressable
                testID="outbox-banner"
                onPress={() => useOutbox.getState().flush().then(() => recent.refetch())}
                className="mt-5 px-5 active:opacity-70"
              >
                <Card className="border-warn/40 bg-warn/5">
                  <Text className="text-sm text-warn">
                    {heldCount} capture{heldCount === 1 ? "" : "s"} held on this phone
                  </Text>
                  <Text className="mt-1.5 text-xs leading-5 text-faint">
                    Your Mac hasn't seen {heldCount === 1 ? "it" : "them"} yet, so I haven't
                    remembered {heldCount === 1 ? "it" : "them"}.{" "}
                    {flushing ? "Sending…" : "Tap to try again."}
                  </Text>
                </Card>
              </Pressable>
            ) : null}

            {ask.isPending ? <Loading label="Looking through what I remember" /> : null}

            {ask.data ? (
              <Animated.View entering={FadeInDown} className="mt-6 px-5" testID="ask-answer">
                <Card className="border-brass/30 bg-brass/5">
                  <ConfidenceTag value={ask.data.confidence} />
                  <Text className="mt-3 font-display text-2xl leading-8 text-bone">
                    {ask.data.answer}
                  </Text>
                  {ask.data.interpretedAs ? (
                    <Text className="mt-3 text-xs italic text-faint">
                      I read that as: {ask.data.interpretedAs}
                    </Text>
                  ) : null}
                  {ask.data.sources.length > 0 ? (
                    <View className="mt-4 space-y-2 border-t border-line pt-3">
                      <Label>Because you told me</Label>
                      {ask.data.sources.map((source) => (
                        <Link
                          key={source.id}
                          href={{ pathname: "/memory/[id]", params: { id: source.id } }}
                          asChild
                        >
                          <Pressable testID={`ask-source-${source.id}`} className="active:opacity-60">
                            <Text className="text-sm text-brass">{source.title}</Text>
                          </Pressable>
                        </Link>
                      ))}
                    </View>
                  ) : null}
                </Card>
              </Animated.View>
            ) : null}

            {/* Reasoning can't move to the phone. Say so, rather than passing
                a word match off as an answer. */}
            {ask.isError && fromPhone ? (
              <View className="mt-4 px-5">
                <FromPhone
                  testID="ask-unavailable"
                  detail="I can't think about that without your Mac — the reasoning happens there. Below is what this phone's copy matches on the words alone."
                />
              </View>
            ) : null}

            {ask.isError && !fromPhone ? (
              <View className="mt-4 px-5">
                <Notice testID="memory-error">
                  {desktopErrorMessage(
                    ask.error,
                    "I couldn't reach your Mac to look that up."
                  )}
                </Notice>
              </View>
            ) : null}

            {search.isError ? (
              <View className="mt-4 px-5">
                {/* Unreachability is handled by the fallback above, so anything
                    that lands here is your Mac refusing, not the network. */}
                <Notice testID="memory-search-error">
                  {desktopErrorMessage(search.error, "I couldn't look that up.")}
                </Notice>
              </View>
            ) : null}

            <View className="mt-8 px-5">
              <Label testID="memory-list-heading">
                {submitted ? `${filtered.length} found` : "Recently remembered"}
              </Label>
            </View>

            {fromPhone ? (
              <View className="mt-3 px-5">
                <FromPhone
                  testID="memory-from-phone"
                  detail={`${describeCopy(shown?.cachedAt ?? null)}${
                    submitted ? " I matched on words here, not meaning." : ""
                  }`}
                />
              </View>
            ) : null}

            {recent.isLoading || search.isPending ? <Loading /> : null}

            {recent.isError && !submitted ? (
              <View className="mt-3 px-5">
                <Notice testID="memory-recent-error">
                  {desktopErrorMessage(
                    recent.error,
                    "I can't reach your Mac, and this phone hasn't been shown anything to keep a copy of yet."
                  )}
                </Notice>
              </View>
            ) : null}

            {!recent.isLoading && !recent.isError && !search.isPending && filtered.length === 0 ? (
              <Empty
                testID="memory-empty"
                title={submitted ? "Nothing matches" : "Nothing yet"}
                detail={
                  submitted
                    ? fromPhone
                      ? "This phone's copy has nothing with those words in it. Your Mac may still know — it searches meaning, not just wording."
                      : "Try different words — I search what you actually said, not just tags."
                    : "Tell Alfred something worth keeping and it will appear here."
                }
              />
            ) : null}

            <View className="mt-3 space-y-3 px-5">
              {filtered.map((memory, index) => (
                <MemoryRow key={memory.id || `memory-${index}`} memory={memory} index={index} />
              ))}
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Backdrop>
  );
}

function MemoryRow({ memory, index }: { memory: Memory; index: number }) {
  return (
    <Animated.View entering={FadeIn.delay(Math.min(index, 8) * 40)}>
      <Link href={{ pathname: "/memory/[id]", params: { id: memory.id } }} asChild>
        <Pressable testID={`memory-row-${memory.id}`} className="active:opacity-70">
          <Card>
            <View className="flex-row items-start justify-between">
              <Text className="flex-1 pr-3 text-base text-bone">{memory.title}</Text>
              <ConfidenceTag value={memory.confidence} />
            </View>
            {memory.summary ? (
              <Text numberOfLines={2} className="mt-1.5 text-sm leading-5 text-muted">
                {memory.summary}
              </Text>
            ) : null}
            <View className="mt-3 flex-row items-center space-x-2">
              <Text className="text-xs text-faint">
                {memory.entityType ?? memory.kind}
                {memory.revision > 1 ? ` · revision ${memory.revision}` : null}
              </Text>
              {memory.processingState === "needs_resolution" ? (
                <Text className="text-xs text-warn">Needs a detail from you</Text>
              ) : null}
              {memory.processingState === "stored" ? (
                <Text className="text-xs text-muted">Saved, not yet organised</Text>
              ) : null}
              {memory.artifactsForgotten ? (
                <Text className="text-xs text-faint">Files forgotten</Text>
              ) : null}
            </View>
          </Card>
        </Pressable>
      </Link>
    </Animated.View>
  );
}
