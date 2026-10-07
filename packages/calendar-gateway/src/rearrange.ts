import type { CalendarGateway } from "./helper.js";

/** One event the schedule model is allowed to see. */
export interface ScheduleEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarId: string;
  calendarTitle: string;
  writable: boolean;
}

export interface ScheduleCalendar {
  id: string;
  title: string;
  sourceTitle: string;
  writable: boolean;
}

export interface RearrangeChange {
  op: "move" | "create";
  id?: string;
  calendarId?: string;
  title?: string;
  start: string;
  end: string;
  /** True when this move may change the event's length. */
  flex?: boolean;
}

export interface PreparedChange {
  op: "move" | "create";
  id?: string;
  calendarId?: string;
  title?: string;
  start: string;
  end: string;
}

/** Fitting, squeezing, or sliding the day without a finished clock time. */
export function looksLikeScheduleChange(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/\b(squeeze|make room|free up|reschedule|rearrange|bump)\b/i.test(value)) return true;
  if (/\broom for\b/i.test(value)) return true;
  if (/\bfit\b/i.test(value)) return true;
  if (/\b(push|shift)\b/i.test(value) && /\b(later|earlier|back|after|minute|minutes|hour|hours)\b/i.test(value)) {
    return true;
  }
  if (/\bmove\b/i.test(value) && /\b(later|earlier|things|stuff|around|schedule)\b/i.test(value)) return true;
  if (/\b(adjust|rework)\b/i.test(value) && /\b(day|schedule|calendar|things|it|them|around)\b/i.test(value)) return true;
  if (/\b(can|could) i\b/i.test(value) && /\b(fit|squeeze|add|put|schedule)\b/i.test(value)) return true;
  return false;
}

const AFFIRM = /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|approve|sounds good|that works|yes please|please)\b/i;

