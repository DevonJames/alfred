export type AgendaView = "today" | "week";

export interface AgendaWindow {
  view: AgendaView;
  timeZone: string;
  start: string;
  end: string;
  /** Clock date, or the day on screen in the day view. */
  dateLabel: string;
  /** The slice on screen, such as Sep 20 – Sep 26, 2026. */
  rangeLabel: string;
  /** Calendar day the board is anchored on, YYYY-MM-DD in the agenda timezone. */
  focusDate: string;
  /** Calendar day of `now`, YYYY-MM-DD in the agenda timezone. */
  todayDate: string;
  /** Whole days from today to focusDate. Negative is the past. */
  dayOffset: number;
  /** Today, Yesterday, Tomorrow, 2 days ago, In 3 days. */
  focusLabel: string;
}

export interface AgendaContextEvent {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  calendarTitle: string;
  sourceTitle: string;
}

export interface AgendaContextCalendar {
  title: string;
  sourceTitle: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const bag = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    weekday: String(bag.weekday ?? "").slice(0, 3).toLowerCase(),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const zoned = zonedParts(date, timeZone);
  const hourBag = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(hourBag.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(hourBag.find((part) => part.type === "minute")?.value ?? "0");
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, hour, minute);
  return asUtc - date.getTime();
}

function zonedDateTime(timeZone: string, year: number, month: number, day: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0));
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

function addDays(day: ZonedParts, days: number, timeZone: string): ZonedParts {
  const noon = new Date(zonedDateTime(timeZone, day.year, day.month, day.day).getTime() + 12 * 3_600_000);
  const shifted = new Date(noon.getTime() + days * 86_400_000);
  return zonedParts(shifted, timeZone);
}

function longDate(day: ZonedParts, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(zonedDateTime(timeZone, day.year, day.month, day.day));
}

function shortDate(day: ZonedParts, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(zonedDateTime(timeZone, day.year, day.month, day.day));
}

function isoDate(day: ZonedParts): string {
  const month = String(day.month).padStart(2, "0");
  const date = String(day.day).padStart(2, "0");
  return `${day.year}-${month}-${date}`;
}

function dayNumber(day: ZonedParts): number {
  return Math.round(Date.UTC(day.year, day.month - 1, day.day) / 86_400_000);
}

/** Label for a day relative to the clock's today. */
export function relativeDayLabel(offset: number): string {
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  if (offset === 1) return "Tomorrow";
  if (offset < 0) return `${-offset} days ago`;
  return `In ${offset} days`;
}

export function agendaWindow(view: AgendaView, now: Date, timeZone: string, focus?: Date): AgendaWindow {
  const today = zonedParts(now, timeZone);
  const focusDay = focus ? zonedParts(focus, timeZone) : today;
  const startDay =
    view === "week" ? addDays(focusDay, -(WEEKDAY_INDEX[focusDay.weekday] ?? 0), timeZone) : focusDay;
  const endDay = addDays(startDay, view === "week" ? 7 : 1, timeZone);
  const start = zonedDateTime(timeZone, startDay.year, startDay.month, startDay.day);
  const end = zonedDateTime(timeZone, endDay.year, endDay.month, endDay.day);
  const lastDay = addDays(endDay, -1, timeZone);
  const dayOffset = dayNumber(focusDay) - dayNumber(today);
  const rangeLabel =
    view === "week"
      ? `${shortDate(startDay, timeZone)} – ${shortDate(lastDay, timeZone)}, ${lastDay.year}`
      : longDate(focusDay, timeZone);
  return {
    view,
    timeZone,
    start: start.toISOString(),
    end: end.toISOString(),
    dateLabel: longDate(view === "week" ? today : focusDay, timeZone),
    rangeLabel,
    focusDate: isoDate(focusDay),
    todayDate: isoDate(today),
    dayOffset,
    focusLabel: relativeDayLabel(dayOffset),
  };
}

function formatEventWhen(event: AgendaContextEvent, timeZone: string): string {
  const start = new Date(event.start);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
  if (event.allDay) return `${day}, all day`;
  const clock = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  return `${day}, ${clock(event.start)}–${clock(event.end)}`;
}

const CLOCK_STOP = new Set([
  "how", "much", "longer", "long", "until", "till", "before", "left", "time", "have",
  "still", "does", "what", "when", "today", "this", "that", "work", "with", "from",
  "your", "about", "going", "gonna", "there", "here", "done", "finish", "leave",
  "they", "them", "into", "over", "after", "more", "than", "just", "like", "want",
  "know", "tell", "please", "could", "would", "should", "right", "currently",
]);

