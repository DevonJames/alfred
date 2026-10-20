/**
 * Agenda — today's (or this week's) EventKit board from the Mac.
 * Create / edit / delete events on calendars marked write in Gateway.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock3, Plus, Trash2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  BRASS,
  Button,
  Card,
  ConnectionPill,
  Display,
  Empty,
  Label,
  Loading,
  Notice,
  Sheet,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { useConnection } from "@/lib/connection";
import {
  createAgendaEvent,
  deleteAgendaEvent,
  desktopErrorMessage,
  getAgendaBoard,
  getAgendaBlocks,
  listAgendaCalendars,
  listOpenAppleReminders,
  placeReminderInBlock,
  updateAgendaEvent,
} from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import type { AgendaCalendarEvent, AgendaTimeBlock } from "@/lib/types";

function shiftDate(yyyyMmDd: string, days: number): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function formatClock(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** HH:mm in the board timezone for composer fields. */
function clockValue(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function flattenEvents(
  calendars: Array<{ events: AgendaCalendarEvent[]; access: string; title: string }>
): Array<AgendaCalendarEvent & { writable: boolean }> {
  const out: Array<AgendaCalendarEvent & { writable: boolean }> = [];
  for (const cal of calendars) {
    for (const event of cal.events ?? []) {
      out.push({ ...event, writable: cal.access === "write" });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

export default function Agenda() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const connected = useConnection((s) => Boolean(s.serverUrl && s.deviceToken));

  const [view, setView] = useState<"today" | "week">("today");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<AgendaCalendarEvent | null>(null);
  const [title, setTitle] = useState("");
  const [startClock, setStartClock] = useState("09:00");
  const [endClock, setEndClock] = useState("10:00");
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [placeBlock, setPlaceBlock] = useState<AgendaTimeBlock | null>(null);
  const [placeReminderId, setPlaceReminderId] = useState<string | null>(null);
  const [placeMinutes, setPlaceMinutes] = useState("30");

  const board = useQuery({
    queryKey: ["agenda", "board", view, date],
    queryFn: () => getAgendaBoard({ view, date }),
    enabled: connected,
  });

  const focusDate = board.data?.focusDate || date;

  const blocks = useQuery({
    queryKey: ["agenda", "blocks", focusDate],
    queryFn: () => getAgendaBlocks(focusDate),
    enabled: connected,
  });

  const openReminders = useQuery({
    queryKey: ["agenda", "open-reminders"],
    queryFn: listOpenAppleReminders,
    enabled: connected && placeOpen,
  });

  const calendars = useQuery({
    queryKey: ["agenda", "calendars"],
    queryFn: listAgendaCalendars,
    enabled: connected && composerOpen,
  });

  const writable = useMemo(
    () => (calendars.data?.calendars ?? []).filter((c) => c.access === "write"),
    [calendars.data]
  );

  const events = useMemo(
    () => flattenEvents(board.data?.calendars ?? []),
    [board.data]
  );

  const zone = board.data?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  function openCreate() {
    setEditing(null);
    setTitle("");
    setStartClock("09:00");
    setEndClock("10:00");
    setCalendarId(null);
    setComposerOpen(true);
  }

  function openEdit(event: AgendaCalendarEvent & { writable: boolean }) {
    if (!event.writable || event.allDay) return;
    setEditing(event);
    setTitle(event.title || "");
    setStartClock(clockValue(event.start, zone));
    setEndClock(clockValue(event.end, zone));
    setCalendarId(event.calendarId || null);
    setComposerOpen(true);
  }

  function closeComposer() {
    setComposerOpen(false);
    setEditing(null);
    setTitle("");
  }

  const create = useMutation({
    mutationFn: () =>
      createAgendaEvent({
        calendarId: calendarId || writable[0]?.id || "",
        title: title.trim(),
        start: startClock,
        end: endClock,
        date: board.data?.focusDate || date,
      }),
    onSuccess: () => {
      closeComposer();
      void queryClient.invalidateQueries({ queryKey: ["agenda", "board"] });
    },
  });

  const update = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error("No event to update");
      return updateAgendaEvent(editing.id, {
        title: title.trim(),
        start: startClock,
        end: endClock,
        anchor: editing.start,
        calendarId: calendarId || undefined,
      });
    },
    onSuccess: () => {
      closeComposer();
      void queryClient.invalidateQueries({ queryKey: ["agenda", "board"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAgendaEvent(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agenda", "board"] }),
  });

  const place = useMutation({
    mutationFn: (choice?: "overlap" | "next") =>
      placeReminderInBlock({
        reminderId: placeReminderId || "",
        blockId: placeBlock?.id || "",
        durationMinutes: Math.max(5, Math.min(12 * 60, Number(placeMinutes) || 30)),
        date: focusDate,
        choice,
      }),
    onSuccess: (result) => {
      if (result.ok) {
        setPlaceOpen(false);
        setPlaceBlock(null);
        setPlaceReminderId(null);
        void queryClient.invalidateQueries({ queryKey: ["agenda", "board"] });
        return;
      }
      if (result.choice === "overlap" || result.choice === "off-day" || result.choice === "too-short") {
        Alert.alert(
          result.message || "That slot is busy",
          result.next
            ? `Next open: ${result.next.label} ${result.next.start}–${result.next.end}`
            : undefined,
          [
            { text: "Cancel", style: "cancel" },
            ...(result.choice === "overlap"
              ? [{ text: "Place anyway", onPress: () => place.mutate("overlap") }]
              : []),
            ...(result.next
              ? [{ text: "Use next slot", onPress: () => place.mutate("next") }]
              : []),
          ]
        );
        return;
      }
      if (result.error || result.message) {
        Alert.alert("Couldn't place", result.error || result.message || "Try again.");
      }
    },
  });

  const heading = board.data?.focusLabel || board.data?.dateLabel || "Agenda";
  const saving = create.isPending || update.isPending;
  const saveError = create.error || update.error;
  const activeBlocks = (blocks.data?.blocks ?? []).filter((b) => b.activeOnDate);

  return (
    <Backdrop>
      <ScrollView
        testID="agenda-screen"
        className="flex-1"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={(board.isFetching || blocks.isFetching) && !board.isLoading}
            onRefresh={() => {
              void board.refetch();
              void blocks.refetch();
            }}
            tintColor="#D8A54A"
          />
        }
      >
        <View className="px-5">
          <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
          <View className="mt-5 flex-row items-center justify-between">
            <Display>{heading}</Display>
            <Pressable
              testID="agenda-add"
              disabled={!connected}
              onPress={openCreate}
              className="h-10 w-10 items-center justify-center rounded-full border border-brass/40 bg-brass/10 active:opacity-70"
              style={{ opacity: connected ? 1 : 0.35 }}
            >
              <Plus color={BRASS} size={18} />
            </Pressable>
          </View>
          <Text className="mt-2 text-sm text-muted">
            Calendar events from your Mac. Writes need Gateway write access.
          </Text>

          <View className="mt-4 flex-row items-center justify-between">
            <View className="flex-row rounded-full border border-line bg-ink-800 p-1">
              {(["today", "week"] as const).map((option) => (
                <Pressable
                  key={option}
                  testID={`agenda-view-${option}`}
                  onPress={() => setView(option)}
                  className={cn(
                    "rounded-full px-3 py-1.5",
                    view === option && "bg-brass/20"
                  )}
                >
                  <Text className={cn("text-xs", view === option ? "text-brass" : "text-muted")}>
                    {option === "today" ? "Today" : "Week"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View className="flex-row items-center space-x-2">
              <Pressable
                testID="agenda-prev"
                onPress={() => setDate((d) => shiftDate(d, view === "week" ? -7 : -1))}
                className="h-9 w-9 items-center justify-center rounded-full border border-line active:opacity-70"
              >
                <ChevronLeft color="#8D939E" size={18} />
              </Pressable>
              <Pressable
                testID="agenda-next"
                onPress={() => setDate((d) => shiftDate(d, view === "week" ? 7 : 1))}
                className="h-9 w-9 items-center justify-center rounded-full border border-line active:opacity-70"
              >
                <ChevronRight color="#8D939E" size={18} />
              </Pressable>
            </View>
          </View>
        </View>

        {!connected ? (
          <View className="mt-8 px-5">
            <Notice>Connect to your Mac to see the agenda.</Notice>
          </View>
        ) : null}

        {board.isLoading ? <Loading /> : null}
        {board.isError ? (
          <View className="mt-6 px-5">
            <Notice testID="agenda-error">
              {desktopErrorMessage(board.error, "Couldn't load the agenda.")}
            </Notice>
          </View>
        ) : null}
        {board.data?.error ? (
          <View className="mt-6 px-5">
            <Notice tone="error">{board.data.error}</Notice>
          </View>
        ) : null}

        {connected && activeBlocks.length > 0 ? (
          <View className="mt-8 px-5">
            <Label>Time blocks</Label>
            <Text className="mt-1 text-xs text-faint">
              Tap a block to drop an Apple Reminder into it.
            </Text>
            <View className="mt-3 space-y-2">
              {activeBlocks.map((block) => (
                <Pressable
                  key={block.id}
                  testID={`agenda-block-${block.id}`}
                  onPress={() => {
                    setPlaceBlock(block);
                    setPlaceReminderId(null);
                    setPlaceMinutes("30");
                    setPlaceOpen(true);
                  }}
                  className="flex-row items-center rounded-2xl border border-line bg-ink-700 px-3 py-3 active:opacity-80"
                >
                  <Clock3 color={BRASS} size={16} />
                  <View className="ml-3 flex-1">
                    <Text className="text-sm text-bone">{block.name}</Text>
                    <Text className="mt-0.5 text-xs text-faint">
                      {block.start} – {block.end}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {!board.isLoading && connected && events.length === 0 ? (
          <Empty
            testID="agenda-empty"
            title="Nothing on the board"
            detail="Open calendars for read/write on the Mac → Gateway, then pull to refresh."
          />
        ) : null}

        <View className="mt-6 space-y-3 px-5">
          {events.map((event, index) => (
            <Animated.View key={event.id || `ev-${index}`} entering={FadeInDown.delay(index * 40)}>
              <Pressable
                disabled={!event.writable || event.allDay}
                onPress={() => openEdit(event)}
                className="active:opacity-80"
              >
                <Card testID={`agenda-event-${event.id}`}>
                  <View className="flex-row items-start justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-base leading-6 text-bone">{event.title || "Untitled"}</Text>
                      <Text className="mt-1 text-xs text-faint">
                        {event.allDay
                          ? "All day"
                          : `${formatClock(event.start, zone)} – ${formatClock(event.end, zone)}`}
                        {event.calendarTitle ? ` · ${event.calendarTitle}` : ""}
                      </Text>
                      {event.location ? (
                        <Text className="mt-1 text-xs text-muted" numberOfLines={1}>
                          {event.location}
                        </Text>
                      ) : null}
                    </View>
                    {event.writable ? (
                      <Pressable
                        testID={`agenda-delete-${event.id}`}
                        onPress={() =>
                          Alert.alert("Delete event?", event.title || "This event", [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Delete",
                              style: "destructive",
                              onPress: () => remove.mutate(event.id),
                            },
                          ])
                        }
                        className="h-9 w-9 items-center justify-center rounded-full border border-line active:opacity-70"
                      >
                        <Trash2 color="#E2574C" size={15} />
                      </Pressable>
                    ) : null}
                  </View>
                </Card>
              </Pressable>
            </Animated.View>
          ))}
        </View>
      </ScrollView>

      <Sheet
        visible={composerOpen}
        onClose={closeComposer}
        title={editing ? "Edit event" : "New event"}
        testID="agenda-composer"
      >
        <Label>Title</Label>
        <TextInput
          testID="agenda-title"
          value={title}
          onChangeText={setTitle}
          placeholder="What is it?"
          placeholderTextColor="#5F656F"
          className="mt-2 rounded-2xl border border-line bg-ink-700 px-4 py-3 text-base text-bone"
        />
        <View className="mt-4 flex-row space-x-3">
          <View className="flex-1">
            <Label>Start</Label>
            <TextInput
              testID="agenda-start"
              value={startClock}
              onChangeText={setStartClock}
              placeholder="09:00"
              placeholderTextColor="#5F656F"
              autoCapitalize="none"
              className="mt-2 rounded-2xl border border-line bg-ink-700 px-4 py-3 text-base text-bone"
            />
          </View>
          <View className="flex-1">
            <Label>End</Label>
            <TextInput
              testID="agenda-end"
              value={endClock}
              onChangeText={setEndClock}
              placeholder="10:00"
              placeholderTextColor="#5F656F"
              autoCapitalize="none"
              className="mt-2 rounded-2xl border border-line bg-ink-700 px-4 py-3 text-base text-bone"
            />
          </View>
        </View>

        <Label className="mt-4">Calendar</Label>
        {calendars.isLoading ? <Text className="mt-2 text-sm text-muted">Loading…</Text> : null}
        {writable.length === 0 && !calendars.isLoading ? (
          <Text className="mt-2 text-sm text-warn">
            No writable calendars. Set write access on the Mac → Gateway.
          </Text>
        ) : null}
        <View className="mt-2 space-y-2">
          {writable.map((cal) => {
            const active = (calendarId ?? writable[0]?.id) === cal.id;
            return (
              <Pressable
                key={cal.id}
                testID={`agenda-cal-${cal.id}`}
                onPress={() => setCalendarId(cal.id)}
                className={cn(
                  "rounded-2xl border px-3 py-2.5",
                  active ? "border-brass/50 bg-brass/10" : "border-line"
                )}
              >
                <Text className={cn("text-sm", active ? "text-brass" : "text-bone")}>
                  {cal.title}
                </Text>
                <Text className="text-xs text-faint">{cal.sourceTitle}</Text>
              </Pressable>
            );
          })}
        </View>

        {saveError ? (
          <View className="mt-3">
            <Notice tone="error">
              {desktopErrorMessage(
                saveError,
                editing ? "Couldn't update that event." : "Couldn't create that event."
              )}
            </Notice>
          </View>
        ) : null}

        <View className="mt-5">
          <Button
            testID={editing ? "agenda-save" : "agenda-create"}
            label={
              saving ? "Saving…" : editing ? "Save changes" : "Add to calendar"
            }
            disabled={
              !title.trim() ||
              saving ||
              (!editing && writable.length === 0)
            }
            onPress={() => (editing ? update.mutate() : create.mutate())}
          />
        </View>
      </Sheet>

      <Sheet
        visible={placeOpen}
        onClose={() => {
          setPlaceOpen(false);
          setPlaceBlock(null);
        }}
        title={placeBlock ? `Place in ${placeBlock.name}` : "Place reminder"}
        testID="agenda-place-sheet"
      >
        <Text className="text-sm text-muted">
          {placeBlock
            ? `${placeBlock.start} – ${placeBlock.end}. Pick an open Apple Reminder.`
            : "Pick a time block first."}
        </Text>
        <Label className="mt-4">Duration (minutes)</Label>
        <TextInput
          testID="agenda-place-minutes"
          value={placeMinutes}
          onChangeText={setPlaceMinutes}
          keyboardType="number-pad"
          placeholder="30"
          placeholderTextColor="#5F656F"
          className="mt-2 rounded-2xl border border-line bg-ink-700 px-4 py-3 text-base text-bone"
        />
        <Label className="mt-4">Reminder</Label>
        {openReminders.isLoading ? <Text className="mt-2 text-sm text-muted">Loading…</Text> : null}
        {(openReminders.data?.reminders ?? []).length === 0 && !openReminders.isLoading ? (
          <Text className="mt-2 text-sm text-warn">No open Apple Reminders on the Mac.</Text>
        ) : null}
        <View className="mt-2 space-y-2">
          {(openReminders.data?.reminders ?? []).map((rem) => {
            const active = placeReminderId === rem.id;
            return (
              <Pressable
                key={rem.id}
                testID={`agenda-place-rem-${rem.id}`}
                onPress={() => setPlaceReminderId(rem.id)}
                className={cn(
                  "rounded-2xl border px-3 py-2.5",
                  active ? "border-brass/50 bg-brass/10" : "border-line"
                )}
              >
                <Text className={cn("text-sm", active ? "text-brass" : "text-bone")}>{rem.title}</Text>
                {rem.due ? <Text className="text-xs text-faint">Due {rem.due}</Text> : null}
              </Pressable>
            );
          })}
        </View>
        <View className="mt-5">
          <Button
            testID="agenda-place-submit"
            label={place.isPending ? "Placing…" : "Place on calendar"}
            disabled={!placeReminderId || !placeBlock || place.isPending}
            onPress={() => place.mutate(undefined)}
          />
        </View>
      </Sheet>
    </Backdrop>
  );
}
