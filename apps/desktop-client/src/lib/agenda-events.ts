/**
 * Shared EventKit create/update/delete for local agenda UI and phone /api/agenda.
 */
import {
  calendarPolicyPath,
  CalendarHelperError,
  createEventKitGateway,
  loadCalendarPolicy,
  mergeCalendarAccess,
  readableCalendars,
  zonedDateTime,
  type CalendarEvent,
} from "@alfred/calendar-gateway";
import { agendaTimeZone } from "./agenda-turn.js";

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

export function clockOnDate(date: string, hhmm: string, zone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  return zonedDateTime(zone, year ?? 0, month ?? 1, day ?? 1, hour ?? 0, minute ?? 0);
}

export function clockOnDay(anchor: string, hhmm: string, zone: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const bag = Object.fromEntries(
    fmt.formatToParts(new Date(anchor)).map((part) => [part.type, part.value]),
  );
  return zonedDateTime(
    zone,
    Number(bag.year),
    Number(bag.month),
    Number(bag.day),
    hour ?? 0,
    minute ?? 0,
  );
}

export type AgendaCalendarSummary = {
  id: string;
  title: string;
  sourceTitle: string;
  access: "none" | "read" | "write";
  color?: string;
};

export async function listAgendaCalendars(): Promise<AgendaCalendarSummary[]> {
  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  return readableCalendars(mergeCalendarAccess(discovered, policy).sources).map((c) => ({
    id: c.id,
    title: c.title,
    sourceTitle: c.sourceTitle,
    access: c.access,
    color: c.color ?? undefined,
  }));
}

export async function createAgendaEvent(input: {
  calendarId: string;
  title: string;
  start: string;
  end: string;
  date: string;
}): Promise<CalendarEvent> {
  const zone = agendaTimeZone();
  const start = clockOnDate(input.date, input.start, zone);
  let end = clockOnDate(input.date, input.end, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);

  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  const destination = readableCalendars(mergeCalendarAccess(discovered, policy).sources).find(
    (calendar) => calendar.id === input.calendarId,
  );
  if (!destination || destination.access !== "write") {
    throw Object.assign(new Error("That calendar is not open for writes."), {
      status: 403,
      code: "calendar_denied",
    });
  }
  return gateway.create({
    calendarId: input.calendarId,
    title: input.title,
    start: start.toISOString(),
    end: end.toISOString(),
  });
}

export async function updateAgendaEvent(input: {
  id: string;
  title: string;
  start: string;
  end: string;
  anchor: string;
  calendarId?: string;
}): Promise<CalendarEvent> {
  const zone = agendaTimeZone();
  const start = clockOnDay(input.anchor, input.start, zone);
  let end = clockOnDay(input.anchor, input.end, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);

  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  if (input.calendarId) {
    const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
    const destination = readableCalendars(mergeCalendarAccess(discovered, policy).sources).find(
      (calendar) => calendar.id === input.calendarId,
    );
    if (!destination || destination.access !== "write") {
      throw Object.assign(new Error("That calendar is not open for writes."), {
        status: 403,
        code: "calendar_denied",
      });
    }
  }
  return gateway.update({
    eventId: input.id,
    title: input.title,
    start: start.toISOString(),
    end: end.toISOString(),
    ...(input.calendarId ? { calendarId: input.calendarId } : {}),
  });
}

export async function deleteAgendaEvent(id: string): Promise<void> {
  const gateway = createEventKitGateway(calendarPolicyPath(profileId()));
  await gateway.delete(id);
}

export function agendaHttpError(err: unknown): { message: string; status: 403 | 500 } {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    (err as { status?: number }).status === 403 ||
    (err instanceof CalendarHelperError && err.code === "calendar_denied") ||
    (err as { code?: string }).code === "calendar_denied"
      ? 403
      : 500;
  return { message, status };
}