function namedWeekday(text: string): number | null {
  const match = text.toLowerCase().match(
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/,
  );
  if (!match?.[1]) return null;
  return WEEKDAY_INDEX[match[1].slice(0, 3)] ?? null;
}

function clockQuestionKind(text: string): "remaining" | "until" | null {
  const value = text.trim();
  if (!value) return null;
  if (/\bhow much longer\b/i.test(value) || /\bhow long left\b/i.test(value)) return "remaining";
  if (/\bhow much time\b/i.test(value) && /\b(left|until|till|before)\b/i.test(value)) {
    return /\b(until|till|before)\b/i.test(value) ? "until" : "remaining";
  }
  if (/\bhow long (until|till|before)\b/i.test(value)) return "until";
  if (/\b(when am i done|when do i (get off|finish|leave)|when does (this|that|it|work) end|am i still)\b/i.test(value)) {
    return "remaining";
  }
  return null;
}

function spanWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourLabel = hours === 1 ? "1 hour" : `${hours} hours`;
  const minuteLabel = rest === 1 ? "1 minute" : `${rest} minutes`;
  if (hours && rest) return `${hourLabel} and ${minuteLabel}`;
  if (hours) return hourLabel;
  if (rest) return minuteLabel;
  return "less than a minute";
}

function eventMatchesQuestion(event: AgendaContextEvent, text: string): boolean {
  const work = /\bwork\b/i.test(text);
  const calendar = `${event.calendarTitle} ${event.sourceTitle}`.toLowerCase();
  const title = event.title.toLowerCase();
  const words = text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  const named = words.filter((word) => !CLOCK_STOP.has(word));
  if (named.some((word) => title.includes(word))) return true;
  if (work) return calendar.includes("work") || title.includes("work");
  return named.length === 0;
}

export function looksLikeClockQuestion(text: string): boolean {
  return clockQuestionKind(text) != null;
}

/**
 * True when the user is asking what is on their calendar / agenda / day —
 * not a daily briefing, and not a rearrange or clock-remaining question.
 */
