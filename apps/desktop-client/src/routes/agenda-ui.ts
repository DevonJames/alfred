import {
  agendaWindow,
  calendarPolicyPath,
  CalendarHelperError,
  createEventKitGateway,
  loadCalendarPolicy,
  mergeCalendarAccess,
  readableCalendars,
  zonedDateTime,
  type CalendarEvent,
} from "@alfred/calendar-gateway";
import { dateKeyInZone, dueDateKey } from "@alfred/reminders-gateway";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agendaBoard,
  agendaFocusInstant,
  agendaTimeZone,
  agendaViewFrom,
  answerAgendaTurn,
  setAgendaEar,
} from "../lib/agenda-turn.js";
import {
  blockRunsOn,
  formatClock,
  loadAgendaBlocks,
  nextFittingDay,
  parseClock,
  placeInBlock,
  saveAgendaBlocks,
  shiftDate,
  type AgendaTimeBlock,
  type BlockRepeat,
  type BusySpan,
} from "../lib/agenda-blocks.js";
import { listOpenReminders } from "../lib/message-commitments.js";
import { isSpeechEngineStack, primeVerbatimSpeech } from "../lib/speech-engine.js";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const agendaUiRouter = new Hono();

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

/** GET /agenda — agenda board. */
agendaUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "agenda.html"), "utf8");
  return c.html(html);
});

/** GET /agenda/board?view=today|week&date=YYYY-MM-DD */
agendaUiRouter.get("/board", async (c) => {
  const view = agendaViewFrom(c.req.query("view"));
  const zone = agendaTimeZone();
  const focus = agendaFocusInstant(c.req.query("date"), zone);
  try {
    return c.json(await agendaBoard(view, focus));
  } catch (err) {
    const window = agendaWindow(view, new Date(), zone, focus);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ...window, calendars: [], error: message });
  }
});

