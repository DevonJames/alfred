import { detectBriefingIntent } from "@alfred/briefing";
import {
  agendaDateHeading,
  agendaNeedsRewrite,
  agendaRewrite,
  agendaWindow,
  answerAgendaClock,
  answerNextAgendaItem,
  hoursPeriod,
  hoursWeekShift,
  calendarPolicyPath,
  createEventKitGateway,
  describeAgendaView,
  applyPreparedRearrange,
  approvalAddsDetail,
  formatScheduleForModel,
  interpretCalendarTask,
  loadCalendarPolicy,
  looksLikeAgendaQuestion,
  looksLikeClockQuestion,
  looksLikeHoursQuestion,
  looksLikeNextAgendaQuestion,
  looksLikeScheduleChange,
  mergeCalendarAccess,
  parseRearrangeReply,
  sumMatchedHours,
  prepareRearrange,
  readableCalendars,
  runCalendarTask,
  scheduleReplyStance,
  spokenProposal,
  uncommittedPlanSpeech,
  zonedDateTime,
  type PreparedChange,
  type ScheduleCalendar,
  type ScheduleEvent,
  type AgendaView,
  type CalendarEvent,
  type CalendarRow,
} from "@alfred/calendar-gateway";
import { draftScheduleChange, selectMatchingHours, splitAgendaNote } from "./agenda-llm.js";
import { conversationForSchedule, noteConversationTurn } from "./conversation-thread.js";
import { getTextSession } from "./text-session.js";

/** While Agenda is on screen, Speech Engine turns use this view instead of the Talk brain. */
export interface AgendaEar {
  view: AgendaView;
  unified: boolean;
  date?: string;
}

let ear: AgendaEar | null = null;

const PROPOSAL_MS = 10 * 60_000;

interface PendingProposal {
  until: number;
  changes: PreparedChange[] | null;
  timeZone: string;
  question: string;
}

let pendingProposal: PendingProposal | null = null;

function currentProposal(): PendingProposal | null {
  if (!pendingProposal || Date.now() > pendingProposal.until) {
    pendingProposal = null;
    return null;
  }
  return pendingProposal;
}

export function setAgendaEar(next: AgendaEar | null): void {
  ear = next;
}

export function currentAgendaEar(): AgendaEar | null {
  return ear;
}

/** Agenda / schedule asks from Talk — no Agenda screen required. */
export async function answerLooseScheduleTurn(text: string): Promise<string | null> {
  // Never steal the daily briefing for the calendar brain.
  if (detectBriefingIntent(text, false) === "explicitAsk") return null;
  const stance = scheduleReplyStance(text);
  const pending = currentProposal();
  const relevant =
    looksLikeScheduleChange(text)
    || looksLikeClockQuestion(text)
    || looksLikeAgendaQuestion(text)
    || (!!pending && (stance === "yes" || stance === "no"));
  if (!relevant) {
    if (pending) pendingProposal = null;
    return null;
  }
  const view = /\b(this\s+week|week\s+ahead|whole\s+week)\b/i.test(text) ? "week" : "today";
  return answerAgendaTurn({ text, view, unified: true });
}

async function commitRearrange(changes: PreparedChange[], timeZone: string): Promise<string> {
  try {
    const speech = await applyPreparedRearrange({
      changes,
      gateway: createEventKitGateway(calendarPolicyPath(profileId())),
      timeZone,
    });
    console.log(`[agenda] applied ${changes.length} change(s)`);
    return speech;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[agenda] apply failed: ${message}`);
    return `I couldn't make that change. ${message}`;
  }
}

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

export function agendaTimeZone(): string {
  return process.env.BRIEFING_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function agendaViewFrom(value: unknown): AgendaView {
  return value === "week" ? "week" : "today";
}

async function openCalendars(): Promise<CalendarRow[]> {
  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  return readableCalendars(mergeCalendarAccess(discovered, policy).sources);
}

function palette(index: number): string {
  const colors = ["#7ee0c3", "#ffb347", "#7eb6ff", "#e07ecf", "#e08a7e", "#c7e07e"];
  return colors[index % colors.length] ?? "#7ee0c3";
}

export function agendaFocusInstant(value: unknown, zone: string): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day || month > 12 || day > 31) return undefined;
  return zonedDateTime(zone, year, month, day, 12, 0);
}

