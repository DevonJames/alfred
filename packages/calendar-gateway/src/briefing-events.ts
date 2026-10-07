import { agendaWindow } from "./agenda.js";
import { createEventKitGateway, type CalendarEvent, type CalendarGateway } from "./helper.js";
import { mergeCalendarAccess, readableCalendars, type CalendarPolicy } from "./policy.js";
import { loadCalendarPolicy } from "./store.js";

export interface BriefingAgendaEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarTitle: string;
}

/** Events on today's calendar date, from the selected calendars that still have Read or Write. */
export async function loadBriefingAgendaEvents(input: {
  policyPath: string;
  calendarIds: string[];
  timeZone: string;
  now?: Date;
  gateway?: Pick<CalendarGateway, "catalog" | "events">;
  policy?: CalendarPolicy;
}): Promise<BriefingAgendaEvent[]> {
  const wanted = new Set(input.calendarIds.map((id) => id.trim()).filter(Boolean));
  if (!wanted.size) return [];
  const gateway = input.gateway ?? createEventKitGateway(input.policyPath);
  const [discovered, policy] = await Promise.all([
    gateway.catalog(),
    input.policy ?? loadCalendarPolicy(input.policyPath),
  ]);
  const allowed = new Set(
    readableCalendars(mergeCalendarAccess(discovered, policy).sources)
      .map((calendar) => calendar.id)
      .filter((id) => wanted.has(id)),
  );
  if (!allowed.size) return [];
  const now = input.now ?? new Date();
  const window = agendaWindow("today", now, input.timeZone);
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const events = await gateway.events({ start: window.start, end: window.end });
  return events
    .filter((event) => allowed.has(event.calendarId) && overlaps(event, startMs, endMs))
    .sort(byAgendaOrder)
    .map((event) => ({
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      calendarTitle: event.calendarTitle,
    }));
}

function overlaps(event: CalendarEvent, startMs: number, endMs: number): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return start < endMs && end > startMs;
}

function byAgendaOrder(a: CalendarEvent, b: CalendarEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
}
