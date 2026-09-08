/**
 * Memory (§12.3). Ask, search, capture, inspect — constellation as the room,
 * with a sticky search dock that rides above the keyboard.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, router } from "expo-router";
import { Maximize2, Plus, Search, X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MemoryGraphView } from "@/components/MemoryGraphView";
import {
  Backdrop,
  BONE,
  BRASS,
  Card,
  Chip,
  ConfidenceTag,
  ConnectionPill,
  Empty,
  FAINT,
  FromPhone,
  INK,
  Label,
  LINE,
  Loading,
  MUTED,
  Notice,
} from "@/components/ui";
import { useConnection } from "@/lib/connection";
import {
  askMemory,
  desktopErrorMessage,
  fetchMemoryGraph,
  fetchMemoryGraphNode,
} from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import { useOutbox } from "@/lib/outbox";
import { filterGraph } from "@/lib/memory-graph-sim";
import { describeCopy, recallRecent, recallSearch } from "@/lib/recall";
import type { Memory, MemoryKind } from "@/lib/types";

const KINDS: { key: MemoryKind; label: string }[] = [
  { key: "entity", label: "People & things" },
  { key: "episode", label: "Moments" },
  { key: "note", label: "Notes" },
];

const GRAPH_TYPES = new Set(["Entity", "Episode", "Assertion", "Observation"]);

function isQuestion(q: string): boolean {
  return (
    /^(who|what|when|where|why|how|did|do|does|is|are|was|were)\b/i.test(q) || q.endsWith("?")
  );
}

export default function MemoryTab() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const offline = mode === "offline";

  const heldCount = useOutbox((s) => s.items.length);
  const flushing = useOutbox((s) => s.flushing);

  const [query, setQuery] = useState("");
  const [queryB, setQueryB] = useState("");
  const [kinds, setKinds] = useState<MemoryKind[]>([]);
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Shrink the field while typing so the dock stays readable above the keys.
  const constellationHeight = keyboardOpen
    ? Math.max(120, Math.round(windowHeight * 0.2))
    : Math.max(280, Math.round(windowHeight * 0.48));

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

  const graph = useQuery({
    queryKey: ["memory", "graph"],
    queryFn: () => fetchMemoryGraph(),
    enabled: !offline,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ["memory", "graph", "node", focusId],
    queryFn: () => fetchMemoryGraphNode(focusId!),
    enabled: !!focusId && !offline,
  });

  const submitted = search.data ?? null;
  const showing = submitted ? submitted.data.results : (recent.data?.data.memories ?? []);
  const filtered = kinds.length ? showing.filter((m) => kinds.includes(m.kind)) : showing;
  const shown = submitted ?? recent.data ?? null;
  const fromPhone = shown?.source === "phone";

  const statsLine = useMemo(() => {
    const s = graph.data?.stats;
    if (!s) return offline ? "Needs your Mac" : "Mapping…";
    return `${s.nodes} nodes · ${s.links} links`;
  }, [graph.data?.stats, offline]);

  // Same dual-search bridge note as the full Constellation screen.
  const bridgeNote = useMemo(() => {
    const a = query.trim();
    const b = queryB.trim();
    if (!a || !b || !graph.data) return null;
    return (
      filterGraph(graph.data.nodes, graph.data.links, {
        types: GRAPH_TYPES,
        query: a,
        queryB: b,
      }).bridge ?? null
    );
  }, [graph.data, query, queryB]);

  const runQuery = () => {
    const q = query.trim();
    if (!q) return;
    Keyboard.dismiss();
    if (isQuestion(q)) {
      ask.mutate(q);
      search.mutate(q);
    } else {
      ask.reset();
      search.mutate(q);
    }
  };

  const openConstellation = () => {
    const a = query.trim();
    const b = queryB.trim();
    router.push({
      pathname: "/memory/graph",
      params: {
        ...(a ? { q: a } : {}),
        ...(b ? { qB: b } : {}),
      },
    });
  };

  const openFocusedMemory = () => {
    if (!focusId) return;
    const openId =
      (typeof detail.data?.revision?.id === "string" && detail.data.revision.id) ||
      detail.data?.index?.logical_id ||
      detail.data?.index?.id ||
      focusId;
    router.push({ pathname: "/memory/[id]", params: { id: openId } });
  };

  const onGraphLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== graphSize.width || height !== graphSize.height) {
      setGraphSize({ width, height });
    }
  };

  return (
    <Backdrop>
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]} testID="memory-screen">
        <View style={styles.topBar}>
          <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
          <Pressable
            testID="open-capture"
            onPress={() => router.push("/capture")}
            style={styles.captureBtn}
          >
            <Plus color={INK} size={18} />
          </Pressable>
        </View>

        <View style={[styles.hero, { height: constellationHeight }]} testID="memory-constellation">
          <View style={styles.heroChrome}>
            <View>
              <Text style={styles.heroTitle}>Constellation</Text>
              <Text style={styles.heroSub}>{statsLine}</Text>
            </View>
            <Pressable
              testID="expand-memory-graph"
              onPress={openConstellation}
              style={styles.expandBtn}
              hitSlop={10}
            >
              <Maximize2 color={BRASS} size={16} />
            </Pressable>
          </View>

          <View style={styles.heroStage} onLayout={onGraphLayout}>
            {offline ? (
              <View style={styles.heroEmpty}>
                <Text style={styles.heroEmptyText}>Bring your Mac online to map the field.</Text>
              </View>
            ) : graph.isLoading ? (
              <View style={styles.heroEmpty}>
                <ActivityIndicator color={BRASS} />
              </View>
            ) : graph.isError ? (
              <View style={styles.heroEmpty}>
                <Text style={styles.heroEmptyText}>
                  {desktopErrorMessage(graph.error, "Couldn't reach the graph.")}
                </Text>
              </View>
            ) : graph.data?.nodes.length && graphSize.width > 0 && graphSize.height > 0 ? (
              <MemoryGraphView
                nodes={graph.data.nodes}
                links={graph.data.links}
                width={graphSize.width}
                height={graphSize.height}
                types={GRAPH_TYPES}
                query={query}
                queryB={queryB}
                focusId={focusId}
                onFocus={setFocusId}
              />
            ) : (
              <View style={styles.heroEmpty}>
                <Text style={styles.heroEmptyText}>Nothing in the field yet — capture something.</Text>
              </View>
            )}
          </View>

          {focusId ? (
            <Pressable
              testID="constellation-open-focus"
              onPress={openFocusedMemory}
              style={styles.focusBar}
            >
              <Text style={styles.focusLabel} numberOfLines={1}>
                {detail.isLoading
                  ? "Locking…"
                  : detail.data?.index?.name || detail.data?.revision?.name || "Open memory"}
              </Text>
              <Text style={styles.focusAction}>Open</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          style={styles.results}
          contentContainerStyle={styles.resultsContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          {!keyboardOpen ? (
            <Text style={styles.prompt}>What would you like to know?</Text>
          ) : null}

          {heldCount > 0 ? (
            <Pressable
              testID="outbox-banner"
              onPress={() => useOutbox.getState().flush().then(() => recent.refetch())}
              style={styles.bannerTap}
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
            <Animated.View entering={FadeInDown} style={styles.block} testID="ask-answer">
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

          {ask.isError && fromPhone ? (
            <View style={styles.block}>
              <FromPhone
                testID="ask-unavailable"
                detail="I can't think about that without your Mac — the reasoning happens there. Below is what this phone's copy matches on the words alone."
              />
            </View>
          ) : null}

          {ask.isError && !fromPhone ? (
            <View style={styles.block}>
              <Notice testID="memory-error">
                {desktopErrorMessage(ask.error, "I couldn't reach your Mac to look that up.")}
              </Notice>
            </View>
          ) : null}

          {search.isError ? (
            <View style={styles.block}>
              <Notice testID="memory-search-error">
                {desktopErrorMessage(search.error, "I couldn't look that up.")}
              </Notice>
            </View>
          ) : null}

          <View style={styles.listHeading}>
            <Label testID="memory-list-heading">
              {submitted ? `${filtered.length} found` : "Recently remembered"}
            </Label>
          </View>

          {fromPhone ? (
            <View style={styles.block}>
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
            <View style={styles.block}>
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

          <View style={styles.list}>
            {filtered.map((memory, index) => (
              <MemoryRow key={memory.id || `memory-${index}`} memory={memory} index={index} />
            ))}
          </View>
        </ScrollView>

        {/* Stays glued above the keyboard so typing is always visible. */}
        <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
          <View style={styles.searchDock} testID="memory-search-dock">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              keyboardShouldPersistTaps="handled"
            >
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
            </ScrollView>

            <View style={styles.searchRow}>
              <Search color={BRASS} size={18} strokeWidth={2.4} />
              <TextInput
                testID="memory-query-input"
                value={query}
                onChangeText={setQuery}
                placeholder="From — Devon…"
                placeholderTextColor={FAINT}
                returnKeyType="search"
                style={styles.searchInput}
                onSubmitEditing={runQuery}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {query ? (
                <Pressable
                  testID="memory-query-clear"
                  onPress={() => setQuery("")}
                  hitSlop={8}
                >
                  <X color={MUTED} size={16} />
                </Pressable>
              ) : null}
              <Pressable
                testID="memory-search-submit"
                onPress={runQuery}
                disabled={!query.trim() || search.isPending || ask.isPending}
                style={[
                  styles.searchBtn,
                  (!query.trim() || search.isPending || ask.isPending) && styles.searchBtnDisabled,
                ]}
              >
                {search.isPending || ask.isPending ? (
                  <ActivityIndicator color={INK} size="small" />
                ) : (
                  <Text style={styles.searchBtnText}>Search</Text>
                )}
              </Pressable>
            </View>

            <View style={styles.searchRow}>
              <Search color={FAINT} size={18} strokeWidth={2.4} />
              <TextInput
                testID="memory-query-b-input"
                value={queryB}
                onChangeText={setQueryB}
                placeholder="To — USPTO…"
                placeholderTextColor={FAINT}
                returnKeyType="search"
                style={styles.searchInput}
                autoCorrect={false}
                autoCapitalize="none"
              />
              {queryB ? (
                <Pressable
                  testID="memory-query-b-clear"
                  onPress={() => setQueryB("")}
                  hitSlop={8}
                >
                  <X color={MUTED} size={16} />
                </Pressable>
              ) : null}
            </View>

            {query.trim() && queryB.trim() ? (
              <Text
                style={[
                  styles.bridgeHint,
                  bridgeNote?.connected
                    ? styles.bridgeOk
                    : bridgeNote
                      ? styles.bridgeMiss
                      : null,
                ]}
                testID="memory-bridge-hint"
              >
                {!bridgeNote
                  ? ""
                  : bridgeNote.matchA === 0 || bridgeNote.matchB === 0
                    ? bridgeNote.matchA === 0
                      ? `No match for “${query.trim()}”.`
                      : `No match for “${queryB.trim()}”.`
                    : bridgeNote.connected
                      ? bridgeNote.hops === 0
                        ? "Same node matches both terms."
                        : `${bridgeNote.hops} hop${bridgeNote.hops === 1 ? "" : "s"} between them.`
                      : "Found both, but no path connects them."}
              </Text>
            ) : (
              <Text style={styles.bridgeHint}>
                Type to filter the field · fill both to trace a path · Search for list answers
              </Text>
            )}
          </View>
        </KeyboardStickyView>
      </View>
    </Backdrop>
  );
}