export async function agendaBoard(view: AgendaView, focus?: Date) {
  const zone = agendaTimeZone();
  const window = agendaWindow(view, new Date(), zone, focus);
  const calendars = await openCalendars();
  const gateway = createEventKitGateway(calendarPolicyPath(profileId()));
  const events = calendars.length
    ? await gateway.events({ start: window.start, end: window.end })
    : [];
  const byCalendar = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = byCalendar.get(event.calendarId) ?? [];
    list.push(event);
    byCalendar.set(event.calendarId, list);
  }
  return {
    ...window,
    calendars: calendars.map((calendar, index) => ({
      id: calendar.id,
      title: calendar.title,
      sourceTitle: calendar.sourceTitle,
      sourceType: calendar.sourceType,
      color: calendar.color ?? palette(index),
      access: calendar.access,
      ignoreOverlaps: calendar.ignoreOverlaps === true,
      events: byCalendar.get(calendar.id) ?? [],
    })),
  };
}

/** Answer one agenda question or calendar command for the view on screen. */
export async function answerAgendaTurn(input: {
  text: string;
  view: AgendaView;
  unified: boolean;
  date?: string;
}): Promise<string> {
  if (input.text.trim()) noteConversationTurn("user", input.text);
  const reply = await produceAgendaReply(input);
  if (reply.trim()) noteConversationTurn("assistant", reply);
  return reply;
}