/** A yes or no. A leading yes still counts when the sentence keeps going. */
export function scheduleReplyStance(text: string): "yes" | "no" | "other" {
  const value = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!value) return "other";
  if (/^(no|nope|nah|don't|do not|cancel|never mind|nevermind|leave it|stop)\b/.test(value)) return "no";
  if (AFFIRM.test(value)) {
    if (/\b(but|except|instead|actually|don't|do not|never)\b/i.test(value)) return "other";
    return "yes";
  }
  if (value.length > 48) return "other";
  if (/\b(but|except|only|instead|actually)\b/i.test(value)) return "other";
  return "other";
}

/** True when a yes also adds a fact the plan may not have, such as a duration. */
export function approvalAddsDetail(text: string): boolean {
  const match = text.trim().match(new RegExp(AFFIRM.source + String.raw`[\s,.:!-]*(.*)`, "i"));
  if (!match) return false;
  const rest = (match[1] ?? "").replace(
    /\b(i did|i do|i already did|i told you(?: all that| that| everything)?|all that information|you already know|please|go ahead|do it|that(?:'s| is) right|yes|yeah)\b/gi,
    " ",
  );
  if (/\d/.test(rest)) return true;
  if (/\b(minute|minutes|hour|hours|make it|change it|longer|shorter|earlier|later|instead)\b/i.test(rest)) return true;
  return rest.replace(/[^\w]+/g, "").length > 24;
}

/** Speech that must not be spoken as if the calendar already changed. */
export function uncommittedPlanSpeech(speech: string): string {
  const text = speech.trim();
  if (!text) return "I haven't changed the calendar. I need a concrete plan before I move anything.";
  if (/\b(done|updated|moved|added|adjusted|i'll|i will|going to)\b/i.test(text)) {
    return text.includes("?")
      ? `I haven't changed the calendar yet. ${text}`
      : "I haven't changed the calendar yet. Want me to make that change?";
  }
  if (text.includes("?")) return text;
  return `${text} I haven't changed the calendar yet. Should I?`;
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The day's blocks, with ids, so a model can name the events it wants to move. */
export function formatScheduleForModel(input: {
  timeZone: string;
  rangeLabel: string;
  now?: Date;
  calendars: ScheduleCalendar[];
  events: ScheduleEvent[];
}): string {
  const now = input.now
    ? `Clock: ${clock(input.now.toISOString(), input.timeZone)}.`
    : "";
  const writable = input.calendars.filter((calendar) => calendar.writable);
  const locked = input.calendars.filter((calendar) => !calendar.writable);
  const calendarLines = (rows: ScheduleCalendar[]) =>
    rows.length
      ? rows.map((calendar) => `- id=${calendar.id} ${calendar.title} (${calendar.sourceTitle})`).join("\n")
      : "None.";
  const events = [...input.events].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 60);
  const eventLines = events.length
    ? events
        .map((event) => {
          const when = event.allDay
            ? "all day"
            : `${clock(event.start, input.timeZone)}–${clock(event.end, input.timeZone)}`;
          return `- id=${event.id} writable=${event.writable ? "yes" : "no"} calendarId=${event.calendarId} ${when} ${event.title}`;
        })
        .join("\n")
    : "None.";
  return [
    `Timezone: ${input.timeZone}.`,
    now,
    `View: ${input.rangeLabel}.`,
    "Writable calendars:",
    calendarLines(writable),
    "Read-only calendars:",
    calendarLines(locked),
    "Events:",
    eventLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return null;
  const time = Date.parse(text);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

/** Pull a proposal out of the model reply. Null when the text is not JSON. */
export function parseRearrangeReply(raw: string): { speech: string; changes: RearrangeChange[] | null } | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { speech?: unknown; proposal?: unknown; changes?: unknown };
  const speech = typeof record.speech === "string" ? record.speech.trim() : "";
  const proposal = record.proposal;
  if (proposal == null) return { speech, changes: null };
  const changes = Array.isArray(proposal)
    ? proposal
    : proposal && typeof proposal === "object" && Array.isArray((proposal as { changes?: unknown }).changes)
      ? (proposal as { changes: unknown[] }).changes
      : record.changes;
  if (!Array.isArray(changes)) return { speech, changes: null };
  const normalized: RearrangeChange[] = [];
  for (const item of changes) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      op?: unknown;
      id?: unknown;
      calendarId?: unknown;
      title?: unknown;
      start?: unknown;
      end?: unknown;
      flex?: unknown;
    };
    const op = row.op === "create" ? "create" : row.op === "move" ? "move" : null;
    const start = asIso(row.start);
    const end = asIso(row.end);
    if (!op || !start || !end) continue;
    normalized.push({
      op,
      id: typeof row.id === "string" ? row.id.trim() : undefined,
      calendarId: typeof row.calendarId === "string" ? row.calendarId.trim() : undefined,
      title: typeof row.title === "string" ? row.title.trim() : undefined,
      start,
      end,
      flex: row.flex === true,
    });
  }
  return { speech, changes: normalized.length ? normalized : null };
}

const MIN_FLEX_MS = 15 * 60_000;
const MAX_SPAN_MS = 12 * 60 * 60_000;

/**
 * Check a proposal against the day on screen.
 * A move keeps its length unless the model marked it flexible.
 * Creates need a writable calendar.
 */
export function prepareRearrange(
  changes: RearrangeChange[],
  events: ScheduleEvent[],
  calendars: ScheduleCalendar[],
): { ok: true; changes: PreparedChange[] } | { ok: false; speech: string } {
  if (changes.length === 0) return { ok: false, speech: "I don't have a change to make." };
  if (changes.length > 12) return { ok: false, speech: "That's too many changes at once. Ask for a smaller shift." };
  const byId = new Map(events.map((event) => [event.id, event]));
  const writable = calendars.filter((calendar) => calendar.writable);
  const prepared: PreparedChange[] = [];
  for (const change of changes) {
    if (change.op === "move") {
      const event = change.id ? byId.get(change.id) : undefined;
      if (!event) return { ok: false, speech: "One of those events is no longer on the day. Ask me again." };
      if (event.allDay) return { ok: false, speech: `${event.title} lasts all day, so I can't slide it.` };
      if (!event.writable) {
        return { ok: false, speech: `${event.title} is on ${event.calendarTitle}, which is not open for writes.` };
      }
      const duration = new Date(event.end).getTime() - new Date(event.start).getTime();
      if (duration <= 0) return { ok: false, speech: `${event.title} has no length to move.` };
      const start = new Date(change.start);
      let end = new Date(start.getTime() + duration);
      if (change.flex) {
        const proposed = Date.parse(change.end) - start.getTime();
        if (proposed < MIN_FLEX_MS || proposed > MAX_SPAN_MS) {
          return { ok: false, speech: `${event.title} can shrink or grow, but it still needs a real span on that day.` };
        }
        end = new Date(change.end);
      }
      prepared.push({
        op: "move",
        id: event.id,
        title: event.title,
        start: start.toISOString(),
        end: end.toISOString(),
      });
      continue;
    }
    const title = change.title?.trim() ?? "";
    if (!title) return { ok: false, speech: "The new event needs a name." };
    const startMs = Date.parse(change.start);
    const endMs = Date.parse(change.end);
    if (endMs - startMs < 5 * 60_000 || endMs - startMs > MAX_SPAN_MS) {
      return { ok: false, speech: `${title} needs a start and an end on that day.` };
    }
    let calendarId = change.calendarId;
    if (!calendarId && writable.length === 1) calendarId = writable[0]?.id;
    const calendar = writable.find((item) => item.id === calendarId);
    if (!calendar) return { ok: false, speech: "Tell me which writable calendar should get the new event." };
    prepared.push({
      op: "create",
      calendarId: calendar.id,
      title,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    });
  }
  return { ok: true, changes: prepared };
}

/** Write an already checked proposal. Moves happen before new events. */
export async function applyPreparedRearrange(input: {
  changes: PreparedChange[];
  gateway: CalendarGateway;
  timeZone: string;
}): Promise<string> {
  const moves = input.changes.filter((change) => change.op === "move");
  const creates = input.changes.filter((change) => change.op === "create");
  const done: string[] = [];
  for (const change of moves) {
    const updated = await input.gateway.update({
      eventId: change.id!,
      start: change.start,
      end: change.end,
    });
    done.push(`Moved ${updated.title} to ${clock(updated.start, input.timeZone)}–${clock(updated.end, input.timeZone)}`);
  }
  for (const change of creates) {
    const created = await input.gateway.create({
      calendarId: change.calendarId!,
      title: change.title!,
      start: change.start,
      end: change.end,
    });
    done.push(`Added ${created.title} at ${clock(created.start, input.timeZone)}–${clock(created.end, input.timeZone)}`);
  }
  return done.length ? `Done. ${done.join(". ")}.` : "I didn't change the calendar.";
}

export function spokenProposal(speech: string): string {
  const text = speech.trim();
  const ask = "Want me to make that change?";
  if (!text) return ask;
  if (text.includes("?")) return text;
  return `${text} ${ask}`;
}