/** POST /agenda/event/delete — remove one event from a calendar open for writes. */
agendaUiRouter.post("/event/delete", async (c) => {
  let body: { id?: unknown };
  try {
    body = (await c.req.json()) as { id?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    const gateway = createEventKitGateway(calendarPolicyPath(profileId()));
    await gateway.delete(id);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalendarHelperError && err.code === "calendar_denied" ? 403 : 500;
    return c.json({ error: message }, status);
  }
});

/** POST /agenda/event/create — add one event on a calendar open for writes. */
agendaUiRouter.post("/event/create", async (c) => {
  let body: { calendarId?: unknown; title?: unknown; start?: unknown; end?: unknown; date?: unknown };
  try {
    body = (await c.req.json()) as {
      calendarId?: unknown;
      title?: unknown;
      start?: unknown;
      end?: unknown;
      date?: unknown;
    };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const calendarId = typeof body.calendarId === "string" ? body.calendarId.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const startClock = typeof body.start === "string" ? body.start.trim() : "";
  const endClock = typeof body.end === "string" ? body.end.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (
    !calendarId ||
    !title ||
    !/^\d{2}:\d{2}$/.test(startClock) ||
    !/^\d{2}:\d{2}$/.test(endClock) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return c.json({ error: "An event needs a calendar, a title, a start, and an end." }, 400);
  }
  const zone = agendaTimeZone();
  const start = clockOnDate(date, startClock, zone);
  let end = clockOnDate(date, endClock, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
  try {
    const file = calendarPolicyPath(profileId());
    const gateway = createEventKitGateway(file);
    const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
    const destination = readableCalendars(mergeCalendarAccess(discovered, policy).sources).find(
      (calendar) => calendar.id === calendarId,
    );
    if (!destination || destination.access !== "write") {
      return c.json({ error: "That calendar is not open for writes." }, 403);
    }
    const event = await gateway.create({
      calendarId,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
    });
    return c.json({ ok: true, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalendarHelperError && err.code === "calendar_denied" ? 403 : 500;
    return c.json({ error: message }, status);
  }
});

/** POST /agenda/event/update — change the title, clock time, or writable calendar of one event. */
agendaUiRouter.post("/event/update", async (c) => {
  let body: { id?: unknown; title?: unknown; start?: unknown; end?: unknown; anchor?: unknown; calendarId?: unknown };
  try {
    body = (await c.req.json()) as {
      id?: unknown;
      title?: unknown;
      start?: unknown;
      end?: unknown;
      anchor?: unknown;
      calendarId?: unknown;
    };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const startClock = typeof body.start === "string" ? body.start.trim() : "";
  const endClock = typeof body.end === "string" ? body.end.trim() : "";
  const anchor = typeof body.anchor === "string" ? body.anchor.trim() : "";
  const calendarId = typeof body.calendarId === "string" ? body.calendarId.trim() : "";
  if (!id || !title || !/^\d{2}:\d{2}$/.test(startClock) || !/^\d{2}:\d{2}$/.test(endClock) || !anchor) {
    return c.json({ error: "An event needs a title, a start, and an end." }, 400);
  }
  const zone = agendaTimeZone();
  const start = clockOnDay(anchor, startClock, zone);
  let end = clockOnDay(anchor, endClock, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
  try {
    const file = calendarPolicyPath(profileId());
    const gateway = createEventKitGateway(file);
    if (calendarId) {
      const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
      const destination = readableCalendars(mergeCalendarAccess(discovered, policy).sources).find(
        (calendar) => calendar.id === calendarId,
      );
      if (!destination || destination.access !== "write") {
        return c.json({ error: "That calendar is not open for writes." }, 403);
      }
    }
    const event = await gateway.update({
      eventId: id,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      ...(calendarId ? { calendarId } : {}),
    });
    return c.json({ ok: true, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalendarHelperError && err.code === "calendar_denied" ? 403 : 500;
    return c.json({ error: message }, status);
  }
});

/** GET /agenda/settings — name the day's time blocks. */
agendaUiRouter.get("/settings", async (c) => {
  const html = await readFile(resolve(uiDir, "agenda-settings.html"), "utf8");
  return c.html(html);
});

agendaUiRouter.get("/blocks", async (c) => {
  const file = await loadAgendaBlocks(profileId());
  return c.json({ blocks: file.blocks });
});

agendaUiRouter.put("/blocks", async (c) => {
  let body: { blocks?: unknown };
  try {
    body = (await c.req.json()) as { blocks?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.blocks)) return c.json({ error: "Expected blocks" }, 400);
  const blocks: AgendaTimeBlock[] = [];
  for (const raw of body.blocks) {
    const block = cleanBlock(raw);
    if (!block) return c.json({ error: "Each block needs a name, a time range, and a calendar." }, 400);
    blocks.push(block);
  }
  const existing = await loadAgendaBlocks(profileId());
  await saveAgendaBlocks({ blocks, placed: existing.placed }, profileId());
  return c.json({ ok: true, blocks });
});

agendaUiRouter.get("/calendars", async (c) => {
  try {
    const calendars = await writableCalendars();
    return c.json({
      calendars: calendars.map((calendar) => ({
        id: calendar.id,
        title: calendar.title,
        sourceTitle: calendar.sourceTitle,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ calendars: [], error: message }, 200);
  }
});

agendaUiRouter.get("/reminders", async (c) => {
  try {
    const zone = agendaTimeZone();
    const reminders = await listOpenReminders();
    return c.json({
      reminders: reminders
        .filter((reminder) => !reminder.completed)
        .map((reminder) => ({
          id: reminder.id,
          title: reminder.title,
          due: dueDateKey(reminder.due, zone),
          listTitle: reminder.listTitle,
        })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ reminders: [], error: message }, 200);
  }
});

/** POST /agenda/place — drop a reminder into a time block, or ask before overlapping. */
agendaUiRouter.post("/place", async (c) => {
  let body: {
    reminderId?: unknown;
    blockId?: unknown;
    durationMinutes?: unknown;
    date?: unknown;
    choice?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const reminderId = typeof body.reminderId === "string" ? body.reminderId.trim() : "";
  const blockId = typeof body.blockId === "string" ? body.blockId.trim() : "";
  const duration = typeof body.durationMinutes === "number" ? Math.round(body.durationMinutes) : Number.NaN;
  const selected = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  const choice = body.choice === "overlap" || body.choice === "next" ? body.choice : null;
  if (!reminderId || !blockId || !Number.isFinite(duration) || duration < 5 || duration > 12 * 60) {
    return c.json({ error: "Choose a reminder, a time block, and a duration." }, 400);
  }
  const zone = agendaTimeZone();
  const today = dateKeyInZone(new Date(), zone);
  const stored = await loadAgendaBlocks(profileId());
  const block = stored.blocks.find((item) => item.id === blockId);
  if (!block) return c.json({ error: "That time block is gone. Set it up again." }, 400);
  const blockStart = parseClock(block.start);
  const blockEnd = parseClock(block.end);
  if (blockStart == null || blockEnd == null) return c.json({ error: "That time block has no hours." }, 400);
  let reminder: { id: string; title: string; due: string | null };
  try {
    const found = (await listOpenReminders()).find((item) => item.id === reminderId && !item.completed);
    if (!found) return c.json({ error: "That reminder is no longer open." }, 404);
    reminder = { id: found.id, title: found.title, due: dueDateKey(found.due, zone) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
  const target = selected || reminder.due || today;
  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const access = await calendarAccess(file);
  const destination = access.writable.find((calendar) => calendar.id === block.calendarId);
  if (!destination) return c.json({ error: "The calendar for this block is not open for writes." }, 403);
  const rangeStart = zonedDateTime(zone, ...splitDate(target), 0, 0);
  const rangeEnd = zonedDateTime(zone, ...splitDate(shiftDate(target, 15)), 0, 0);
  let events: CalendarEvent[] = [];
  try {
    events = await gateway.events({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
    events = events.filter((event) => !access.skipOverlapIds.has(event.calendarId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
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
    return c.json({
      ok: false,
      choice: "off-day",
      message: `${block.name} does not run on ${dayLabel(target)}.`,
      next: next ? describe(next.date, next.startMin) : null,
    });
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
      const event = await createPlaced(gateway, destination.id, reminder.title, isoDate, startMin, duration, zone);
      stored.placed.push(event.id);
      await saveAgendaBlocks(stored, profileId());
      return c.json({ ok: true, ...describe(isoDate, startMin), event });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
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
      return c.json({
        ok: false,
        choice: placed.status,
        message:
          placed.status === "overlap"
            ? `This overlaps ${placed.overlapTitle}.`
            : `${block.name} is shorter than this duration.`,
        overlapTitle: placed.overlapTitle,
        next: next ? describe(next.date, next.startMin) : null,
      });
    }
    const next = nextFittingDay({
      fromDate: shiftDate(target, 1),
      block,
      duration,
      eventsOn,
      reminderIds: stored.placed,
    });
    if (!next) return c.json({ error: `No open ${block.name} in the next two weeks.` }, 400);
    return commit(next.date, next.startMin);
  }

  return commit(target, placed.startMin);
});

function cleanBlock(raw: unknown): AgendaTimeBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const start = typeof row.start === "string" ? row.start : "";
  const end = typeof row.end === "string" ? row.end : "";
  const calendarId = typeof row.calendarId === "string" ? row.calendarId.trim() : "";
  const repeat = row.repeat;
  const days = Array.isArray(row.days)
    ? [...new Set(row.days.filter((day): day is number => typeof day === "number" && day >= 0 && day <= 6))]
    : [];
  const startMin = parseClock(start);
  const endMin = parseClock(end);
  if (!name || !calendarId || startMin == null || endMin == null || startMin >= endMin) return null;
  if (repeat !== "all" && repeat !== "weekdays" && repeat !== "weekends" && repeat !== "custom") return null;
  if (repeat === "custom" && !days.length) return null;
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : randomUUID();
  return {
    id,
    name: name.slice(0, 80),
    start,
    end,
    repeat: repeat as BlockRepeat,
    days,
    calendarId,
  };
}

async function writableCalendars() {
  return (await calendarAccess(calendarPolicyPath(profileId()))).writable;
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

function clockOnDate(date: string, hhmm: string, zone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  return zonedDateTime(zone, year ?? 0, month ?? 1, day ?? 1, hour ?? 0, minute ?? 0);
}

function clockOnDay(anchor: string, hhmm: string, zone: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const bag = Object.fromEntries(fmt.formatToParts(new Date(anchor)).map((part) => [part.type, part.value]));
  return zonedDateTime(zone, Number(bag.year), Number(bag.month), Number(bag.day), hour, minute);
}

/** POST /agenda/voice — hand a finished reply to the live Speech Engine session. */
agendaUiRouter.post("/voice", async (c) => {
  if (!isSpeechEngineStack()) {
    return c.json({ error: "Alfred's voice is the Speech Engine from make alfred VOICE=live2." }, 503);
  }
  let body: { text?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  primeVerbatimSpeech(text);
  return c.json({ ok: true });
});

/** POST /agenda/ear — Agenda is the screen in front, so the next spoken turn uses this view. */
agendaUiRouter.post("/ear", async (c) => {
  let body: { active?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  try {
    body = (await c.req.json()) as { active?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (body.active === false) {
    setAgendaEar(null);
    return c.json({ ok: true });
  }
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
  setAgendaEar({ view: agendaViewFrom(body.view), unified: body.unified === true, date });
  return c.json({ ok: true });
});

/** POST /agenda/say — typed text, with the agenda view attached. */
agendaUiRouter.post("/say", async (c) => {
  let body: { text?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
  try {
    const assistantText = await answerAgendaTurn({
      text,
      view: agendaViewFrom(body.view),
      unified: body.unified === true,
      date,
    });
    return c.json({ assistantText });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