function MemoryRow({ memory, index }: { memory: Memory; index: number }) {
  const meta: string[] = [String(memory.entityType ?? memory.kind)];
  if (Number.isFinite(memory.revision) && memory.revision > 1 && memory.revision < 10_000) {
    meta.push(`revision ${memory.revision}`);
  }

  return (
    <Animated.View entering={FadeIn.delay(Math.min(index, 8) * 40)}>
      <Link href={{ pathname: "/memory/[id]", params: { id: memory.id } }} asChild>
        <Pressable testID={`memory-row-${memory.id}`} style={styles.rowTap}>
          <Card>
            <View style={styles.rowHeader}>
              <Text style={styles.rowTitle}>{memory.title}</Text>
              <ConfidenceTag value={memory.confidence} />
            </View>
            {memory.summary ? (
              <Text numberOfLines={2} style={styles.rowSummary}>
                {memory.summary}
              </Text>
            ) : null}
            <View style={styles.rowMeta}>
              <Text style={styles.rowMetaText}>{meta.join(" · ")}</Text>
              {memory.processingState === "needs_resolution" ? (
                <Text style={styles.rowWarn}>Needs a detail from you</Text>
              ) : null}
              {memory.processingState === "stored" ? (
                <Text style={styles.rowMetaText}>Saved, not yet organised</Text>
              ) : null}
              {memory.artifactsForgotten ? (
                <Text style={styles.rowMetaText}>Files forgotten</Text>
              ) : null}
            </View>
          </Card>
        </Pressable>
      </Link>
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
    paddingHorizontal: 20,
  },
  captureBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BRASS,
  },
  hero: {
    marginTop: 10,
    marginHorizontal: 10,
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(216,165,74,0.28)",
    backgroundColor: "#050608",
  },
  heroChrome: {
    position: "absolute",
    zIndex: 2,
    top: 12,
    left: 14,
    right: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  heroTitle: {
    fontFamily: "InstrumentSerif_400Regular",
    fontSize: 22,
    color: BONE,
  },
  heroSub: {
    marginTop: 2,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: FAINT,
  },
  expandBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "rgba(17,19,23,0.85)",
  },
  heroStage: {
    flex: 1,
  },
  heroEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  heroEmptyText: {
    color: MUTED,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  focusBar: {
    position: "absolute",
    zIndex: 2,
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(216,165,74,0.4)",
    backgroundColor: "rgba(17,19,23,0.92)",
  },
  focusLabel: {
    flex: 1,
    color: BONE,
    fontSize: 15,
  },
  focusAction: {
    color: INK,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0.3,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: BRASS,
    overflow: "hidden",
  },
  results: {
    flex: 1,
  },
  resultsContent: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 16,
  },
  prompt: {
    fontFamily: "InstrumentSerif_400Regular",
    fontSize: 28,
    lineHeight: 34,
    color: BONE,
    marginBottom: 8,
  },
  bannerTap: {
    marginTop: 10,
  },
  block: {
    marginTop: 14,
  },
  listHeading: {
    marginTop: 20,
  },
  list: {
    marginTop: 12,
    gap: 12,
  },
  rowTap: {
    opacity: 1,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  rowTitle: {
    flex: 1,
    color: BONE,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "500",
  },
  rowSummary: {
    marginTop: 6,
    color: MUTED,
    fontSize: 14,
    lineHeight: 20,
  },
  rowMeta: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  rowMetaText: {
    color: FAINT,
    fontSize: 12,
  },
  rowWarn: {
    color: "#E0A458",
    fontSize: 12,
  },
  searchDock: {
    borderTopWidth: 1,
    borderTopColor: "rgba(216,165,74,0.35)",
    backgroundColor: "#0E1014",
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 14,
    gap: 10,
  },
  chips: {
    gap: 8,
    paddingBottom: 2,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(216,165,74,0.55)",
    backgroundColor: "#171A1F",
    paddingLeft: 14,
    paddingRight: 8,
  },
  searchInput: {
    flex: 1,
    color: BONE,
    fontSize: 16,
    paddingVertical: 10,
  },
  searchBtn: {
    minWidth: 64,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BRASS,
    paddingHorizontal: 12,
  },
  searchBtnDisabled: {
    opacity: 0.45,
  },
  searchBtnText: {
    color: INK,
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: 0.2,
  },
  bridgeHint: {
    fontSize: 11,
    color: FAINT,
    letterSpacing: 0.2,
    paddingHorizontal: 4,
  },
  bridgeOk: {
    color: "#5AA97C",
  },
  bridgeMiss: {
    color: "#E2574C",
  },
});