async function produceAgendaReply(input: {
  text: string;
  view: AgendaView;
  unified: boolean;
  date?: string;
}): Promise<string> {
  const text = input.text.trim();
  if (!text) return "";
  const zone = agendaTimeZone();
  const focus = agendaFocusInstant(input.date, zone);
  const board = await agendaBoard(input.view, focus);
  const plannerNow =
    board.dayOffset === 0
      ? new Date()
      : zonedDateTime(
          board.timeZone,
          Number(board.focusDate.slice(0, 4)),
          Number(board.focusDate.slice(5, 7)),
          Number(board.focusDate.slice(8, 10)),
          12,
          0,
        );
  const viewContext = describeAgendaView({
    view: input.view,
    timeZone: board.timeZone,
    rangeLabel: board.rangeLabel,
    focusLabel: input.view === "today" ? board.focusLabel : undefined,
    now: new Date(),
    unified: input.unified,
    calendars: board.calendars.map((calendar) => ({
      title: calendar.title,
      sourceTitle: calendar.sourceTitle,
    })),
    events: board.calendars.flatMap((calendar) =>
      calendar.events.map((event) => ({
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        calendarTitle: calendar.title,
        sourceTitle: calendar.sourceTitle,
      })),
    ),
  });

  const scheduleCalendars: ScheduleCalendar[] = board.calendars.map((calendar) => ({
    id: calendar.id,
    title: calendar.title,
    sourceTitle: calendar.sourceTitle,
    writable: calendar.access === "write",
  }));
  const scheduleEvents: ScheduleEvent[] = board.calendars.flatMap((calendar) =>
    calendar.events.map((event) => ({
      id: event.id,
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      calendarId: calendar.id,
      calendarTitle: calendar.title,
      writable: calendar.access === "write",
    })),
  );
  const contextEvents = scheduleEvents.map((event) => ({
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    calendarTitle: event.calendarTitle,
    sourceTitle: scheduleCalendars.find((calendar) => calendar.id === event.calendarId)?.sourceTitle ?? "",
  }));
  const wallNow = new Date();
  const clockAnswer = answerAgendaClock({
    text,
    now: wallNow,
    timeZone: board.timeZone,
    events: contextEvents,
  });
  if (clockAnswer) return clockAnswer;

  if (looksLikeNextAgendaQuestion(text)) {
    let nextEvents = contextEvents;
    // Day view at night only has today's items; look ahead a week so "next" can land tomorrow.
    if (input.view === "today" || board.dayOffset !== 0) {
      const week = await agendaBoard("week", wallNow);
      nextEvents = week.calendars.flatMap((calendar) =>
        calendar.events.map((event) => ({
          title: event.title,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          calendarTitle: calendar.title,
          sourceTitle: calendar.sourceTitle,
        })),
      );
    }
    const nextAnswer = answerNextAgendaItem({
      text,
      now: wallNow,
      timeZone: board.timeZone,
      events: nextEvents,
    });
    if (nextAnswer) return nextAnswer;
  }

  if (looksLikeHoursQuestion(text)) {
    const thread = conversationForSchedule();
    const shift = hoursWeekShift(text, thread);
    let source = board;
    if (shift !== null && !(shift === 0 && input.view === "week" && !/\b(next|last) week\b/i.test(text))) {
      const weekFocus = shift === 0 ? new Date() : new Date(Date.now() + shift * 86_400_000);
      source = await agendaBoard("week", weekFocus);
    }
    const events = source.calendars.flatMap((calendar) =>
      calendar.events.map((event) => ({
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        calendarTitle: calendar.title,
        sourceTitle: calendar.sourceTitle,
      })),
    );
    const fromAsk = hoursPeriod(text);
    const period = fromAsk === "then" ? hoursPeriod(thread) : fromAsk;
    const picked = await selectMatchingHours({
      question: thread || text,
      timeZone: source.timeZone,
      rangeLabel: source.rangeLabel,
      todayLabel: new Intl.DateTimeFormat("en-US", {
        timeZone: source.timeZone,
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date()),
      events,
    });
    if (picked) {
      return sumMatchedHours({
        timeZone: source.timeZone,
        label: picked.label,
        period: period === "then" ? "this week" : period,
        events,
        ids: picked.ids,
      });
    }
  }

  const stance = scheduleReplyStance(text);
  const pending = currentProposal();
  const revising = stance === "yes" && approvalAddsDetail(text);
  if (pending?.changes?.length && stance === "yes" && !revising) {
    pendingProposal = null;
    return commitRearrange(pending.changes, pending.timeZone);
  }
  if (pending?.changes?.length && stance === "no") {
    pendingProposal = null;
    return "Okay. I'll leave the day as it is.";
  }
  const asking = looksLikeScheduleChange(text) || revising || (stance === "yes" && !!pending);
  if (asking) {
    const schedule = formatScheduleForModel({
      timeZone: board.timeZone,
      rangeLabel: board.rangeLabel,
      now: new Date(),
      calendars: scheduleCalendars,
      events: scheduleEvents,
    });
    const question = conversationForSchedule() || text;
    let raw = await draftScheduleChange(schedule, question);
    let parsed = raw ? parseRearrangeReply(raw) : null;
    if (!parsed?.changes?.length) {
      const repair = await draftScheduleChange(schedule, question, raw);
      if (repair) {
        raw = repair;
        parsed = parseRearrangeReply(repair);
      }
    }
    console.log(`[agenda] draft ${parsed?.changes?.length ?? 0} change(s) stance=${stance} lines=${question.split("\n").length}`);
    if (parsed?.changes?.length) {
      const ready = prepareRearrange(parsed.changes, scheduleEvents, scheduleCalendars);
      if (ready.ok) {
        if (stance === "yes") {
          pendingProposal = null;
          return commitRearrange(ready.changes, board.timeZone);
        }
        pendingProposal = {
          until: Date.now() + PROPOSAL_MS,
          changes: ready.changes,
          timeZone: board.timeZone,
          question,
        };
        return spokenProposal(parsed.speech);
      }
      if (!(pending?.changes?.length && revising)) {
        pendingProposal = {
          until: Date.now() + PROPOSAL_MS,
          changes: null,
          timeZone: board.timeZone,
          question,
        };
      }
      return ready.speech;
    }
    if (!(pending?.changes?.length && revising)) {
      pendingProposal = {
        until: Date.now() + PROPOSAL_MS,
        changes: null,
        timeZone: board.timeZone,
        question,
      };
    }
    return uncommittedPlanSpeech(parsed?.speech ?? "");
  }
  if (stance === "other") pendingProposal = null;

  const calendars = await openCalendars();
  let task = text;
  if (agendaNeedsRewrite(text, calendars)) {
    const draft = await splitAgendaNote(text);
    const lines = draft ? agendaRewrite(draft) : null;
    if (lines) {
      const head = agendaDateHeading(text);
      task = head && !agendaDateHeading(lines) ? `${head}\n${lines}` : lines;
    }
  }
  const preview = interpretCalendarTask({
    task,
    now: plannerNow,
    timeZone: board.timeZone,
    calendars,
  });
  const creates = preview.commands.filter((command) => command.op === "create");
  if (creates.length >= 2) {
    const gateway = createEventKitGateway(calendarPolicyPath(profileId()));
    return runCalendarTask({
      task,
      now: plannerNow,
      timeZone: board.timeZone,
      calendars,
      gateway,
    });
  }
  if (preview.clarify && (task !== text || text.split(/\n/).filter((line) => /\d{1,2}:\d{2}/.test(line)).length >= 2)) {
    return preview.clarify;
  }

  const session = await getTextSession({ sessionKey: "agenda" });
  const thread = conversationForSchedule();
  const extraSystem = thread
    ? `${viewContext}\n\nConversation so far:\n${thread}\nA name, duration, or time in an earlier User line is already known.`
    : viewContext;
  await session.handleUserUtterance({ text, extraSystem });
  const snap = session.snapshot();
  const assistantTurn = [...snap.recentTurns].reverse().find((turn) => turn.role === "assistant");
  let assistantText = assistantTurn?.text ?? "";
  if (snap.currentResponseId) {
    const ledger = session.getResponseLedger().snapshot(snap.currentResponseId);
    if (ledger?.deliveredText) assistantText = ledger.deliveredText;
    else if (ledger?.committedText) assistantText = ledger.committedText;
  }
  return assistantText;
}