export function looksLikeAgendaQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  // Daily briefing owns "briefing" / "daily brief" / "rundown".
  if (/\bbrief(?:ing|ed|s)?\b/i.test(value)) return false;
  if (/\bdaily\s+brief\b/i.test(value)) return false;
  if (/\brundown\b/i.test(value)) return false;
  if (/\bwhat(?:'s|s| is)\s+on\s+my\s+plate\b/i.test(value)) return false;

  if (/\bwhat(?:'s|s| is)\s+on\s+(my\s+)?(calendar|schedule|agenda)\b/i.test(value)) return true;
  if (/\b(my|the|today'?s|tonight'?s|tomorrow'?s)\s+(agenda|schedule|calendar)\b/i.test(value)) {
    return true;
  }
  if (/\bwhat do i have\b/i.test(value)) return true;
  if (/\b(any|what)\s+meetings?\b/i.test(value)) return true;
  if (/\bam i\s+(free|busy)\b/i.test(value)) return true;
  if (
    /\b(what(?:'s|s| is)|how(?:'s|s| is))\b/i.test(value) &&
    /\b(my\s+)?(day|morning|afternoon|evening|week)\b/i.test(value) &&
    /\b(look|looking|shape|agenda|schedule|calendar|like)\b/i.test(value)
  ) {
    return true;
  }
  if (/\bwhat(?:'s|s| is)\s+(on\s+)?(for\s+)?(today|tonight|tomorrow)\b/i.test(value)) return true;
  return false;
}

/** Remaining time or time-until, from the clock and the events on that day. Null when this is not that kind of question. */
export function answerAgendaClock(input: {
  text: string;
  now: Date;
  timeZone: string;
  events: AgendaContextEvent[];
}): string | null {
  const kind = clockQuestionKind(input.text);
  if (!kind) return null;
  const today = zonedParts(input.now, input.timeZone);
  const weekday = namedWeekday(input.text);
  const timed = input.events.filter((event) => !event.allDay && eventMatchesQuestion(event, input.text));
  const dates = [...new Set(timed.map((event) => isoDate(zonedParts(new Date(event.start), input.timeZone))))];
  let day = isoDate(today);
  if (weekday != null) {
    const weekdayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][weekday];
    const matches = dates.filter((date) => {
      const [year, month, dateDay] = date.split("-").map(Number);
      return zonedParts(zonedDateTime(input.timeZone, year ?? 0, month ?? 1, dateDay ?? 1), input.timeZone).weekday
        === weekdayName;
    });
    const todayIso = isoDate(today);
    const distance = (iso: string) => {
      const [year, month, dateDay] = iso.split("-").map(Number);
      const [todayYear, todayMonth, todayDay] = todayIso.split("-").map(Number);
      return Math.abs(
        Date.UTC(year ?? 0, (month ?? 1) - 1, dateDay ?? 1)
          - Date.UTC(todayYear ?? 0, (todayMonth ?? 1) - 1, todayDay ?? 1),
      );
    };
    day = matches.sort((a, b) => distance(a) - distance(b))[0] ?? day;
  }
  const onDay = timed
    .filter((event) => isoDate(zonedParts(new Date(event.start), input.timeZone)) === day)
    .sort((a, b) => a.start.localeCompare(b.start));
  const nowMs = input.now.getTime();
  const active = onDay.filter((event) => Date.parse(event.start) <= nowMs && nowMs < Date.parse(event.end));
  const current = active.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  const subject = /\bwork\b/i.test(input.text) && !onDay.some((event) => event.title.toLowerCase().includes("work"))
    ? "work"
    : current?.title;
  if (current) {
    const until = clockLabel(new Date(current.end), input.timeZone);
    const name = subject === "work" ? `at work, in ${current.title},` : `in ${current.title}`;
    return `You have ${spanWords(Date.parse(current.end) - nowMs)} left ${name} until ${until}.`;
  }
  const upcoming = onDay.find((event) => Date.parse(event.start) > nowMs);
  if (upcoming) {
    const at = clockLabel(new Date(upcoming.start), input.timeZone);
    return `${upcoming.title} starts at ${at}, in ${spanWords(Date.parse(upcoming.start) - nowMs)}.`;
  }
  const finished = [...onDay].reverse().find((event) => Date.parse(event.end) <= nowMs);
  if (finished) {
    return `${finished.title} ended at ${clockLabel(new Date(finished.end), input.timeZone)}.`;
  }
  if (kind) return "Nothing on the calendar matches that.";
  return null;
}

function clockLabel(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
}

/** Prompt context for a calendar / agenda turn (Agenda screen or Talk). */
export function describeAgendaView(input: {
  view: AgendaView;
  timeZone: string;
  rangeLabel: string;
  focusLabel?: string;
  /** Wall clock for this turn. The agenda screen shows the same time. */
  now?: Date;
  unified: boolean;
  calendars: AgendaContextCalendar[];
  events: AgendaContextEvent[];
}): string {
  const calendarLine = input.calendars.length
    ? input.calendars.map((calendar) => `${calendar.title} (${calendar.sourceTitle})`).join("; ")
    : "none. Every calendar is still No Access.";
  const nowMs = input.now?.getTime();
  const eventLines = input.events.slice(0, 40).map((event) => {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    const active = nowMs != null && !event.allDay && start <= nowMs && nowMs < end;
    const progress = active ? ` — in progress, ${spanWords(end - nowMs)} left` : "";
    return `- ${formatEventWhen(event, input.timeZone)} — ${event.title} (${event.calendarTitle}, ${event.sourceTitle})${progress}`;
  });
  const viewName = input.view === "week" ? "Week" : (input.focusLabel ?? "Today");
  const clock = input.now ? `The clock reads ${clockLabel(input.now, input.timeZone)}.` : "";
  return [
    "The user is asking about their calendar / agenda. Answer from the events below — speak a short rundown when they ask what is on today or their schedule. Do not invent events. Do not play the daily briefing unless they asked for a briefing.",
    [ `View: ${viewName}. ${input.rangeLabel}. Timezone: ${input.timeZone}.`, clock ]
      .filter(Boolean)
      .join(" "),
    input.unified
      ? "Layout: one unified calendar. Colors distinguish the calendars."
      : "Layout: one pane per calendar.",
    `Calendars: ${calendarLine}.`,
    "Events in this view:",
    eventLines.length ? eventLines.join("\n") : "None.",
    `Today is ${longDate(zonedParts(input.now ?? new Date(), input.timeZone), input.timeZone)}. A question about now, today, or how much longer uses that date and the clock, not another day that is also in this view.`,
    `Use this view when answering. The clock above is the current time; use it for the time of day and for how long until an event. Do not say the clock is unavailable.${
      input.view === "today" ? " When they do not name a day, they mean today." : ""
    } Change calendars only through delegate_task with category calendar. Put the user's own wording in taskDescription, including a clock time such as 8:00-8:45 AM and the calendar name. If they answer a question about the time or the calendar, call delegate_task again with that answer and the original request.`,
  ].join("\n");
}
