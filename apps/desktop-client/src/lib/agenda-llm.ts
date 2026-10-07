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
