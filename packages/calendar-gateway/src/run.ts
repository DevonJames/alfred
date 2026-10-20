import { answerNextAgendaItem, looksLikeNextAgendaQuestion } from "./agenda.js";
import type { CalendarEvent, CalendarGateway } from "./helper.js";
import { interpretCalendarTask } from "./planner.js";
import type { CalendarRow } from "./policy.js";

function formatWhen(iso: string, timeZone: string, allDay = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: allDay ? undefined : "numeric",
    minute: allDay ? undefined : "2-digit",
  }).format(new Date(iso));
}

function eventLine(event: CalendarEvent, timeZone: string): string {
  const when = formatWhen(event.start, timeZone, event.allDay);
  return `${event.title}, ${when}, on ${event.calendarTitle} (${event.sourceTitle})`;
}

function matches(query: string, event: CalendarEvent): boolean {
  const title = event.title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (title.length < 3) return title === q;
  return title.includes(q) || q.includes(title);
}

export async function runCalendarTask(input: {
  task: string;
  now: Date;
  timeZone: string;
  calendars: CalendarRow[];
  gateway: CalendarGateway;
  context?: string;
}): Promise<string> {
  const plan = interpretCalendarTask(input);
  if (plan.clarify) return plan.clarify;
  const creates = plan.commands.filter((command) => command.op === "create");
  if (creates.length > 1 && creates.length === plan.commands.length) {
    const made: CalendarEvent[] = [];
    const failed: string[] = [];
    for (const command of creates) {
      try {
        made.push(
          await input.gateway.create({
            calendarId: command.calendarId,
            title: command.title,
            start: command.start,
            end: command.end,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push(`${command.title}: ${message}`);
      }
    }
    if (made.length === 0) return failed.join(" ") || "I didn't change the calendar.";
    const first = made[0]!;
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: input.timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(first.start));
    const clock = (iso: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(iso));
    const list = made
      .map((event) => `${clock(event.start)}–${clock(event.end)} ${event.title}`)
      .join("; ");
    const where = `${first.calendarTitle} (${first.sourceTitle})`;
    const summary = `Added ${made.length} events on ${where} for ${day}: ${list}.`;
    return failed.length ? `${summary} Couldn't add ${failed.join("; ")}.` : summary;
  }
  const lines: string[] = [];
  for (const command of plan.commands) {
    if (command.op === "list") {
      const nextAsk = looksLikeNextAgendaQuestion(input.task);
      // "What's next" needs wall-clock now and a look-ahead past midnight when today is done.
      const start = command.start;
      const end = nextAsk
        ? new Date(Math.max(Date.parse(command.end), input.now.getTime() + 7 * 86_400_000)).toISOString()
        : command.end;
      const events = await input.gateway.events({
        start,
        end,
        calendarId: command.calendarId,
      });
      if (nextAsk) {
        const nextAnswer = answerNextAgendaItem({
          text: input.task,
          now: input.now,
          timeZone: input.timeZone,
          events: events.map((event) => ({
            title: event.title,
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            calendarTitle: event.calendarTitle,
            sourceTitle: event.sourceTitle,
          })),
        });
        if (nextAnswer) {
          lines.push(nextAnswer);
          continue;
        }
      }
      if (events.length === 0) {
        lines.push("Nothing on the calendars you have opened for that stretch.");
        continue;
      }
      lines.push(events.map((event) => eventLine(event, input.timeZone)).join(". "));
      continue;
    }
    if (command.op === "create") {
      const event = await input.gateway.create({
        calendarId: command.calendarId,
        title: command.title,
        start: command.start,
        end: command.end,
      });
      const minutes = Math.round(
        (new Date(command.end).getTime() - new Date(command.start).getTime()) / 60_000,
      );
      lines.push(`Added ${eventLine(event, input.timeZone)} for ${minutes} minutes.`);
      continue;
    }
    const events = (await input.gateway.events({ start: command.start, end: command.end })).filter(
      (event) => matches(command.query, event),
    );
    if (events.length === 0) {
      lines.push(`I couldn't find “${command.query}” on a calendar you opened for writes.`);
      continue;
    }
    if (events.length > 1) {
      lines.push(
        `I found more than one “${command.query}”: ${events
          .map((event) => eventLine(event, input.timeZone))
          .join("; ")}.`,
      );
      continue;
    }
    const event = events[0]!;
    const calendar = input.calendars.find((item) => item.id === event.calendarId);
    if (!calendar || calendar.access !== "write") {
      lines.push(`${event.title} is on ${event.calendarTitle}, which is not open for writes.`);
      continue;
    }
    if (command.op === "delete") {
      await input.gateway.delete(event.id);
      lines.push(`Deleted ${eventLine(event, input.timeZone)}.`);
      continue;
    }
    const duration = new Date(event.end).getTime() - new Date(event.start).getTime();
    const updated = await input.gateway.update({
      eventId: event.id,
      start: command.newStart,
      end: new Date(new Date(command.newStart).getTime() + duration).toISOString(),
    });
    lines.push(`Moved it to ${eventLine(updated, input.timeZone)}.`);
  }
  return lines.join(" ") || "I didn't change the calendar.";
}
