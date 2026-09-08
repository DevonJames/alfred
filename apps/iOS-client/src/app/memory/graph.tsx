/**
 * Full-screen memory constellation.
 * Pinch / pan / tap a node; open the Mac-backed detail sheet.
 */
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import {
  ArrowLeft,
  Orbit,
  RefreshCw,
  Search,
  X,
} from "lucide-react-native";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MemoryGraphView } from "@/components/MemoryGraphView";
import {
  BONE,
  BRASS,
  FAINT,
  INK,
  Label,
  LINE,
  MUTED,
} from "@/components/ui";
import { useConnection } from "@/lib/connection";
import {
  desktopErrorMessage,
  fetchMemoryGraph,
  fetchMemoryGraphNode,
} from "@/lib/desktop-api";
import { filterGraph, typeColor } from "@/lib/memory-graph-sim";

const TYPE_FILTERS = [
  { key: "Entity", label: "Entities" },
  { key: "Organization", label: "Orgs" },
  { key: "Episode", label: "Episodes" },
  { key: "Assertion", label: "Assertions" },
  { key: "Observation", label: "Observations" },
] as const;

export default function MemoryGraphScreen() {
  const insets = useSafeAreaInsets();
  const mode = useConnection((s) => s.mode);
  const offline = mode === "offline";
  const params = useLocalSearchParams<{ q?: string; qB?: string }>();

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [query, setQuery] = useState(() =>
    typeof params.q === "string" ? params.q : ""
  );
  const [queryB, setQueryB] = useState(() =>
    typeof params.qB === "string" ? params.qB : ""
  );
  const [types, setTypes] = useState<Set<string>>(
    () => new Set(["Entity", "Episode", "Assertion", "Observation"])
  );
  const [focusId, setFocusId] = useState<string | null>(null);

  const [rebuilding, setRebuilding] = useState(false);

  const graph = useQuery({
    queryKey: ["memory", "graph"],
    queryFn: () => fetchMemoryGraph(),
    enabled: !offline,
    staleTime: 60_000,
  });

  const busy = graph.isFetching || rebuilding;

  const rebuild = async () => {
    if (offline || rebuilding) return;
    setRebuilding(true);
    try {
      await fetchMemoryGraph({ rebuild: true });
      await graph.refetch();
    } catch {
      await graph.refetch().catch(() => {});
    } finally {
      setRebuilding(false);
    }
  };

  const detail = useQuery({
    queryKey: ["memory", "graph", "node", focusId],
    queryFn: () => fetchMemoryGraphNode(focusId!),
    enabled: !!focusId && !offline,
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) {
      setSize({ width, height });
    }
  };

  const bridgeNote = useMemo(() => {
    const a = query.trim();
    const b = queryB.trim();
    if (!a || !b || !graph.data) return null;
    return (
      filterGraph(graph.data.nodes, graph.data.links, {
        types,
        query: a,
        queryB: b,
      }).bridge ?? null
    );
  }, [graph.data, query, queryB, types]);

  const stats = graph.data?.stats;
  const detailText = useMemo(() => {
    const rev = detail.data?.revision;
    if (!rev) return detail.data?.index?.search_text ?? "";
    const schema = (rev.schema ?? {}) as Record<string, unknown>;
    return (
      rev.text ||
      (typeof schema.description === "string" ? schema.description : "") ||
      (typeof schema.text === "string" ? schema.text : "") ||
      (rev.predicate ? `${rev.predicate} → ${rev.object ?? ""}` : "") ||
      detail.data?.index?.search_text ||
      ""
    );
  }, [detail.data]);

  const toggleType = (key: string) => {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (next.size === 0) {
        for (const t of TYPE_FILTERS) next.add(t.key);
      }
      return next;
    });
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]} testID="memory-graph-screen">
      <View style={styles.topBar}>
        <Pressable
          testID="graph-back"
          onPress={() => router.back()}
          style={styles.iconBtn}
          hitSlop={12}
        >
          <ArrowLeft color={BONE} size={20} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Constellation</Text>
          <Text style={styles.sub}>
            {stats
              ? `${stats.nodes} nodes · ${stats.links} links`
              : offline
                ? "Needs your Mac"
                : "Mapping memory…"}
          </Text>
        </View>
        <Pressable
          testID="graph-rebuild"
          onPress={() => {
            void rebuild();
          }}
          disabled={offline || busy}
          style={[styles.iconBtn, (offline || busy) && { opacity: 0.4 }]}
          hitSlop={12}
        >
          {busy ? (
            <ActivityIndicator color={BRASS} size="small" />
          ) : (
            <RefreshCw color={BRASS} size={18} />
          )}
        </Pressable>
      </View>

      <View style={styles.searchStack}>
        <View style={styles.searchRow}>
          <Search color={FAINT} size={16} />
          <TextInput
            testID="graph-query"
            value={query}
            onChangeText={setQuery}
            placeholder="From — Devon…"
            placeholderTextColor={FAINT}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={8}>
              <X color={MUTED} size={16} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.searchRow}>
          <Search color={FAINT} size={16} />
          <TextInput
            testID="graph-query-b"
            value={queryB}
            onChangeText={setQueryB}
            placeholder="To — USPTO…"
            placeholderTextColor={FAINT}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {queryB ? (
            <Pressable onPress={() => setQueryB("")} hitSlop={8}>
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
          <Text style={styles.bridgeHint}>Fill both to trace the path between them.</Text>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        style={{ flexGrow: 0 }}
      >
        {TYPE_FILTERS.map((t) => {
          const active = types.has(t.key);
          return (
            <Pressable
              key={t.key}
              testID={`graph-type-${t.key}`}
              onPress={() => toggleType(t.key)}
              style={[
                styles.chip,
                active && { borderColor: typeColor(t.key), backgroundColor: `${typeColor(t.key)}22` },
              ]}
            >
              <View style={[styles.dot, { backgroundColor: typeColor(t.key) }]} />
              <Text style={[styles.chipText, active && { color: BONE }]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.stage} onLayout={onLayout}>
        {offline ? (
          <View style={styles.center}>
            <Orbit color={BRASS} size={28} />
            <Text style={styles.emptyTitle}>Mac offline</Text>
            <Text style={styles.emptyLead}>
              The constellation lives on your desktop. Bring the Mac online to map it.
            </Text>
          </View>
        ) : graph.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={BRASS} size="large" />
            <Text style={styles.emptyLead}>Tracing links…</Text>
          </View>
        ) : graph.isError ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Couldn’t load graph</Text>
            <Text style={styles.emptyLead}>
              {desktopErrorMessage(graph.error, "Your Mac isn’t reachable right now.")}
            </Text>
            <Pressable onPress={() => graph.refetch()} style={styles.retry}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : !graph.data?.nodes.length ? (
          <View style={styles.center}>
            <Orbit color={BRASS} size={28} />
            <Text style={styles.emptyTitle}>No memory graph yet</Text>
            <Text style={styles.emptyLead}>
              Capture something, then come back — nodes appear as Alfred indexes what you tell him.
            </Text>
          </View>
        ) : size.width > 0 && size.height > 0 ? (
          <MemoryGraphView
            nodes={graph.data.nodes}
            links={graph.data.links}
            width={size.width}
            height={size.height}
            types={types}
            query={query}
            queryB={queryB}
            focusId={focusId}
            onFocus={setFocusId}
          />
        ) : null}
      </View>

      {focusId ? (
        <View
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
          testID="graph-detail-sheet"
        >
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              {detail.isLoading ? (
                <Text style={styles.sheetMeta}>Locking target…</Text>
              ) : (
                <>
                  <Text
                    style={[
                      styles.typePill,
                      { color: typeColor(detail.data?.index?.record_type ?? "Entity") },
                    ]}
                  >
                    {(detail.data?.index?.record_type ?? "Record").toUpperCase()}
                  </Text>
                  <Text style={styles.sheetTitle} numberOfLines={2}>
                    {detail.data?.index?.name || detail.data?.revision?.name || "Untitled"}
                  </Text>
                </>
              )}
            </View>
            <Pressable onPress={() => setFocusId(null)} hitSlop={12} style={styles.iconBtn}>
              <X color={MUTED} size={18} />
            </Pressable>
          </View>

          {detailText ? (
            <Text style={styles.sheetBody} numberOfLines={5}>
              {String(detailText)}
            </Text>
          ) : null}

          {(detail.data?.neighbors?.length ?? 0) > 0 ? (
            <>
              <Label>Connections</Label>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
              >
                {detail.data!.neighbors.slice(0, 24).map((n) => (
                  <Pressable
                    key={`${n.direction}-${n.predicate}-${n.id}`}
                    onPress={() => setFocusId(n.id)}
                    style={styles.neighbor}
                  >
                    <Text style={styles.neighborPred}>
                      {n.direction === "out" ? "→" : "←"} {n.predicate}
                    </Text>
                    <Text style={styles.neighborLabel} numberOfLines={1}>
                      {n.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : null}

          <Pressable
            testID="graph-open-memory"
            onPress={() => {
              const openId =
                (typeof detail.data?.revision?.id === "string" && detail.data.revision.id) ||
                detail.data?.index?.logical_id ||
                detail.data?.index?.id ||
                focusId;
              router.push({ pathname: "/memory/[id]", params: { id: openId } });
            }}
            style={styles.openBtn}
          >
            <Text style={styles.openBtnText}>Open memory</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={[styles.hint, { paddingBottom: insets.bottom + 8 }]}>
          Drag a node to move · drag empty space to pan · pinch · twist · tap
        </Text>
      )}
    </View>
  );
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: INK,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "#111317",
  },
  title: {
    fontFamily: "InstrumentSerif_400Regular",
    fontSize: 22,
    color: BONE,
    letterSpacing: 0.3,
  },
  sub: {
    marginTop: 2,
    fontSize: 11,
    color: FAINT,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  searchStack: {
    marginHorizontal: 12,
    marginBottom: 6,
    gap: 6,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(61,255,196,0.22)",
    backgroundColor: "#0E141C",
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: {
    flex: 1,
    color: BONE,
    fontSize: 15,
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
  chips: {
    paddingHorizontal: 12,
    gap: 8,
    paddingBottom: 6,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "#111317",
  },
  chipText: {
    fontSize: 12,
    color: MUTED,
    letterSpacing: 0.3,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  stage: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: "#050608",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyTitle: {
    fontFamily: "InstrumentSerif_400Regular",
    fontSize: 24,
    color: BONE,
    textAlign: "center",
  },
  emptyLead: {
    fontSize: 14,
    lineHeight: 20,
    color: MUTED,
    textAlign: "center",
  },
  retry: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: BRASS,
  },
  retryText: {
    color: INK,
    fontWeight: "600",
  },
  sheet: {
    marginHorizontal: 0,
    marginBottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(216,165,74,0.35)",
    backgroundColor: "rgba(17,19,23,0.96)",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: LINE,
    marginBottom: 10,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  typePill: {
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "600",
  },
  sheetTitle: {
    marginTop: 4,
    fontFamily: "InstrumentSerif_400Regular",
    fontSize: 22,
    color: BONE,
  },
  sheetMeta: {
    color: MUTED,
    fontSize: 13,
  },
  sheetBody: {
    marginTop: 10,
    marginBottom: 8,
    fontSize: 14,
    lineHeight: 20,
    color: MUTED,
  },
  neighbor: {
    maxWidth: 160,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "#0A0B0D",
  },
  neighborPred: {
    fontSize: 10,
    color: BRASS,
    letterSpacing: 0.4,
  },
  neighborLabel: {
    marginTop: 4,
    fontSize: 13,
    color: BONE,
  },
  openBtn: {
    marginTop: 4,
    marginBottom: 4,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BRASS,
  },
  openBtnText: {
    color: INK,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  hint: {
    textAlign: "center",
    fontSize: 11,
    color: FAINT,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
});
