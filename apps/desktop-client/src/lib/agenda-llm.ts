import { parseHoursPick } from "@alfred/calendar-gateway";
import type { LLMProvider } from "@alfred/contracts";
import { OpenAiResponsesLLMProvider } from "@alfred/provider-openai";
import { resolveGrokApiKey, XaiGrokLLMProvider } from "@alfred/provider-xai";

const SPLIT_INSTRUCTIONS = [
  "Split this calendar note into separate events.",
  "Line breaks may be missing, so several events can sit in one paragraph.",
  "Return one event per line and nothing else.",
  "Each line must look like: 8:00–8:45 AM — Title",
  "Keep each title as written. Do not merge events. Do not invent events. Do not add dates.",
  "If the note names a calendar or a day, put that sentence alone on the first line.",
].join(" ");

function provider(): LLMProvider | null {
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) return new OpenAiResponsesLLMProvider({ apiKey: openai });
  const grok = resolveGrokApiKey();
  if (grok) return new XaiGrokLLMProvider({ apiKey: grok });
  return null;
}

const REARRANGE_INSTRUCTIONS = [
  "You are arranging the calendar day the user is looking at.",
  "The schedule below is the source of truth. Each event line has an id, a clock span, and whether it can be moved.",
  "The user wants to know if something can fit, or wants part of the day moved.",
  "The conversation may span several messages. A name, a duration, or when something should happen is often in an earlier user line. Use the whole conversation. Do not ask again for a detail the user already gave. The last user line is what they want now.",
  "Decide from the spans. A gap is free time between the end of one event and the start of the next.",
  "Before moving anything, decide from each title whether its length is the activity itself or whether the block is there to fill open time.",
  "When the length is the activity, you may slide it and you must keep that length. Leave flex off.",
  "When the block exists to occupy whatever time is free, you may shorten or lengthen it so something else fits or so it fills the gap that remains. Mark that move with flex true. Do not shrink it below 15 minutes and do not delete it.",
  "Name in speech any block whose length you are changing, and say the new span. If it fits only by sliding later events, say which clock time you push from and by how many minutes.",
  "Reply with JSON only, no markdown.",
  '{"speech":"what Alfred says","proposal":null}',
  "or",
  '{"speech":"the plan, ending with a yes/no question","proposal":{"changes":[{"op":"move","id":"event id","flex":false,"start":"ISO-8601 with Z","end":"ISO-8601 with Z"},{"op":"create","calendarId":"writable calendar id","title":"name","start":"ISO-8601 with Z","end":"ISO-8601 with Z"}]}}',
  "Do not move an event whose writable flag is no.",
  "Do not invent events the user did not ask to add.",
  "Speech alone changes nothing. The calendar is written only from proposal.changes. Do not say you will adjust the day, and do not say it was already adjusted, unless those changes are in the JSON.",
  "If it cannot fit, proposal is null and speech says why.",
  "Whenever proposal is present, speech must ask whether to make the change.",
].join(" ");

/** Ask the model for a spoken plan. Returns the raw JSON text, or null when no model is available. */
export async function draftScheduleChange(schedule: string, question: string, failedReply?: string | null): Promise<string | null> {
  const llm = provider();
  if (!llm) return null;
  let out = "";
  try {
    for await (const chunk of llm.generateStream({
      messages: [
        { role: "system", content: REARRANGE_INSTRUCTIONS },
        {
          role: "user",
          content: failedReply
            ? `${schedule}\n\nConversation:\n${question}\n\nThat reply could not be written:\n${failedReply.slice(0, 1500)}\nReply again with JSON only. Put every move and create in proposal.changes. Use details from earlier user lines. If you cannot, set proposal to null and ask only for what is still missing.`
            : `${schedule}\n\nConversation:\n${question}\n\nUse every user line above. The last user line is the current request.`,
        },
      ],
      modelPreset: "instant",
      correlationId: "agenda-rearrange",
    })) {
      if (chunk.type === "error") return null;
      if (chunk.type === "token" && chunk.text) out += chunk.text;
    }
  } catch {
    return null;
  }
  return out.trim() || null;
}

/** Ask the model to put one event on each line. Returns null when no model is configured or the call fails. */
export async function splitAgendaNote(text: string): Promise<string | null> {
  const llm = provider();
  if (!llm) return null;
  let out = "";
  try {
    for await (const chunk of llm.generateStream({
      messages: [
        { role: "system", content: SPLIT_INSTRUCTIONS },
        { role: "user", content: text },
      ],
      modelPreset: "instant",
      correlationId: "agenda-split",
    })) {
      if (chunk.type === "error") return null;
      if (chunk.type === "token" && chunk.text) out += chunk.text;
    }
  } catch {
    return null;
  }
  return out.trim() || null;
}

const PLAN_INSTRUCTIONS = [
  "You are filling a planning list for one day, one weekend, or one week.",
  "The user describes what they want to get done, or how to change items already in the list.",
  "Reply with JSON only, no markdown:",
  '{"reply":"one short sentence","items":[{"key":"","eventId":"","date":"YYYY-MM-DD","start":"HH:mm","end":"HH:mm","title":"","calendarId":""}]}',
  "Each activity is its own item. Never put several activities into one title.",
  "Times are 24-hour HH:mm. A start with no length lasts 60 minutes. 'at 1' means 13:00 unless they said morning.",
  "Dates must be one of the period dates. Put date, start, and end on every item.",
  "When a default date is given, every new item goes on that date unless the user named a different day.",
  "When the clock is included, a new item on today starts at the top of the next open hour. Do not start it before that hour unless the user named that time.",
  "You may move an existing item earlier than the clock when the user asks.",
  "Use the time blocks when an item belongs in one. Otherwise place it in an open gap on the default date.",
  "Open time already ignores calendars that skip overlaps. If Open lists a window long enough, return the new item inside it.",
  "Items listed as visible only do not occupy time. Put a new item on top of them. Never refuse because of them, and do not move them to make room.",
  "When they ask to change an item already in the list, return that item with its eventId or key and the new times or title.",
  "Leave eventId empty for a new item. Omit items you are not adding or changing. To drop a draft, return it with remove true and its key.",
  "calendarId must be one of the writable calendar ids. If they name a calendar, use that id. If the item sits in a block that has a calendar, use that calendar unless they named another.",
].join(" ");

