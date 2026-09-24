export type TimeIntent = {
  kind: "time" | "date";
  place?: string;
};

const TALKING_ABOUT_TOOL = /\bget[_\s-]*current[_\s-]*time\b/i;

const TIME_ASK =
  /\b(what(?:'s| is) the time|what time is it|what time do you have|do you have the time|have you got the time|got the time|current time|tell me the time)\b/i;

const DATE_ASK =
  /\b(what(?:'s| is) (?:today'?s |the )?date|what day is it|what(?:'s| is) the day today|what(?:'s| is) today's date)\b/i;

const NOT_THE_CLOCK =
  /\b(what time (?:is|was|are|were) (?:the|my|our|a|that|this)|what time (?:should|do|does|did|will|are|were)|timer|alarm)\b/i;

const HOME =
  /\b(here|locally|at home|my time|local time|right here)\b/i;

/**
 * True when the utterance is asking for the current time or date.
 */
export function looksLikeTimeTask(text: string): boolean {
  return parseTimeIntent(text) != null;
}

/**
 * Deterministic clock ask. "What time is the launch" is not a clock ask.
 */
export function parseTimeIntent(text: string): TimeIntent | null {
  const raw = text.trim();
  if (!raw || TALKING_ABOUT_TOOL.test(raw) || NOT_THE_CLOCK.test(raw)) return null;
  const wantsTime = TIME_ASK.test(raw);
  const wantsDate = DATE_ASK.test(raw);
  if (!wantsTime && !wantsDate) return null;
  const place = extractPlace(raw);
  return {
    kind: wantsTime ? "time" : "date",
    ...(place ? { place } : {}),
  };
}

function extractPlace(text: string): string | undefined {
  if (HOME.test(text) && !/\b(?:in|at)\s+(?!home\b)/i.test(text)) return undefined;
  const named = text.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z\s.'-]{1,32}?)(?:\s*[?.!,]|$)/i);
  if (!named?.[1]) return undefined;
  const place = named[1].trim().replace(/[?.!,]+$/g, "").replace(/\s+/g, " ");
  if (!place || /^(home|here|the moment|all)$/i.test(place)) return undefined;
  return place;
}
