/**
 * Place an Apple Reminder into a named time block (EventKit event).
 * Shared by local /agenda HTML UI and phone /api/agenda.
 */
import {
  calendarPolicyPath,
  createEventKitGateway,
  loadCalendarPolicy,
  mergeCalendarAccess,
  readableCalendars,
  zonedDateTime,
  type CalendarEvent,
} from "@alfred/calendar-gateway";
import { dateKeyInZone, dueDateKey } from "@alfred/reminders-gateway";
import {
  blockRunsOn,
  formatClock,
  loadAgendaBlocks,
  nextFittingDay,
  parseClock,
  placeInBlock,
  saveAgendaBlocks,
  shiftDate,
  type BusySpan,
} from "./agenda-blocks.js";
import { agendaTimeZone } from "./agenda-turn.js";
import { listOpenReminders } from "./message-commitments.js";

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

function splitDate(isoDate: string): [number, number, number] {
  const [year, month, day] = isoDate.split("-").map(Number);
  return [year ?? 0, month ?? 1, day ?? 1];
}

function dayLabel(isoDate: string): string {
  const [year, month, day] = splitDate(isoDate);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function minutesInZone(iso: string, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const bag = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = bag.hour === "24" ? 0 : Number(bag.hour);
  return hour * 60 + Number(bag.minute);
}

function dateInZone(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function spanOnDay(event: CalendarEvent, day: string, zone: string): BusySpan | null {
  if (event.allDay) return null;
  const startDay = dateInZone(event.start, zone);
  const endDay = dateInZone(event.end, zone);
  if (startDay > day || endDay < day) return null;
  const startMin = startDay < day ? 0 : minutesInZone(event.start, zone);
  let endMin = endDay > day ? 24 * 60 : minutesInZone(event.end, zone);
  if (endMin <= startMin) endMin = startMin + 1;
  return { id: event.id, title: event.title, startMin, endMin };
}

async function calendarAccess(file: string) {
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  const sources = mergeCalendarAccess(discovered, policy).sources;
  return {
    writable: readableCalendars(sources).filter((calendar) => calendar.access === "write"),
    skipOverlapIds: new Set(
      sources.flatMap((source) =>
        source.calendars.filter((calendar) => calendar.ignoreOverlaps).map((calendar) => calendar.id),
      ),
    ),
  };
}

async function createPlaced(
  gateway: ReturnType<typeof createEventKitGateway>,
  calendarId: string,
  title: string,
  isoDate: string,
  startMin: number,
  duration: number,
  zone: string,
) {
  const [year, month, day] = splitDate(isoDate);
  const start = zonedDateTime(zone, year, month, day, Math.floor(startMin / 60), startMin % 60);
  const endMin = startMin + duration;
  const endDay = endMin >= 24 * 60 ? shiftDate(isoDate, 1) : isoDate;
  const endClock = endMin >= 24 * 60 ? endMin - 24 * 60 : endMin;
  const [endYear, endMonth, endDate] = splitDate(endDay);
  const end = zonedDateTime(zone, endYear, endMonth, endDate, Math.floor(endClock / 60), endClock % 60);
  return gateway.create({
    calendarId,
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    notes: "Placed from Reminders.",
  });
}

export type PlaceReminderChoice = "overlap" | "next" | null;

export type PlaceReminderResult =
  | {
      ok: true;
      event: CalendarEvent;
      date: string;
      start: string;
      end: string;
      label: string;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

export async function listOpenRemindersForPlace(): Promise<
  Array<{ id: string; title: string; due: string | null }>
> {
  const zone = agendaTimeZone();
  const reminders = await listOpenReminders();
  return reminders
    .filter((item) => !item.completed)
    .map((reminder) => ({
      id: reminder.id,
      title: reminder.title,
      due: dueDateKey(reminder.due, zone),
    }));
}

export async function placeReminderInBlock(input: {
  reminderId: string;
  blockId: string;
  durationMinutes: number;
  date?: string | null;
  choice?: PlaceReminderChoice;
}): Promise<PlaceReminderResult> {
  const { reminderId, blockId, durationMinutes: duration, choice } = input;
  if (!reminderId || !blockId || !Number.isFinite(duration) || duration < 5 || duration > 12 * 60) {
    return {
      ok: false,
      status: 400,
      body: { error: "Choose a reminder, a time block, and a duration." },
    };
  }
  const zone = agendaTimeZone();
  const today = dateKeyInZone(new Date(), zone);
  const stored = await loadAgendaBlocks(profileId());
  const block = stored.blocks.find((item) => item.id === blockId);
  if (!block) {
    return { ok: false, status: 400, body: { error: "That time block is gone. Set it up again." } };
  }
  const blockStart = parseClock(block.start);
  const blockEnd = parseClock(block.end);
  if (blockStart == null || blockEnd == null) {
    return { ok: false, status: 400, body: { error: "That time block has no hours." } };
  }

  let reminder: { id: string; title: string; due: string | null };
  try {
    const found = (await listOpenReminders()).find((item) => item.id === reminderId && !item.completed);
    if (!found) {
      return { ok: false, status: 404, body: { error: "That reminder is no longer open." } };
    }
    reminder = { id: found.id, title: found.title, due: dueDateKey(found.due, zone) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 400, body: { error: message } };
  }

  const selected =
    typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null;
  const target = selected || reminder.due || today;
  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const access = await calendarAccess(file);
  const destination = access.writable.find((calendar) => calendar.id === block.calendarId);
  if (!destination) {
    return {
      ok: false,
      status: 403,
      body: { error: "The calendar for this block is not open for writes." },
    };
  }

  const rangeStart = zonedDateTime(zone, ...splitDate(target), 0, 0);
  const rangeEnd = zonedDateTime(zone, ...splitDate(shiftDate(target, 15)), 0, 0);
  let events: CalendarEvent[] = [];
  try {
    events = await gateway.events({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
    events = events.filter((event) => !access.skipOverlapIds.has(event.calendarId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, body: { error: message } };
  }

  const eventsOn = (isoDate: string) =>
    events.flatMap((event) => {
      const span = spanOnDay(event, isoDate, zone);
      return span ? [span] : [];
    });
  const describe = (isoDate: string, startMin: number) => ({
    date: isoDate,
    start: formatClock(startMin),
    end: formatClock(startMin + duration),
    label: dayLabel(isoDate),
  });

  if (!blockRunsOn(block, target) && choice !== "next") {
    const next = nextFittingDay({
      fromDate: shiftDate(target, 1),
      block,
      duration,
      eventsOn,
      reminderIds: stored.placed,
    });
    return {
      ok: false,
      status: 200,
      body: {
        ok: false,
        choice: "off-day",
        message: `${block.name} does not run on ${dayLabel(target)}.`,
        next: next ? describe(next.date, next.startMin) : null,
      },
    };
  }

  const attemptDate = !blockRunsOn(block, target) ? null : target;
  const placed = attemptDate
    ? placeInBlock({
        blockStart,
        blockEnd,
        duration,
        events: eventsOn(attemptDate),
        reminderIds: stored.placed,
      })
    : null;

  const commit = async (isoDate: string, startMin: number) => {
    try {
      const event = await createPlaced(
        gateway,
        destination.id,
        reminder.title,
        isoDate,
        startMin,
        duration,
        zone,
      );
      stored.placed.push(event.id);
      await saveAgendaBlocks(stored, profileId());
      return {
        ok: true as const,
        event,
        ...describe(isoDate, startMin),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, status: 500, body: { error: message } };
    }
  };

  if (choice === "next" || !placed || placed.status !== "fit") {
    if (choice === "overlap" && placed?.status === "overlap") {
      return commit(target, placed.startMin);
    }
    if (choice !== "next" && placed && placed.status !== "fit") {
      const next = nextFittingDay({
        fromDate: shiftDate(target, 1),
        block,
        duration,
        eventsOn,
        reminderIds: stored.placed,
      });
      return {
        ok: false,
        status: 200,
        body: {
          ok: false,
          choice: placed.status,
          message:
            placed.status === "overlap"
              ? `This overlaps ${placed.overlapTitle}.`
              : `${block.name} is shorter than this duration.`,
          overlapTitle: placed.overlapTitle,
          next: next ? describe(next.date, next.startMin) : null,
        },
      };
    }
    const next = nextFittingDay({
      fromDate: shiftDate(target, 1),
      block,
      duration,
      eventsOn,
      reminderIds: stored.placed,
    });
    if (!next) {
      return {
        ok: false,
        status: 400,
        body: { error: `No open ${block.name} in the next two weeks.` },
      };
    }
    return commit(next.date, next.startMin);
  }

  return commit(target, placed.startMin);
}