/** Ask the model to turn a planning note into separate dated items. */
export async function draftPlan(input: {
  message: string;
  periodLabel: string;
  dates: string[];
  blocks: string;
  calendars: string;
  items: string;
  history: string;
  defaultDate?: string;
  open?: string;
  clock?: string;
}): Promise<string | null> {
  const llm = provider();
  if (!llm) return null;
  const content = [
    `Period: ${input.periodLabel}`,
    `Dates: ${input.dates.join(", ")}`,
    input.clock ? `Clock: ${input.clock}` : "",
    input.defaultDate ? `Default date: ${input.defaultDate}` : "",
    input.open
      ? `Open on ${input.defaultDate || "the default date"}, from the clock forward. This already ignores calendars that skip overlaps:\n${input.open}${input.open === "none" ? "" : "\nAn earlier reply that said there was no gap is outdated. Place the new item in this open time."}`
      : "",
    `Time blocks:\n${input.blocks || "none"}`,
    `Writable calendars:\n${input.calendars}`,
    `Current items:\n${input.items || "none"}`,
    input.history ? `Conversation:\n${input.history}` : "",
    `User: ${input.message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  let out = "";
  try {
    for await (const chunk of llm.generateStream({
      messages: [
        { role: "system", content: PLAN_INSTRUCTIONS },
        { role: "user", content },
      ],
      modelPreset: "instant",
      correlationId: "agenda-plan",
    })) {
      if (chunk.type === "error") return null;
      if (chunk.type === "token" && chunk.text) out += chunk.text;
    }
  } catch {
    return null;
  }
  return out.trim() || null;
}

const HOURS_PICK_INSTRUCTIONS = [
  "The user is asking how much time is on their calendar.",
  "The event list was just read from the calendar and is already limited to the week they asked about.",
  "Choose every event that matches what they want counted. Do not skip an event because the question says next week or last week.",
  "Timed events are the blocks of time. Include each timed event that is part of the request.",
  "An all-day line is a note. Include it only when that note is the work time and that day has no timed event for the same work.",
  "Words in parentheses are an instruction about how to look, not part of what to count.",
  "Do not add the hours. Do not estimate a total.",
  "Reply with JSON only, no markdown:",
  '{"label":"short name of what they asked to count","ids":["1","2"]}',
  "label is a few words, such as work. ids are the numbers at the start of the matching lines. Use an empty ids array only when none of the events match.",
].join(" ");

/** Ask the model which live events match the request. The caller adds them up. */
export async function selectMatchingHours(input: {
  question: string;
  timeZone: string;
  rangeLabel: string;
  todayLabel: string;
  events: { id: string; title: string; start: string; end: string; allDay?: boolean; calendarTitle: string; sourceTitle: string }[];
}): Promise<{ label: string; ids: string[] } | null> {
  const llm = provider();
  if (!llm) return null;
  const clock = (iso: string, withDay: boolean) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: input.timeZone,
      weekday: withDay ? "short" : undefined,
      month: withDay ? "short" : undefined,
      day: withDay ? "numeric" : undefined,
      hour: withDay ? undefined : "numeric",
      minute: withDay ? undefined : "2-digit",
    }).format(new Date(iso));
  const day = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: input.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(iso));
  const lines = input.events.map((event, index) => {
    const end = new Date(new Date(event.end).getTime() - 60_000).toISOString();
    const when = event.allDay
      ? `${day(event.start)}–${day(end)}, all day`
      : `${day(event.start)}, ${clock(event.start, false)}–${clock(event.end, false)}`;
    return `${index + 1}. ${when} — ${event.title} (${event.calendarTitle}, ${event.sourceTitle})`;
  });
  let out = "";
  try {
    for await (const chunk of llm.generateStream({
      messages: [
        { role: "system", content: HOURS_PICK_INSTRUCTIONS },
        {
          role: "user",
          content: `Today is ${input.todayLabel}. Events for ${input.rangeLabel}:\n${lines.join("\n") || "none"}\n\nRequest: ${input.question}`,
        },
      ],
      modelPreset: "instant",
      correlationId: "agenda-hours",
    })) {
      if (chunk.type === "error") return null;
      if (chunk.type === "token" && chunk.text) out += chunk.text;
    }
  } catch {
    return null;
  }
  const picked = out.trim() ? parseHoursPick(out) : null;
  if (!picked) return null;
  const byNumber = new Map(input.events.map((event, index) => [String(index + 1), event.id]));
  const byId = new Set(input.events.map((event) => event.id));
  const ids = [...new Set(picked.ids.flatMap((token) => {
    const bare = token.replace(/^id=/i, "").replace(/\.$/, "").trim();
    if (byId.has(bare)) return [bare];
    const numbered = byNumber.get(bare);
    return numbered ? [numbered] : [];
  }))];
  return { label: picked.label, ids };
}
