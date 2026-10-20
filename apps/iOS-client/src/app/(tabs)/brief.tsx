/**
 * Brief (§12.4). Daily Brief from the Mac, due reminders, and public suggestions.
 *
 * Discovery cards are recommendations from public sources — never phrased as
 * something Alfred remembers about you (§11.5).
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
import {
  desktopErrorMessage,
  discoverPublic,
  getBriefing,
  getFitnessDayPlan,
  linkPublic,
  setReminderStatus,
} from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import { applyReminderStatus } from "@/lib/memory-cache";
import { describeCopy, recallDue } from "@/lib/recall";
import type { BriefingDisplaySection, FitnessDayPlan, Memory } from "@/lib/types";

export default function Brief() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const connected = useConnection((s) => Boolean(s.serverUrl));

  const daily = useQuery({
    queryKey: ["briefing", "daily"],
    queryFn: () => getBriefing({ refresh: false }),
    enabled: connected,
  });

  const due = useQuery({
    queryKey: ["reminders", "due"],
    queryFn: () => recallDue(),
  });

  const suggestions = useQuery({
    queryKey: ["public", "discover"],
    queryFn: () => discoverPublic(5),
    enabled: connected,
  });

  const fitness = useQuery({
    queryKey: ["fitness", "day-plan"],
    queryFn: getFitnessDayPlan,
    enabled: connected,
  });

  const status = useMutation({
    mutationFn: (input: {
      id: string;
      status: "completed" | "dismissed" | "snoozed";
      snoozedUntil?: string;
    }) => setReminderStatus(input.id, input.status, input.snoozedUntil),
    onSuccess: (_result, input) => {
      applyReminderStatus(input.id, input.status);
      queryClient.invalidateQueries({ queryKey: ["reminders", "due"] });
      queryClient.invalidateQueries({ queryKey: ["briefing", "daily"] });
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
  const sections = daily.data?.display?.sections ?? [];
  const greeting =
    daily.data?.briefing?.greeting?.trim() ||
    (new Date().getHours() < 12
      ? "Good morning"
      : new Date().getHours() < 18
        ? "Good afternoon"
        : "Good evening");
  const whenLabel = daily.data?.display?.when || daily.data?.briefing?.date;

  const refreshing =
    daily.isFetching || due.isFetching || suggestions.isFetching || fitness.isFetching;
  const plan = fitness.data?.plan ?? null;
  const hasFitnessSection = sections.some((s) => s.id === "training" || s.id === "meals");

  return (
    <Backdrop>
      <ScrollView
        testID="brief-screen"
        className="flex-1"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing && !daily.isLoading && !due.isLoading}
            onRefresh={() => {
              void daily.refetch();
              void due.refetch();
              void suggestions.refetch();
              void fitness.refetch();
            }}
            tintColor="#D8A54A"
          />
        }
      >
        <View className="px-5">
          <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
          <Display className="mt-5">{greeting}</Display>
          {whenLabel ? (
            <Text className="mt-2 text-sm text-faint">{whenLabel}</Text>
          ) : null}
          <Text className="mt-3 text-base leading-[22px] text-muted">
            {connected
              ? "Your Mac’s Daily Brief, what’s due, and a few public suggestions."
              : "Showing what’s due from this phone until your Mac is back."}
          </Text>
        </View>

        {connected && daily.isLoading ? <Loading /> : null}
        {daily.isError ? (
          <View className="mt-6 px-5">
            <Notice testID="brief-daily-error">
              {desktopErrorMessage(
                daily.error,
                "I couldn’t load the Daily Brief. Pull to refresh, or check the Mac."
              )}
            </Notice>
          </View>
        ) : null}

        {connected && plan && !hasFitnessSection ? (
          <View className="mt-8 px-5">
            <Label>FitnessAlly</Label>
            <FitnessPlanCard plan={plan} />
          </View>
        ) : null}

        {sections.length > 0 ? (
          <View className="mt-8 px-5">
            <Label>Today</Label>
            <View className="mt-3 space-y-3">
              {sections.map((section, index) => (
                <BriefSectionCard key={section.id || `section-${index}`} section={section} index={index} />
              ))}
            </View>
            <Text className="mt-3 text-xs leading-5 text-faint">
              Prefs live on the Mac → Briefing. This phone shows the latest brief.
            </Text>
          </View>
        ) : null}

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
                  key={reminder.id || `reminder-${index}`}
                  memory={reminder}
                  index={index}
                  writable={!fromPhone && Boolean(reminder.id)}
                  onComplete={() => status.mutate({ id: reminder.id, status: "completed" })}
                  onDismiss={() => status.mutate({ id: reminder.id, status: "dismissed" })}
                  onSnooze={() =>
                    status.mutate({
                      id: reminder.id,
                      status: "snoozed",
                      snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    })
                  }
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

function BriefSectionCard({
  section,
  index,
}: {
  section: BriefingDisplaySection;
  index: number;
}) {
  const title =
    section.title ||
    ({
      weather: "Weather",
      agenda: "Agenda",
      due: "Due Today",
      open: "Still Open",
      markets: "Markets",
      launches: "Launches",
      headlines: "Headlines",
      notes: "Saved",
      training: "Training",
      meals: "Meals",
    }[section.id] ?? section.id);

  return (
    <Animated.View entering={FadeInDown.delay(index * 50)}>
      <Card testID={`brief-section-${section.id}`}>
        <Text className="text-xs uppercase text-faint" style={{ letterSpacing: 1.4 }}>
          {title}
        </Text>
        <View className="mt-2 space-y-1.5">
          {section.lines.map((line, i) =>
            line.newsUrl ? (
              <Pressable
                key={`${section.id}-${i}`}
                onPress={() => Linking.openURL(line.newsUrl!)}
                className="active:opacity-70"
              >
                <Text className="text-sm leading-5 text-brass">{line.text}</Text>
              </Pressable>
            ) : (
              <Text key={`${section.id}-${i}`} className="text-sm leading-5 text-bone">
                {line.text}
              </Text>
            )
          )}
        </View>
      </Card>
    </Animated.View>
  );
}

function FitnessPlanCard({ plan }: { plan: FitnessDayPlan }) {
  const workouts = plan.workouts.filter((w) => w.status !== "skipped");
  const meals = [...plan.meals].filter((m) => m.status !== "skipped");
  return (
    <Card testID="brief-fitness-plan" className="mt-3">
      {workouts.length > 0 ? (
        <View className="mb-3">
          <Text className="text-xs uppercase text-faint" style={{ letterSpacing: 1.4 }}>
            Training
          </Text>
          {workouts.map((item) => (
            <Text key={item.id} className="mt-1.5 text-sm leading-5 text-bone">
              {item.name}
              {item.status === "completed" ? " · done" : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {meals.length > 0 ? (
        <View>
          <Text className="text-xs uppercase text-faint" style={{ letterSpacing: 1.4 }}>
            Meals
          </Text>
          {meals.map((meal) => (
            <Text key={meal.id} className="mt-1.5 text-sm leading-5 text-bone">
              {meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1)}: {meal.name}
            </Text>
          ))}
        </View>
      ) : null}
      {!workouts.length && !meals.length ? (
        <Text className="text-sm text-muted">No meals or training on today’s plan.</Text>
      ) : null}
    </Card>
  );
}

function ReminderRow({
  memory,
  index,
  writable,
  onComplete,
  onDismiss,
  onSnooze,
}: {
  memory: Memory;
  index: number;
  writable: boolean;
  onComplete: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
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
        {memory.id ? (
          <Link href={{ pathname: "/memory/[id]", params: { id: memory.id } }} asChild>
            <Pressable className="active:opacity-70">{body}</Pressable>
          </Link>
        ) : (
          <View>{body}</View>
        )}
        <View className={cn("mt-4 flex-row flex-wrap gap-2", !writable && "opacity-40")}>
          <Pressable
            testID={`complete-reminder-${memory.id}`}
            disabled={!writable}
            onPress={onComplete}
            className="rounded-full border border-ok/40 bg-ok/10 px-3 py-2 active:opacity-70"
          >
            <Text className="text-xs text-ok">Done</Text>
          </Pressable>
          <Pressable
            testID={`snooze-reminder-${memory.id}`}
            disabled={!writable}
            onPress={onSnooze}
            className="rounded-full border border-brass/40 bg-brass/10 px-3 py-2 active:opacity-70"
          >
            <Text className="text-xs text-brass">In 1 hour</Text>
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
