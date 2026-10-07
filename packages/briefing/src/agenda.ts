import { speakClockTime } from "./speech.js";

export interface BriefingAgendaEvent {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  calendarTitle?: string;
}

export interface BriefingAgendaSlice {
  enabled: boolean;
  events: BriefingAgendaEvent[];
}

const SPEECH_CAP = 16;

export function formatAgendaSpeech(
  events: BriefingAgendaEvent[],
  timezone: string,
): string | null {
  if (!events.length) return null;
  const shown = events.slice(0, SPEECH_CAP).map((event) => speakAgendaEvent(event, timezone));
  const extra = events.length - shown.length;
  const body = joinSpoken(shown);
  const more = extra > 0 ? ` and ${extra} more` : "";
  return `On your agenda today: ${body}${more}.`;
}

export function formatAgendaMarkdown(events: BriefingAgendaEvent[], timezone: string): string {
  if (!events.length) return "## Agenda\n\nNothing today.";
  const lines = events.map((event) => {
    const when = event.allDay ? "All day" : clockSpan(event, timezone);
    const calendar = event.calendarTitle ? ` (${event.calendarTitle})` : "";
    return `- ${event.title} — ${when}${calendar}`;
  });
  return ["## Agenda", "", ...lines].join("\n");
}

function speakAgendaEvent(event: BriefingAgendaEvent, timezone: string): string {
  if (event.allDay) return `${event.title}, all day`;
  const start = speakClockTime(new Date(event.start), timezone);
  const end = speakClockTime(new Date(event.end), timezone);
  if (start === end) return `${event.title} at ${start}`;
  return `${event.title} from ${start} to ${end}`;
}

function joinSpoken(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function clockSpan(event: BriefingAgendaEvent, timezone: string): string {
  const clock = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  const start = clock(event.start);
  const end = clock(event.end);
  return start === end ? start : `${start}–${end}`;
}
