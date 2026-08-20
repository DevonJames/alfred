/**
 * Brief (§12.4). What's due, and what the wider world has that might interest
 * you.
 *
 * The two halves are visually and verbally separate on purpose: reminders are
 * things you told Alfred, discovery cards are suggestions from public sources.
 * A recommendation must never read as "Alfred remembers this about you" (§11.5).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { Link } from "expo-router";
import { BookmarkPlus, ExternalLink } from "lucide-react-native";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  Card,
  ConnectionPill,
  Display,
  Empty,
  FromPhone,
  Label,
  Loading,
  Notice,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { useConnection } from "@/lib/connection";
import { desktopErrorMessage, discoverPublic, linkPublic, setReminderStatus } from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import { applyReminderStatus } from "@/lib/memory-cache";
import { describeCopy, recallDue } from "@/lib/recall";
import type { Memory } from "@/lib/types";

export default function Brief() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const connected = useConnection((s) => Boolean(s.serverUrl));

  // What's due is worked out on the Mac when it's reachable and from this
  // phone's copy when it isn't (§11.3), so a morning without a network still
  // tells you what you asked to be told.
  const due = useQuery({
    queryKey: ["reminders", "due"],
    queryFn: () => recallDue(),
  });

  const suggestions = useQuery({
    queryKey: ["public", "discover"],
    queryFn: () => discoverPublic(5),
    enabled: connected,
  });

  const status = useMutation({
    mutationFn: (input: { id: string; status: "completed" | "dismissed" }) =>
      setReminderStatus(input.id, input.status),
    onSuccess: (_result, input) => {
      // Keep the copy honest: a reminder the Mac has closed shouldn't come back
      // the next time this phone reads its own mirror.
      applyReminderStatus(input.id, input.status);
      queryClient.invalidateQueries({ queryKey: ["reminders", "due"] });
    },
  });

  const save = useMutation({
    mutationFn: (publicItemId: string) => linkPublic(publicItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["public", "discover"] });
      queryClient.invalidateQueries({ queryKey: ["memory", "recent"] });
    },
  });

  const reminders = due.data?.data.reminders ?? [];
  const fromPhone = due.data?.source === "phone";
  const candidates = suggestions.data?.candidates ?? [];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <Backdrop>
      <ScrollView
        testID="brief-screen"
        className="flex-1"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={due.isFetching ? !due.isLoading : false}
            onRefresh={() => {
              due.refetch();
              suggestions.refetch();
            }}
            tintColor="#D8A54A"
          />
        }
      >
        <View className="px-5">
          <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
          <Display className="mt-5">{greeting}.</Display>
          <Text className="mt-3 text-base leading-[22px] text-muted">
            {reminders.length === 0
              ? "Nothing is waiting on you today."
              : `${reminders.length} thing${reminders.length === 1 ? "" : "s"} you asked me to bring up.`}
          </Text>
        </View>

        {due.isLoading ? <Loading /> : null}
        {due.isError ? (
          <View className="mt-6 px-5">
            <Notice testID="brief-error">
              {desktopErrorMessage(
                due.error,
                "I can't reach your Mac, so I can't tell you what's due. Try again in a moment."
              )}
            </Notice>
          </View>
        ) : null}

        {reminders.length > 0 ? (
          <View className="mt-8 px-5">
            <Label>Due</Label>
            {fromPhone ? (
              <View className="mt-3">
                <FromPhone
                  testID="brief-from-phone"
                  detail={`${describeCopy(due.data?.cachedAt ?? null)} I can show what's due, but marking one done has to wait for your Mac.`}
                />
              </View>
            ) : null}
            <View className="mt-3 space-y-3">
              {reminders.map((reminder, index) => (
                <ReminderRow
                  // A record the Mac sent without an id still gets a stable
                  // slot; it just can't be opened or written back.
                  key={reminder.id || `reminder-${index}`}
                  memory={reminder}
                  index={index}
                  writable={!fromPhone && Boolean(reminder.id)}
                  onComplete={() => status.mutate({ id: reminder.id, status: "completed" })}
                  onDismiss={() => status.mutate({ id: reminder.id, status: "dismissed" })}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View className="mt-10 px-5">
          <Label>Might interest you</Label>
          <Text className="mt-1.5 text-xs leading-5 text-faint">
            {suggestions.data?.disclaimer ??
              "Suggested from public sources — not something Alfred remembers about you."}
          </Text>
        </View>

        {suggestions.isLoading ? <Loading /> : null}

        {!suggestions.isLoading && candidates.length === 0 ? (
          <Empty
            testID="discovery-empty"
            title="Nothing to suggest yet"
            detail="As you tell me more about what you care about, I'll point out public things worth a look."
          />
        ) : null}

        <View className="mt-3 space-y-3 px-5">
          {candidates.map((candidate, index) => (
            <Animated.View key={candidate.id || `candidate-${index}`} entering={FadeIn.delay(index * 60)}>
              <Card testID={`discovery-card-${candidate.id}`} className="border-dashed">
                <View className="flex-row items-center space-x-1.5">
                  <Text className="text-xs uppercase text-faint" style={{ letterSpacing: 1.4 }}>
                    Suggestion
                  </Text>
                </View>
                <Text className="mt-2 text-base leading-6 text-bone">{candidate.title}</Text>
                {candidate.summary ? (
                  <Text className="mt-1.5 text-sm leading-5 text-muted">{candidate.summary}</Text>
                ) : null}
                {candidate.matchedInterests.length > 0 ? (
                  <Text className="mt-3 text-xs text-faint">
                    Because you've mentioned {candidate.matchedInterests.slice(0, 3).join(", ")}
                  </Text>
                ) : null}
                <View className="mt-4 flex-row space-x-2">
                  <Pressable
                    testID={`open-suggestion-${candidate.id}`}
                    onPress={() => Linking.openURL(candidate.url)}
                    className="flex-row items-center space-x-1.5 rounded-full border border-line px-3 py-2 active:opacity-70"
                  >
                    <ExternalLink color="#8D939E" size={13} />
                    <Text className="text-xs text-muted">Open</Text>
                  </Pressable>
                  <Pressable
                    testID={`save-suggestion-${candidate.id}`}
                    onPress={() => save.mutate(candidate.id)}
                    className="flex-row items-center space-x-1.5 rounded-full border border-brass/40 bg-brass/10 px-3 py-2 active:opacity-70"
                  >
                    <BookmarkPlus color="#D8A54A" size={13} />
                    <Text className="text-xs text-brass">Keep this</Text>
                  </Pressable>
                </View>
              </Card>
            </Animated.View>
          ))}
        </View>
      </ScrollView>
    </Backdrop>
  );
}

function ReminderRow({
  memory,
  index,
  writable,
  onComplete,
  onDismiss,
}: {
  memory: Memory;
  index: number;
  /** False while this row came off the phone's copy — the Mac owns the write. */
  writable: boolean;
  onComplete: () => void;
  onDismiss: () => void;
}) {
  const due = memory.reminder?.dueAt ? new Date(memory.reminder.dueAt) : null;

  const body = (
    <>
      <Text className="text-base leading-6 text-bone">{memory.title}</Text>
      {due ? (
        <Text className={cn("mt-1 text-xs", memory.overdue ? "text-warn" : "text-faint")}>
          {memory.overdue ? "Overdue · " : ""}
          {due.toLocaleString(undefined, {
            dateStyle: "medium",
            ...(memory.reminder?.dateOnly ? {} : { timeStyle: "short" }),
          })}
        </Text>
      ) : null}
    </>
  );

  return (
    <Animated.View entering={FadeInDown.delay(index * 60)}>
      <Card
        testID={`reminder-${memory.id}`}
        className={cn(memory.overdue && "border-warn/40 bg-warn/5")}
      >
        {/* Without an id there is no detail page to open, so don't pretend. */}
        {memory.id ? (
          <Link href={{ pathname: "/memory/[id]", params: { id: memory.id } }} asChild>
            <Pressable className="active:opacity-70">{body}</Pressable>
          </Link>
        ) : (
          <View>{body}</View>
        )}
        <View className={cn("mt-4 flex-row space-x-2", !writable && "opacity-40")}>
          <Pressable
            testID={`complete-reminder-${memory.id}`}
            disabled={!writable}
            onPress={onComplete}
            className="rounded-full border border-ok/40 bg-ok/10 px-3 py-2 active:opacity-70"
          >
            <Text className="text-xs text-ok">Done</Text>
          </Pressable>
          <Pressable
            testID={`dismiss-reminder-${memory.id}`}
            disabled={!writable}
            onPress={onDismiss}
            className="rounded-full border border-line px-3 py-2 active:opacity-70"
          >
            <Text className="text-xs text-muted">Not now</Text>
          </Pressable>
        </View>
      </Card>
    </Animated.View>
  );
}
